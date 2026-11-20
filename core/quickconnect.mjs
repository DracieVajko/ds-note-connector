/**
 * QuickConnect resolution.
 *
 * QuickConnect is not one endpoint: it is a coordinator that hands back a
 * prioritised list of routes to the NAS, and the client picks the first one
 * that answers. Two of those routes matter for us and they are not
 * interchangeable:
 *
 *   portal   https://<id>.quickconnect.to          Synology's reverse proxy.
 *            Valid certificate, but it is a web portal: the login has to go
 *            through a cookie bootstrap and can answer with an HTML page
 *            instead of JSON, and it is unknown whether it forwards the
 *            package-local path /notestation/webapi/entry.cgi.
 *
 *   relay    https://<relay_ip>:<relay_port>       A raw TCP tunnel to the
 *            DSM port. Any path works, including package-local ones, but the
 *            address is an IP no certificate covers and throughput is shared.
 *
 * Protocol reference: nullvoidptr/qcon `protocol.md`.
 */
import crypto from 'node:crypto';
import { httpRequest, postForm } from './http.mjs';

export const COORDINATOR_HOSTS = [
  'https://global.quickconnect.to/Serv.php',
  'http://global.quickconnect.to/Serv.php',
];

const PORTAL_SERVICE_IDS = ['dsm_portal_https', 'dsm_portal'];
const TUNNEL_SERVICE_IDS = ['dsm_portal_https', 'mainapp_https'];

export function normalizeQuickConnectId(id) {
  return String(id ?? '').trim().toLowerCase();
}

export function md5Hex(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function isPrivateAddress(ip) {
  return (
    /^10\./.test(ip) ||
    /^127\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/**
 * Ask the coordinator what it knows about a QuickConnect ID.
 * This needs no authentication — see docs/AUTH.md for why that is a privacy
 * consideration and not a feature.
 */
export async function getServerInfo(id, { timeoutMs = 10000, request = postForm } = {}) {
  const serverID = normalizeQuickConnectId(id);
  if (!serverID) throw new Error('QuickConnect ID is empty');

  const body = JSON.stringify(
    PORTAL_SERVICE_IDS.map((serviceId) => ({
      version: 1,
      command: 'get_server_info',
      stop_when_error: false,
      stop_when_success: false,
      id: serviceId,
      serverID,
      is_gofile: false,
    })),
  );

  let lastError;
  for (const url of COORDINATOR_HOSTS) {
    try {
      const response = await request(url, body, {
        timeoutMs,
        allowSelfSigned: false,
        headers: { 'Content-Type': 'application/json' },
      });
      const parsed = response.json;
      if (!Array.isArray(parsed)) {
        lastError = new Error(`coordinator returned a non-array response (HTTP ${response.status})`);
        continue;
      }
      return parsed.filter((entry) => entry && entry.server);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('QuickConnect coordinator is unreachable');
}

/**
 * Build candidate routes, most preferred first.
 * LAN before WAN before relay, HTTPS before HTTP — the order QuickConnect
 * itself uses.
 */
export function buildCandidates(serverInfo) {
  const candidates = [];
  const seen = new Set();

  const add = (host, port, https, kind) => {
    if (!host || host === 'NULL' || !port) return;
    const key = `${https ? 'https' : 'http'}://${String(host).toLowerCase()}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ host: String(host), port: Number(port), https, kind, url: key });
  };

  for (const entry of serverInfo ?? []) {
    const service = entry.service ?? {};
    const server = entry.server ?? {};
    const port = service.port;
    const extPort = service.ext_port && Number(service.ext_port) !== Number(port)
      ? service.ext_port
      : undefined;

    const interfaces = Array.isArray(server.interface) ? server.interface : [];
    for (const iface of interfaces) {
      if (iface?.ip) {
        add(iface.ip, port, true, isPrivateAddress(iface.ip) ? 'lan-ipv4' : 'wan-ipv4');
        if (extPort && !isPrivateAddress(iface.ip)) add(iface.ip, extPort, true, 'wan-ipv4');
      }
      for (const v6 of iface?.ipv6 ?? []) {
        if (!v6?.address) continue;
        const kind = v6.scope === 'link' ? 'lan-ipv6' : 'wan-ipv6';
        add(v6.address, port, true, kind);
      }
    }

    if (server.external?.ip) add(server.external.ip, extPort ?? port, true, 'wan-external');
    if (server.fqdn && server.fqdn !== 'NULL') add(server.fqdn, extPort ?? port, true, 'fqdn');
    if (server.ddns && server.ddns !== 'NULL') add(server.ddns, extPort ?? port, true, 'ddns');

    const smartdns = entry.smartdns;
    if (smartdns?.host) add(smartdns.host, extPort ?? port, true, 'smartdns-host');
    for (const host of smartdns?.lan ?? []) {
      if (typeof host !== 'string') continue;
      add(host, port, true, host.startsWith('syn4-') || host.startsWith('syn6-') ? 'smartdns-wan' : 'smartdns-lan');
    }

    if (service.relay_ip && service.relay_port) add(service.relay_ip, service.relay_port, true, 'relay');
    if (service.relay_dualstack && service.relay_port) add(service.relay_dualstack, service.relay_port, true, 'relay');
    if (service.relay_dn && service.relay_port) add(service.relay_dn, service.relay_port, true, 'relay');
    if (service.https_ip && service.https_port) add(service.https_ip, service.https_port, true, 'https-ip');
  }

  const priority = [
    'lan-ipv4', 'lan-ipv6', 'smartdns-lan', 'fqdn', 'ddns',
    'wan-external', 'wan-ipv4', 'wan-ipv6', 'smartdns-host', 'smartdns-wan',
    'https-ip', 'relay',
  ];
  const rank = (kind) => {
    const index = priority.indexOf(kind);
    return index === -1 ? priority.length : index;
  };
  return candidates.sort((a, b) => rank(a.kind) - rank(b.kind));
}

/**
 * A candidate only counts if the device answers ping-pong AND its `ezid`
 * matches MD5(serverID) — otherwise we would happily talk to a different NAS
 * that happens to sit on the same address.
 */
export async function probeCandidate(candidate, serverID, { timeoutMs = 4000, request = httpRequest } = {}) {
  const expected = md5Hex(serverID);
  const url = `${candidate.url}/webman/pingpong.cgi?action=cors&quickconnect=true`;
  try {
    const response = await request(url, { timeoutMs, allowSelfSigned: true });
    const ezid = response.json?.ezid;
    if (response.json?.success === true && ezid && String(ezid).toLowerCase() === expected) {
      return { ...candidate, reachable: true };
    }
    return { ...candidate, reachable: false, reason: ezid ? 'ezid-mismatch' : 'not-a-dsm' };
  } catch (error) {
    return { ...candidate, reachable: false, reason: error.message };
  }
}

/** Ask the coordinator to open a relay tunnel; returns relay candidates. */
export async function requestTunnel(id, { timeoutMs = 10000, request = postForm } = {}) {
  const serverID = normalizeQuickConnectId(id);
  const results = [];
  for (const serviceId of TUNNEL_SERVICE_IDS) {
    const body = JSON.stringify([
      {
        version: 1,
        command: 'request_tunnel',
        stop_when_error: false,
        stop_when_success: true,
        id: serviceId,
        serverID,
        is_gofile: false,
        path: '/',
      },
    ]);
    let lastError;
    for (const url of COORDINATOR_HOSTS) {
      try {
        const response = await request(url, body, {
          timeoutMs,
          allowSelfSigned: false,
          headers: { 'Content-Type': 'application/json' },
        });
        if (Array.isArray(response.json)) results.push(...response.json.filter((e) => e?.service));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
  }
  return results;
}

/**
 * Full resolution: server info, candidate probing, relay fallback.
 *
 * Returns every reachable candidate plus the portal, because the portal is
 * always reachable even when nothing else is.
 */
export async function resolveQuickConnect(id, options = {}) {
  const {
    timeoutMs = 8000,
    probeTimeoutMs = 4000,
    includeRelay = true,
    request = postForm,
    probe = httpRequest,
    logger,
  } = options;

  const serverID = normalizeQuickConnectId(id);
  const serverInfo = await getServerInfo(id, { timeoutMs, request });
  const serverIdValue = serverInfo[0]?.server?.serverID;
  const candidates = buildCandidates(serverInfo);

  const probes = await Promise.all(
    candidates.map((candidate) =>
      probeCandidate(candidate, serverIdValue ?? serverID, { timeoutMs: probeTimeoutMs, request: probe }),
    ),
  );
  const reachable = probes.filter((entry) => entry.reachable);

  const portal = {
    host: `${serverID}.quickconnect.to`,
    port: 443,
    https: true,
    kind: 'portal',
    url: `https://${serverID}.quickconnect.to`,
    reachable: true,
  };

  let relay = [];
  if (reachable.length === 0 && includeRelay) {
    logger?.debug?.('quickconnect: no direct route answered, requesting a relay tunnel');
    try {
      const tunnelInfo = await requestTunnel(id, { timeoutMs, request });
      const tunnelCandidates = buildCandidates(tunnelInfo).filter((c) => c.kind === 'relay');
      relay = await Promise.all(
        tunnelCandidates.map((candidate) =>
          probeCandidate(candidate, serverIdValue ?? serverID, { timeoutMs: probeTimeoutMs, request: probe }),
        ),
      );
      relay = relay.filter((entry) => entry.reachable);
    } catch (error) {
      logger?.warn?.(`quickconnect: relay request failed: ${error.message}`);
    }
  }

  return {
    serverID,
    serverIdValue,
    candidates: [...reachable, ...relay],
    portal,
    relayUsed: reachable.length === 0 && relay.length > 0,
    probes,
  };
}
