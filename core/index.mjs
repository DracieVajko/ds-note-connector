/**
 * Public entry point.
 *
 * Everything above this file is a detail of the DSM API; everything below it
 * (Cindy plugin, MCP server, CLI) only sees this shape.
 */
import { readFile } from 'node:fs/promises';
import { DsmClient } from './client.mjs';
import { resolveEndpoint } from './endpoint.mjs';
import { createNotesApi, normalizeNote } from './notes.mjs';
import { createNotebooksApi, createSearchApi, createTagsApi, createTodosApi, createVersionsApi } from './resources.mjs';
import { AuthSession } from './auth.mjs';
import { certificateMode, transportOptions } from './tls.mjs';

import { NoteStationConfigError } from './errors.mjs';

export * from './errors.mjs';
export { PINNED_VERSIONS, versionFor } from './client.mjs';
export { CERTIFICATE_MODES, certificateMode, transportOptions } from './tls.mjs';
export { CONNECTION_MODES, directEndpoint, portalEndpoint, resolveEndpoint } from './endpoint.mjs';
export { markdownToNoteHtml, noteHtmlToMarkdown, deriveBrief, checkRoundTrip } from './html.mjs';
export { normalizeNote } from './notes.mjs';
export { NoteConflictError } from './notes.mjs';

/**
 * Resolve `config.certificate` into a PEM string.
 *
 * The value is either the certificate itself (anything starting with
 * `-----BEGIN`) or a path to an exported file. A path is the friendlier of the
 * two: DSM exports a certificate as a file, and nobody wants to paste 2 KB of
 * base64 into a settings box.
 */
export async function resolveCertificate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (text.includes('-----BEGIN CERTIFICATE-----')) return text;
  const pem = await readFile(text, 'utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new NoteStationConfigError(`${text} does not contain a PEM certificate`);
  }
  return pem;
}

/**
 * Connect and return the API surface.
 *
 * config:
 *   mode             'auto' | 'direct' | 'quickconnect' | 'portal'
 *   hosts[]          addresses to try, for auto
 *   host/port/https  for direct
 *   quickConnectId   for auto, quickconnect and portal
 *   certificateName  verify by this name (SNI) instead of the address
 *   certificate      PEM text or a path to an exported certificate
 *   certificateFingerprint  pin one certificate by SHA-256
 *   account, password, otpCode?, deviceId?  — credentials
 *   allowSelfSigned?, allowRaw?, allowPurge?, timeoutMs?, logger?
 */
export async function createNoteStation(config = {}) {
  if (!config.account) throw new NoteStationConfigError('account is required');
  if (config.password === undefined) throw new NoteStationConfigError('password is required');

  // The certificate is resolved first so the route probe can verify with it:
  // a route that only answers because verification was skipped must not win.
  const ca = await resolveCertificate(config.certificate);
  const resolved = { ...config, ca };
  const endpoint = await resolveEndpoint(resolved);
  const tls = transportOptions(resolved);

  const credentials = {
    account: config.account,
    password: config.password,
    otpCode: config.otpCode,
    deviceId: config.deviceId,
    deviceName: config.deviceName,
  };

  const state = {
    endpoint,
    session: new AuthSession({
      endpoint,
      credentials,
      tls,
      timeoutMs: config.timeoutMs,
      logger: config.logger,
    }),
  };

  /**
   * Resolve the route again and start a fresh session.
   *
   * In auto mode the NAS may have moved (DHCP, a different VPN address, a relay
   * that stopped working). Retrying the old address would keep failing, and
   * reusing the old session cookie would talk to the wrong host, so the client
   * asks for this instead of retrying blindly.
   */
  async function reconnect(activeClient, cause) {
    const next = await resolveEndpoint({ ...resolved }).catch((error) => {
      // The failure that started the recovery is the interesting one; keep it.
      error.cause = cause ?? error.cause;
      throw error;
    });
    const nextTls = transportOptions({ ...resolved, allowSelfSigned: next.allowSelfSigned ?? tls.allowSelfSigned });
    const previous = state.session;
    state.endpoint = next;
    state.session = new AuthSession({
      endpoint: next,
      credentials,
      tls: nextTls,
      timeoutMs: config.timeoutMs,
      logger: config.logger,
    });
    activeClient.endpoint = next;
    activeClient.session = state.session;
    activeClient.tls = nextTls;
    activeClient.forgetNotePath();
    previous?.logout?.().catch(() => {});
    await activeClient.connect();
    config.logger?.debug?.(`reconnected on a fresh ${next.kind} route`);
  }

  const client = new DsmClient({
    endpoint,
    credentials,
    tls,
    timeoutMs: config.timeoutMs,
    logger: config.logger,
    session: state.session,
    reconnect,
  });

  await client.connect();

  const notes = createNotesApi(client, { allowPurge: config.allowPurge === true });
  const notebooks = createNotebooksApi(client);
  const tags = createTagsApi(client);
  const todos = createTodosApi(client);
  const search = createSearchApi(client);
  const versions = createVersionsApi(client);

  async function status() {
    const mode = certificateMode(resolved);
    const info = await client.dsmInfo();
    // A listing that fails must not look like an account with nothing in it.
    const failures = [];
    const [notebookList, todoList] = await Promise.all([
      notebooks.list().catch((error) => {
        failures.push(`notebooks: ${error.message}`);
        return [];
      }),
      todos.list().catch((error) => {
        failures.push(`todos: ${error.message}`);
        return { todos: [], total: 0 };
      }),
    ]);
    const noteTotal = notebookList.reduce((sum, notebook) => sum + notebook.noteCount, 0);
    let apiCount = 0;
    try {
      apiCount = Object.keys(await client.discover()).length;
    } catch (error) {
      config.logger?.debug?.(`status: API discovery failed (${error.message})`);
    }
    // Deliberately no address, no account, no serial. A status read by a model
    // must describe the connection, not the user's infrastructure.
    return {
      connection: {
        route: state.endpoint.kind,
        fallback: Boolean(state.endpoint.resolution?.usedFallback),
        attempts: (state.endpoint.resolution?.tried ?? state.endpoint.resolution?.probes ?? []).length,
      },
      dsm: info ? { model: info.model, version: info.version_string ?? info.version } : null,
      session: {
        authenticated: state.session.isAuthenticated,
        csrfToken: Boolean(state.session.synotoken),
        deviceToken: Boolean(state.session.deviceId),
      },
      certificate: {
        mode: mode,
        // What is actually checked, so a user never has to infer it:
        // chain = the certificate is validated; hostname = the address is
        // matched against it; fingerprint = trust on first use, compared.
        // A fingerprint-only or accept-anything setup does not validate the
        // chain; only a real verification or a supplied certificate does.
        chainChecked: Boolean(ca) || mode === 'verified' || mode === 'verified-by-name',
        hostnameChecked: mode === 'verified' || mode === 'verified-by-name',
        fingerprintChecked: Boolean(config.certificateFingerprint),
        verifiedAgainstFile: Boolean(ca),
        pinned: Boolean(config.certificateFingerprint),
        fingerprint: client.peerFingerprint ?? null,
        scope:
          mode === 'certificate-file'
            ? 'chain validated against your exported file; hostname not checked (the file is the identity)'
            : undefined,
      },
      counts: { notebooks: notebookList.length, notes: noteTotal, todos: todoList.total },
      degraded: failures.length > 0 ? failures : undefined,
      noteStationApis: apiCount,
      apiPath: client.noteStationPath,
    };
  }

  return {
    get endpoint() {
      return state.endpoint;
    },
    client,
    get session() {
      return state.session;
    },
    notes,
    notebooks,
    tags,
    todos,
    search,
    versions,
    status,
    close: () => client.logout(),
  };
}
