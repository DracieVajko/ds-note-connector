import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildCandidates, md5Hex, probeCandidate, resolveQuickConnect } from '../core/quickconnect.mjs';
import { resolveEndpoint } from '../core/endpoint.mjs';

const SERVER_ID = 'd98a13037fbfebb9f5ce438cf9634050';

const serverInfo = [
  {
    command: 'get_server_info',
    env: { control_host: 'usc.quickconnect.to', relay_region: 'us' },
    errno: 0,
    server: {
      ddns: 'NULL',
      fqdn: 'NULL',
      external: { ip: '88.1.2.3' },
      interface: [{ ip: '192.168.1.10', ipv6: [{ address: 'fe80::1', scope: 'link' }] }],
      serverID: SERVER_ID,
    },
    service: { port: 5001, ext_port: 50551 },
    version: 1,
  },
];

test('candidates are ordered LAN first, then WAN, then relay', () => {
  const candidates = buildCandidates(serverInfo);
  const kinds = candidates.map((candidate) => candidate.kind);
  assert.equal(kinds[0], 'lan-ipv4');
  assert.ok(kinds.indexOf('lan-ipv6') < kinds.indexOf('wan-external'));
  assert.equal(candidates[0].url, 'https://192.168.1.10:5001');
  assert.ok(candidates.some((candidate) => candidate.url === 'https://88.1.2.3:50551'));
});

test('NULL hostnames and missing ports are dropped', () => {
  const candidates = buildCandidates([
    { server: { ddns: 'NULL', fqdn: 'NULL', interface: [] }, service: { port: 5001 } },
  ]);
  assert.deepEqual(candidates, []);
});

test('relay fields become a relay candidate', () => {
  const candidates = buildCandidates([
    {
      server: { serverID: SERVER_ID, interface: [] },
      service: { port: 5001, relay_ip: '203.0.113.20', relay_port: 2905 },
    },
  ]);
  const relay = candidates.find((candidate) => candidate.kind === 'relay');
  assert.ok(relay);
  assert.equal(relay.url, 'https://203.0.113.20:2905');
});

test('a candidate only counts when ezid matches MD5(serverID)', async () => {
  const candidate = { host: '192.168.1.10', port: 5001, https: true, url: 'https://192.168.1.10:5001', kind: 'lan-ipv4' };

  const good = await probeCandidate(candidate, SERVER_ID, {
    request: async () => ({ json: { success: true, ezid: crypto.createHash('md5').update(SERVER_ID).digest('hex') } }),
  });
  assert.equal(good.reachable, true);

  const otherNas = await probeCandidate(candidate, SERVER_ID, {
    request: async () => ({ json: { success: true, ezid: md5Hex('some-other-nas') } }),
  });
  assert.equal(otherNas.reachable, false);
  assert.equal(otherNas.reason, 'ezid-mismatch');

  const dead = await probeCandidate(candidate, SERVER_ID, {
    request: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(dead.reachable, false);
});

test('resolution prefers a reachable direct route over the portal', async () => {
  const resolved = await resolveQuickConnect('mynas', {
    request: async () => ({ json: serverInfo }),
    probe: async (url) =>
      url.includes('192.168.1.10')
        ? { json: { success: true, ezid: md5Hex(SERVER_ID) } }
        : (() => {
            throw new Error('unreachable');
          })(),
  });

  assert.equal(resolved.candidates.length, 1);
  assert.equal(resolved.candidates[0].kind, 'lan-ipv4');
  assert.equal(resolved.portal.url, 'https://mynas.quickconnect.to');
});

test('endpoint resolution falls back to the portal when nothing answers', async () => {
  const endpoint = await resolveEndpoint(
    { mode: 'quickconnect', quickConnectId: 'MyNAS' },
    {
      resolveQuickConnect: async () => ({
        candidates: [],
        portal: { url: 'https://mynas.quickconnect.to' },
        probes: [],
      }),
    },
  );
  assert.equal(endpoint.kind, 'portal');
  assert.equal(endpoint.url, 'https://mynas.quickconnect.to');
  assert.equal(endpoint.loginFlavor, 'portal');
  assert.equal(endpoint.resolution.usedFallback, true);
});

test('a relay route does not skip certificate verification on its own', async () => {
  const endpoint = await resolveEndpoint(
    { mode: 'quickconnect', quickConnectId: 'mynas' },
    {
      resolveQuickConnect: async () => ({
        candidates: [{ kind: 'relay', host: '203.0.113.20', port: 2905, url: 'https://203.0.113.20:2905' }],
        portal: { url: 'https://mynas.quickconnect.to' },
      }),
    },
  );
  assert.equal(endpoint.kind, 'relay');
  assert.equal(endpoint.allowSelfSigned, false, "skipping verification must be the user's choice");
  assert.equal(endpoint.resolution.usedFallback, true);
});

test('a relay route skips verification only when the user asked for it', async () => {
  const endpoint = await resolveEndpoint(
    { mode: 'quickconnect', quickConnectId: 'mynas', allowSelfSigned: true },
    {
      resolveQuickConnect: async () => ({
        candidates: [{ kind: 'relay', host: '203.0.113.20', port: 2905, url: 'https://203.0.113.20:2905' }],
        portal: { url: 'https://mynas.quickconnect.to' },
      }),
    },
  );
  assert.equal(endpoint.allowSelfSigned, true);
});

test('direct mode accepts a hostname with a real certificate', async () => {
  const endpoint = await resolveEndpoint({ mode: 'direct', host: 'nas.example.com', port: 5001, https: true });
  assert.equal(endpoint.url, 'https://nas.example.com:5001');
  assert.equal(endpoint.allowSelfSigned, false);
});

test('a bare IP does not skip certificate verification by default', async () => {
  const endpoint = await resolveEndpoint({ mode: 'direct', host: '192.168.1.10', port: 5001, https: true });
  assert.equal(endpoint.allowSelfSigned, false);
});

test('a bare IP skips verification only when the user asked for it', async () => {
  const endpoint = await resolveEndpoint({
    mode: 'direct',
    host: '192.168.1.10',
    port: 5001,
    https: true,
    allowSelfSigned: true,
  });
  assert.equal(endpoint.allowSelfSigned, true);
});

test('auto mode takes the first listed address that verifies', async () => {
  const tried = [];
  const endpoint = await resolveEndpoint(
    {
      mode: 'auto',
      hosts: ['192.168.1.10', '100.64.0.5', 'nas.example.com'],
      port: 5001,
      https: true,
      certificateName: 'nas.example.com',
    },
    {
      probeEndpoint: async (candidate) => {
        tried.push(candidate.url);
        return candidate.url.includes('100.64.0.5');
      },
      resolveQuickConnect: async () => {
        throw new Error('QuickConnect should not be needed');
      },
    },
  );

  assert.equal(endpoint.kind, 'direct');
  assert.equal(endpoint.url, 'https://100.64.0.5:5001', 'the first address that verifies wins');
  assert.deepEqual(tried.sort(), [
    'https://100.64.0.5:5001',
    'https://192.168.1.10:5001',
    'https://nas.example.com:5001',
  ]);
  assert.equal(endpoint.resolution.mode, 'auto');
  assert.equal(endpoint.resolution.usedFallback, false);
});

test('auto mode falls through to QuickConnect when no listed address answers', async () => {
  const endpoint = await resolveEndpoint(
    { mode: 'auto', hosts: ['192.168.1.10'], port: 5001, https: true, quickConnectId: 'mynas' },
    {
      // The listed address is dead; the QuickConnect route answers.
      probeEndpoint: async (candidate) => candidate.url.includes('203.0.113.20'),
      resolveQuickConnect: async () => ({
        candidates: [
          { kind: 'direct', host: '203.0.113.20', port: 50551, url: 'https://203.0.113.20:50551' },
        ],
        portal: { url: 'https://mynas.quickconnect.to' },
      }),
    },
  );

  assert.equal(endpoint.kind, 'direct');
  assert.equal(endpoint.url, 'https://203.0.113.20:50551');
  assert.equal(endpoint.resolution.usedFallback, true);
});

test('auto mode never picks a route that fails verification', async () => {
  const endpoint = await resolveEndpoint(
    { mode: 'auto', hosts: ['192.168.1.10'], port: 5001, https: true, quickConnectId: 'mynas' },
    {
      // Nothing passes verification: the listed address is dead and the relay
      // route cannot be verified. Auto must not silently fall back to it.
      probeEndpoint: async () => false,
      resolveQuickConnect: async () => ({
        candidates: [{ kind: 'relay', host: '203.0.113.20', port: 2905, url: 'https://203.0.113.20:2905' }],
        portal: { url: 'https://mynas.quickconnect.to' },
      }),
    },
  );
  assert.equal(endpoint.kind, 'portal');
  assert.equal(endpoint.resolution.usedFallback, true);
});

test('a host list is parsed from lines or commas', async () => {
  const { parseHosts } = await import('../core/endpoint.mjs');
  assert.deepEqual(parseHosts('a\nb, c'), ['a', 'b', 'c']);
  assert.deepEqual(parseHosts(['a', '', 'b']), ['a', 'b']);
  assert.deepEqual(parseHosts(null), []);
});
