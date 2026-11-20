import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { CookieJar, httpRequest } from '../core/http.mjs';
import { DsmClient } from '../core/client.mjs';

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const originOf = (server) => `http://127.0.0.1:${server.address().port}`;

test('a cookie jar only answers for its own origin', () => {
  const jar = new CookieJar('https://nas.example:5001');
  jar.absorb('id=abc; Path=/', 'https://nas.example:5001');
  assert.match(jar.header('https://nas.example:5001'), /id=abc/);
  assert.equal(jar.header('https://other.example:5001'), undefined, 'another host gets nothing');
  assert.equal(jar.header('http://nas.example:5001'), undefined, 'a scheme downgrade gets nothing');
  assert.equal(jar.header('https://nas.example:5002'), undefined, 'another port gets nothing');

  jar.absorb('id=hijacked', 'https://other.example:5001');
  assert.match(jar.header('https://nas.example:5001'), /id=abc/, 'a foreign set-cookie is ignored');
});

test('an unscoped jar keeps working for callers that do not bind one', () => {
  const jar = new CookieJar();
  jar.absorb('id=abc');
  assert.match(jar.header('http://anywhere:1'), /id=abc/);
});

test('a redirect to another origin is not followed and carries no cookie', async (t) => {
  let leaked;
  const target = await listen((req, res) => {
    leaked = req.headers.cookie;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"success":true}');
  });
  t.after(() => target.close());

  const source = await listen((req, res) => {
    res.writeHead(302, { Location: `${originOf(target)}/webapi/entry.cgi` });
    res.end();
  });
  t.after(() => source.close());

  const jar = new CookieJar(originOf(source));
  jar.absorb('id=secret');

  const response = await httpRequest(`${originOf(source)}/webapi/entry.cgi`, {
    jar,
    timeoutMs: 3000,
  });

  assert.equal(response.status, 302, 'the redirect is reported, not followed');
  assert.match(response.redirectRefused, /webapi/, 'the refused target is named');
  assert.equal(leaked, undefined, 'the other origin never saw the cookie');
});

test('a redirect to another port on the same host is refused', async (t) => {
  let leaked;
  const target = await listen((req, res) => {
    leaked = req.headers.cookie;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"success":true}');
  });
  t.after(() => target.close());

  const source = await listen((req, res) => {
    res.writeHead(302, { Location: `${originOf(target)}/webapi/entry.cgi` });
    res.end();
  });
  t.after(() => source.close());

  const jar = new CookieJar(originOf(source));
  jar.absorb('id=secret');
  const response = await httpRequest(`${originOf(source)}/webapi/entry.cgi`, { jar, timeoutMs: 3000 });

  assert.equal(response.status, 302);
  assert.equal(leaked, undefined, 'no cookie on the downgraded target');
});

test('a dead route is re-resolved once and the call is retried', async () => {
  const calls = [];
  let endpoint = 'http://127.0.0.1:1';
  const post = async (url, body) => {
    calls.push(url);
    if (url.startsWith('http://127.0.0.1:1/')) {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:1');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    return { status: 200, text: '{"success":true,"data":{"ok":true}}', json: { success: true, data: { ok: true } } };
  };

  let reconnected = 0;
  const client = new DsmClient({
    endpoint: { url: endpoint, kind: 'auto', allowSelfSigned: false },
    credentials: { account: 'a', password: 'p' },
    session: { ensure: async () => {}, login: async () => {}, logout: async () => {}, sid: 'sid', synotoken: null, jar: new CookieJar() },
    post,
    reconnect: async (active) => {
      reconnected += 1;
      // The NAS moved to a reachable address while we were not looking.
      endpoint = 'http://127.0.0.1:2';
      active.endpoint = { url: endpoint, kind: 'auto', allowSelfSigned: false };
    },
  });

  const result = await client.call('SYNO.NoteStation.Note', 'list');
  assert.deepEqual(result, { ok: true });
  assert.equal(reconnected, 1, 'the route was re-resolved once');
  assert.equal(calls.length, 2, 'the call was retried exactly once');
});

test('a certificate failure is not treated as a dead route', async () => {
  let reconnected = 0;
  const client = new DsmClient({
    endpoint: { url: 'https://nas.example', kind: 'direct', allowSelfSigned: false },
    credentials: { account: 'a', password: 'p' },
    session: { ensure: async () => {}, login: async () => {}, logout: async () => {}, sid: 'sid', synotoken: null, jar: new CookieJar() },
    post: async () => {
      const error = new Error('unable to verify the first certificate');
      error.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
      throw error;
    },
    reconnect: async () => {
      reconnected += 1;
    },
  });

  await assert.rejects(() => client.call('SYNO.NoteStation.Note', 'list'), /verify/);
  assert.equal(reconnected, 0, 'a trust failure is reported, not retried elsewhere');
});
