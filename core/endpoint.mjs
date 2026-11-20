/**
 * Where the NAS is, and therefore how to log in to it.
 *
 * The connection mode is not a detail — it changes the login handshake, the
 * TLS posture and which paths are safe to call. Keeping it in one place means
 * the rest of the code never branches on it.
 */
import { normalizeQuickConnectId, resolveQuickConnect } from './quickconnect.mjs';
import { NoteStationConfigError } from './errors.mjs';
import { httpRequest } from './http.mjs';
import { transportOptions } from './tls.mjs';

export const CONNECTION_MODES = ['auto', 'direct', 'quickconnect', 'portal'];

/** Accepts an array, or a string with one address per line or comma. */
export function parseHosts(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[\n,]+/);
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

/**
 * Is there a DSM behind this endpoint, with a certificate we accept?
 *
 * `/webman/pingpong.cgi` needs no login and answers `{"success":true}` on a
 * DSM, so it is the cheapest way to tell "this route works" from "this route
 * does not". The TLS options are the real ones — a route that only answers
 * because verification was skipped must not win.
 */
export async function probeEndpoint(endpoint, config = {}, { timeoutMs = 4000, request = httpRequest } = {}) {
  try {
    const response = await request(`${endpoint.url}/webman/pingpong.cgi?action=cors&quickconnect=true`, {
      timeoutMs,
      ...transportOptions(config),
    });
    return response.json?.success === true;
  } catch {
    return false;
  }
}

function normalizeBase(url) {
  return String(url).replace(/\/+$/, '');
}

/**
 * A direct endpoint: LAN address, DDNS name, reverse proxy, VPN address or a
 * QuickConnect relay tunnel. All of these behave identically on the wire.
 */
export function directEndpoint({ host, port = 5001, https = true, basePath = '', allowSelfSigned }) {
  if (!host) throw new NoteStationConfigError('host is required for a direct connection');
  const scheme = https ? 'https' : 'http';
  const portPart = port ? `:${port}` : '';
  return {
    kind: 'direct',
    url: normalizeBase(`${scheme}://${host}${portPart}${basePath}`),
    loginFlavor: 'direct',
    // Certificate verification is on unless the user turned it off. A bare IP
    // is never a reason to skip it silently: skipping means the DSM password
    // is sent to an address whose identity nobody checked.
    allowSelfSigned: allowSelfSigned === true,
  };
}

/**
 * The QuickConnect portal. Always reachable, always a valid certificate, but
 * it is a web portal: login needs a cookie bootstrap and the response may be
 * an HTML page instead of JSON.
 */
export function portalEndpoint(quickConnectId) {
  const id = normalizeQuickConnectId(quickConnectId);
  if (!id) throw new NoteStationConfigError('quickConnectId is required for portal mode');
  return {
    kind: 'portal',
    url: `https://${id}.quickconnect.to`,
    loginFlavor: 'portal',
    allowSelfSigned: false,
  };
}

/**
 * Resolve the configured mode into a concrete endpoint.
 *
 * `quickconnect` tries the NAS's own routes first and only falls back to the
 * portal, because a direct route is several times faster and does not depend
 * on Synology's relay.
 */
export async function resolveEndpoint(config, deps = {}) {
  const mode = config.mode ?? 'direct';
  if (!CONNECTION_MODES.includes(mode)) {
    throw new NoteStationConfigError(
      `unknown connection mode "${mode}" — expected one of ${CONNECTION_MODES.join(', ')}`,
    );
  }

  if (mode === 'direct') {
    return {
      ...directEndpoint(config),
      resolution: { mode, candidates: [], usedFallback: false, tried: [] },
    };
  }

  if (mode === 'auto') {
    // Try the addresses the user listed, in order, then let QuickConnect find
    // the NAS. The first route that answers *and* passes the certificate check
    // wins, so a working LAN or VPN route is used before anything else and the
    // relay is only reached when nothing else works.
    const probe = deps.probeEndpoint ?? probeEndpoint;
    const hosts = parseHosts(config.hosts);
    const candidates = hosts.map((host) =>
      directEndpoint({
        host,
        port: config.port,
        https: config.https,
        allowSelfSigned: config.allowSelfSigned,
      }),
    );

    // Probed together: a LAN address that is not there should not cost the
    // user the timeout of every address in front of a working one. Preference
    // still follows the list order, not who answered first.
    const results = new Array(candidates.length).fill(null);
    const probes = candidates.map((candidate, index) =>
      probe(candidate, config, { timeoutMs: config.probeTimeoutMs ?? 1500 })
        .then((ok) => {
          results[index] = ok === true;
        })
        .catch(() => {
          results[index] = false;
        }),
    );
    // A name that never resolves would otherwise hold up the whole list, so the
    // wait is bounded: whatever has answered by then decides, and the rest is
    // treated as unavailable. Resolution runs once per worker lifetime.
    const deadline = config.autoDeadlineMs ?? 2500;
    await Promise.race([Promise.all(probes), new Promise((resolve) => setTimeout(resolve, deadline))]);

    const tried = candidates.map((candidate, index) => ({ url: candidate.url, ok: results[index] === true }));
    const winner = candidates.find((_, index) => results[index] === true);
    if (winner) {
      return { ...winner, resolution: { mode, candidates: [], usedFallback: false, tried } };
    }

    config.logger?.debug?.('auto: no listed address answered, asking QuickConnect');
    const resolved = await (deps.resolveQuickConnect ?? resolveQuickConnect)(config.quickConnectId, {
      timeoutMs: config.lookupTimeoutMs ?? 8000,
      probeTimeoutMs: config.probeTimeoutMs ?? 4000,
      logger: config.logger,
      ...(deps.quickConnectOptions ?? {}),
    });

    for (const candidate of resolved.candidates) {
      const ok = await probe(
        { url: candidate.url },
        config,
        { timeoutMs: config.probeTimeoutMs ?? 4000 },
      );
      tried.push({ url: candidate.url, ok });
      if (ok) {
        return {
          kind: candidate.kind === 'relay' ? 'relay' : 'direct',
          url: candidate.url,
          loginFlavor: 'direct',
          allowSelfSigned: config.allowSelfSigned === true,
          resolution: { mode, candidates: resolved.candidates, usedFallback: true, tried },
        };
      }
    }

    config.logger?.warn?.('auto: nothing verified, falling back to the QuickConnect portal');
    return {
      ...portalEndpoint(config.quickConnectId),
      resolution: { mode, candidates: [], usedFallback: true, tried },
    };
  }

  if (mode === 'portal') {
    return {
      ...portalEndpoint(config.quickConnectId),
      resolution: { mode, candidates: [], usedFallback: false },
    };
  }

  const resolved = await (deps.resolveQuickConnect ?? resolveQuickConnect)(config.quickConnectId, {
    timeoutMs: config.lookupTimeoutMs ?? 8000,
    probeTimeoutMs: config.probeTimeoutMs ?? 4000,
    logger: config.logger,
    ...(deps.quickConnectOptions ?? {}),
  });

  const first = resolved.candidates[0];
  if (first) {
    const isRelay = first.kind === 'relay';
    return {
      kind: isRelay ? 'relay' : 'direct',
      url: first.url,
      loginFlavor: 'direct',
      // A relay address is an IP no certificate covers, so verification will
      // fail there — but it still has to be the user's explicit choice, not a
      // silent default. The error tells them what to turn on and why.
      allowSelfSigned: config.allowSelfSigned === true,
      resolution: {
        mode,
        candidates: resolved.candidates,
        usedFallback: isRelay,
        probes: resolved.probes,
      },
    };
  }

  config.logger?.warn?.(
    'quickconnect: no direct route answered; using the portal (slower, and the package-local ' +
      '/notestation path is unverified over it)',
  );
  return {
    ...portalEndpoint(config.quickConnectId),
    resolution: { mode, candidates: [], usedFallback: true, tried: resolved.probes ?? [] },
  };
}

/** Where the core DSM APIs live (`SYNO.API.Auth`, `SYNO.API.Info`). */
export function corePath(endpoint) {
  return `${endpoint.url}/webapi/entry.cgi`;
}

export function coreAuthPath(endpoint) {
  return `${endpoint.url}/webapi/auth.cgi`;
}

export function coreQueryPath(endpoint) {
  return `${endpoint.url}/webapi/query.cgi`;
}

/**
 * Where the `SYNO.NoteStation.*` APIs live.
 *
 * They are package-local: the stock client posts them to
 * /notestation/webapi/entry.cgi and the core endpoint answers with an error
 * instead. Verified against captured traffic; still to be confirmed live on a
 * real NAS from this project.
 */
export function noteStationPath(endpoint) {
  return `${endpoint.url}/notestation/webapi/entry.cgi`;
}

export function entryPathFor(api, endpoint) {
  return String(api).startsWith('SYNO.NoteStation.') ? noteStationPath(endpoint) : corePath(endpoint);
}
