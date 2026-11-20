/*
 * DS Note — bundled Node worker.
 *
 * This is the only place in the plugin that touches the network directly. It
 * has to be Node, not the sandbox, for two reasons a sandboxed plugin cannot
 * solve: a Synology NAS almost always serves a self-signed certificate, and a
 * QuickConnect relay route is an IP address no certificate covers. Cindy's
 * host proxy rejects both, while `node:https` here can accept them explicitly.
 *
 * Protocol: one JSON-RPC 2.0 object per line on stdin, replies on stdout.
 * stdout carries protocol only; anything diagnostic goes to stderr.
 *
 * The DSM password is never stored here. The host injects it per request as
 * `request.cindy.secrets.dsm_password`, which only happens for the methods
 * declared in ghost.json → node.secretBindings.
 */
const readline = require('node:readline');

let corePromise = null;
let catalogPromise = null;
let catalogKey = null;
let apiPromise = null;
let apiKey = '';
let currentConfig = null;
let redactor = null;
let redactorKey = '';

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, code, message, data) {
  reply({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

/**
 * Identity of a connection, so a settings change drops the cached session.
 * Tool switches are deliberately NOT part of it: revoking the raw tool must not
 * log the user out, it must only rebuild the catalog.
 */
function keyFor(config) {
  return JSON.stringify([
    config.mode ?? 'direct',
    config.host ?? '',
    config.port ?? '',
    config.https ?? '',
    config.quickConnectId ?? '',
    config.account ?? '',
    // A certificate decision that changes without the session being dropped
    // would keep talking over the old trust settings.
    config.certificateName ?? '',
    config.certificate ?? '',
    config.certificateFingerprint ?? '',
    config.allowSelfSigned === true,
  ]);
}

/** Identity of the tool surface: the connection plus the tool switch it reads. */
function catalogKeyFor(config) {
  return JSON.stringify([keyFor(config), Boolean(config.allowRaw)]);
}

async function core() {
  if (!corePromise) corePromise = import('./core/index.mjs');
  return corePromise;
}

/**
 * Everything leaving the worker passes through here.
 *
 * The DSM password and the QuickConnect ID are scrubbed from every string; the
 * account and host are scrubbed from error text, where addresses actually
 * leak. Note bodies are left alone — the user's own words are not ours to
 * rewrite.
 */
/**
 * One place builds the redactor. The key includes the password, so changing it
 * takes effect immediately instead of leaving the old password in the set while
 * the new one leaks into error text.
 */
async function ensureRedactor(config) {
  const nextKey = JSON.stringify([config.password ?? '', config.quickConnectId ?? '', config.host ?? '', config.account ?? '']);
  if (!redactor || redactorKey !== nextKey) {
    const { redactorForConfig } = await import('./core/redact.mjs');
    redactor = redactorForConfig(config);
    redactorKey = nextKey;
  }
  return redactor;
}

async function redactOutcome(outcome) {
  const active = await ensureRedactor(currentConfig ?? {});
  return active.redactValue(outcome);
}

async function getApi() {
  if (apiPromise) return apiPromise;
  const { createNoteStation } = await core();
  const config = currentConfig;
  if (!config) throw new Error('the plugin is not configured yet — open the DS Note settings and fill in the NAS address and account');
  if (!config.password) {
    throw new Error('no DSM password is stored yet — open the DS Note settings and save it');
  }
  apiKey = keyFor(config);
  apiPromise = createNoteStation({
    ...config,
    logger: { debug: () => {}, warn: (message) => process.stderr.write(`[ds-note] ${message}\n`) },
  }).catch(async (error) => {
    apiPromise = null;
    // A connection failure is almost always a configuration question, and the
    // user cannot see what the worker was handed. Say it, without secrets.
    const { certificateMode } = await import('./core/tls.mjs');
    const tls = certificateMode(config);
    const summary =
      `[config: mode=${config.mode} tls=${tls} ` +
      `certFile=${config.certificate ? 'yes' : 'no'} ` +
      `fingerprint=${config.certificateFingerprint ? 'yes' : 'no'}]`;
    const wrapped = new Error(`${error.message} ${summary}`);
    // main.js turns error.name into the errorCode the user sees, so the kind
    // must survive the re-wrap.
    wrapped.name = error.name || 'Error';
    wrapped.code = error.code;
    wrapped.kind = error.kind;
    throw wrapped;
  });
  return apiPromise;
}

async function catalog() {
  if (catalogPromise) return catalogPromise;
  const { createToolCatalog } = await import('./core/tools.mjs');
  catalogPromise = Promise.resolve(
    createToolCatalog({
      getApi,
      // Only the switch the catalog reads; the connection config (with the
      // password) never leaves this module.
      allowRaw: currentConfig?.allowRaw === true,
    }),
  );
  return catalogPromise;
}

async function dropSession() {
  if (!apiPromise) return;
  const pending = apiPromise;
  apiPromise = null;
  apiKey = '';
  const api = await pending.catch(() => null);
  await api?.close().catch(() => {});
}

async function handle(request) {
  const { id, method, params } = request;

  if (method === 'note/call') {
    const config = { ...(params?.config ?? {}) };
    const password = request.cindy?.secrets?.dsm_password;
    if (password) config.password = password;
    config.allowRaw = Boolean(config.allowRaw);
    config.allowPurge = Boolean(config.allowPurge);

    currentConfig = config;
    const nextKey = keyFor(config);
    if (apiPromise && nextKey !== apiKey) await dropSession();
    // Turning the raw tool off (or on) must take effect on the very next call,
    // without touching the session that is already logged in.
    const nextCatalogKey = catalogKeyFor(config);
    if (catalogKey !== nextCatalogKey) {
      catalogPromise = null;
      catalogKey = nextCatalogKey;
    }
    await ensureRedactor(config);

    if (!config.password) {
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          ok: false,
          error:
            'No DSM password is stored. Open the DS Note settings, enter the password of the DSM user that has Note Station access, and save it.',
          kind: 'NotConfigured',
        },
      });
      return;
    }

    const tools = await catalog();
    const outcome = await tools.invoke(params?.tool, params?.args ?? {});
    reply({ jsonrpc: '2.0', id, result: await redactOutcome(outcome) });
    return;
  }

  if (method === 'note/reset') {
    await dropSession();
    reply({ jsonrpc: '2.0', id, result: { ok: true } });
    return;
  }

  if (method === 'note/ping') {
    reply({ jsonrpc: '2.0', id, result: { ok: true, worker: 'ds-note', connected: Boolean(apiPromise) } });
    return;
  }

  fail(id, -32601, `method not found: ${method}`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${error.message}` } });
    return;
  }
  handle(request).catch((error) => {
    // A thrown error here is our bug, not the NAS talking. Say so plainly and
    // keep the worker alive so the next call can still work.
    process.stderr.write(`[ds-note] ${error?.stack ?? error}\n`);
    reply({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        ok: false,
        error: redactor ? redactor.redactString(error.message, { errors: true }) : error.message,
        kind: error.name,
        code: error.code,
      },
    });
  });
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`[ds-note] uncaught: ${error?.stack ?? error}\n`);
});

process.on('unhandledRejection', (error) => {
  process.stderr.write(`[ds-note] unhandled rejection: ${error?.stack ?? error}\n`);
});
