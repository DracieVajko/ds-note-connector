/*
 * DS Note — Cindy plugin brain (sandbox side).
 *
 * This file never talks to the NAS. It resolves the saved configuration,
 * forwards the call to the bundled Node worker, and shapes the answer for
 * whichever surface asked: an Agent tool call or the panel.
 *
 * Why a worker and not cindy.fetch: a Synology NAS normally serves a
 * self-signed certificate, and a QuickConnect relay route is an IP address no
 * certificate covers. The host proxy refuses both. The worker uses node:https
 * and accepts them explicitly, and it also reuses the same core the MCP server
 * and the CLI use, so behaviour cannot drift between harnesses.
 */

const CHANNEL = 'ds-note';
const WORKER_TIMEOUT_MS = 45000;

const channel = new BroadcastChannel(CHANNEL);

/* ------------------------------------------------------------------ kv --- */

async function readConfig() {
  try {
    const response = await fetch('/kv');
    if (!response.ok) return {};
    const value = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Only the fields the worker needs; nothing secret lives here. */
function workerConfig(kv) {
  const mode = ['auto', 'quickconnect', 'portal'].includes(kv.mode) ? kv.mode : 'direct';
  const config = {
    mode,
    account: kv.account || '',
    allowRaw: Boolean(kv.allowRaw),
    // Applies to every mode. A QuickConnect relay route is an IP that no
    // certificate covers, so it needs the same explicit decision as a LAN IP —
    // and forgetting it here is exactly how a relay setup stops connecting.
    allowSelfSigned: kv.allowSelfSigned === true,
    certificateFingerprint: kv.certificateFingerprint || undefined,
    certificate: kv.certificate || undefined,
    certificateName: kv.certificateName || undefined,
    // A DSM account with 2FA needs the code, and a new device needs to be named
    // and confirmed. The MCP server already forwards both; the plugin must too,
    // or those accounts can only ever fail to log in here.
    otpCode: kv.otpCode || undefined,
    deviceId: kv.deviceId || undefined,
    deviceName: kv.deviceName || undefined,
    timeoutMs: Number(kv.timeoutMs) > 0 ? Number(kv.timeoutMs) : undefined,
  };
  if (mode === 'auto') {
    config.hosts = Array.isArray(kv.hosts) ? kv.hosts.filter(Boolean) : [];
    config.port = Number(kv.port) || 5001;
    config.https = kv.https !== false;
    config.quickConnectId = kv.quickConnectId || '';
  } else if (mode === 'direct') {
    config.host = kv.host || '';
    config.port = Number(kv.port) || 5001;
    config.https = kv.https !== false;
  } else {
    config.quickConnectId = kv.quickConnectId || '';
  }
  return config;
}

/* -------------------------------------------------------------- worker --- */

/**
 * One call into the worker.
 * `callId` is passed only for Agent tool calls, so the host can tie the
 * request's lifetime to that call.
 */
async function callWorker(tool, args, callId) {
  const kv = await readConfig();
  const config = workerConfig(kv);
  if (!config.account) {
    return {
      ok: false,
      error: 'DS Note is not configured yet. Open its settings and fill in the NAS address and the DSM account.',
      kind: 'NotConfigured',
    };
  }
  const request = {
    method: 'note/call',
    params: { tool, args, config },
    timeoutMs: WORKER_TIMEOUT_MS,
  };
  if (callId) {
    request.callId = callId;
    request.cancelWithCall = true;
  }
  let response;
  try {
    response = await cindy.node.request(request);
  } catch (error) {
    return { ok: false, error: error?.message || 'the local worker did not answer', kind: 'WorkerError' };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: response.message || 'the local worker refused the request',
      kind: response.errorCode || 'WorkerError',
    };
  }
  const outcome = response.result ?? { ok: false, error: 'the worker returned no result', kind: 'WorkerError' };

  // The certificate fingerprint is for the panel and the settings page, which
  // are the user looking at their own NAS. An agent has no use for it, and a
  // tool result is read by a model, so it is removed on the agent path only.
  if (callId && outcome?.result?.certificate) {
    delete outcome.result.certificate.fingerprint;
  }
  return outcome;
}

/* ---------------------------------------------------------------- tools --- */

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  if (typeof msg.tool !== 'string' || !msg.tool.startsWith('dsnote_')) return;

  /* The raw tool stays in the published manifest (the host cannot change a tool
   * list at runtime), so its switch is enforced here: the moment the user turns
   * it off, the next call is refused instead of being forwarded. */
  if (msg.tool === 'dsnote_raw') {
    const kv = await readConfig();
    if (workerConfig(kv).allowRaw !== true) {
      await cindy.send({
        type: 'tool-result',
        callId: msg.callId,
        ok: false,
        errorCode: 'RAW_DISABLED',
        message:
          'The raw Note Station API tool is turned off in the DS Note settings. ' +
          'Use the dedicated tools, or turn it on in the settings if you really need a raw call.',
      });
      return;
    }
  }

  const outcome = await callWorker(msg.tool, msg.args || {}, msg.callId);

  if (outcome.ok) {
    await cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: outcome.result });
    return;
  }
  await cindy.send({
    type: 'tool-result',
    callId: msg.callId,
    ok: false,
    errorCode: outcome.kind || 'DS_NOTE_ERROR',
    code: outcome.code,
    hint: outcome.hint || '',
    message: outcome.hint ? `${outcome.error} ${outcome.hint}` : outcome.error,
  });
});

/* ---------------------------------------------------------------- panel --- */

/**
 * The panel speaks to this file over a BroadcastChannel: it has no Node access
 * and no business holding one. Requests carry a `reqId` the panel can match.
 *
 * The panel resends a request every few hundred milliseconds until it gets an
 * answer, because a freshly opened panel cannot know whether this file is
 * listening yet. Duplicates are dropped here by `reqId` so a resend can never
 * turn into a second write.
 */
const inFlight = new Set();
const completed = new Map();
const COMPLETED_TTL_MS = 60000;

function rememberCompleted(reqId, payload) {
  completed.set(reqId, payload);
  setTimeout(() => completed.delete(reqId), COMPLETED_TTL_MS).unref?.();
}

channel.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.type !== 'panel-call') return;

  const { reqId, tool, args } = message;
  if (!reqId) return;
  if (inFlight.has(reqId)) return;
  const previous = completed.get(reqId);
  if (previous) {
    channel.postMessage(previous);
    return;
  }

  if (typeof tool !== 'string' || !tool.startsWith('dsnote_')) {
    channel.postMessage({ type: 'panel-result', reqId, ok: false, error: 'unknown tool' });
    return;
  }

  if (tool === 'dsnote_raw') {
    const kv = await readConfig();
    if (workerConfig(kv).allowRaw !== true) {
      channel.postMessage({
        type: 'panel-result',
        reqId,
        ok: false,
        error: 'The raw Note Station API tool is turned off in the settings.',
        kind: 'RAW_DISABLED',
      });
      return;
    }
  }

  inFlight.add(reqId);
  let payload;
  try {
    const outcome = await callWorker(tool, args || {}, null);
    payload = {
      type: 'panel-result',
      reqId,
      ok: outcome.ok,
      result: outcome.ok ? outcome.result : undefined,
      error: outcome.ok ? undefined : outcome.error,
      // brain-rpc.js reads these to rebuild the error the page sees, so the
      // panel gets the same code and hint as an agent call.
      kind: outcome.ok ? undefined : outcome.kind,
      code: outcome.ok ? undefined : outcome.code,
      hint: outcome.ok ? undefined : outcome.hint,
    };
  } finally {
    inFlight.delete(reqId);
  }
  rememberCompleted(reqId, payload);
  channel.postMessage(payload);
};

