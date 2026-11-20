import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeNas } from './fake-nas.mjs';
import { createNoteStation } from '../core/index.mjs';

async function login(nas, credentials = {}) {
  return createNoteStation({
    mode: 'direct',
    host: '127.0.0.1',
    port: nas.port,
    https: false,
    account: 'tester',
    password: 'secret',
    timeoutMs: 5000,
    ...credentials,
  });
}

test('wrong password fails at login, not at the first data call', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  await assert.rejects(
    () => login(nas, { password: 'nope' }),
    (error) => {
      assert.equal(error.code, 400);
      assert.match(error.message, /wrong password/i);
      return true;
    },
  );
});

test('two-factor is asked once, then the device token is reused', async (t) => {
  const nas = await startFakeNas();
  t.after(() => nas.close());
  nas.store.requireOtp = true;
  nas.store.otp = '654321';

  await assert.rejects(
    () => login(nas),
    (error) => {
      assert.equal(error.code, 403);
      assert.match(error.message, /two-factor/i);
      return true;
    },
  );

  await assert.rejects(
    () => login(nas, { otpCode: '000000' }),
    (error) => error.code === 404,
  );

  const first = await login(nas, { otpCode: '654321' });
  const deviceId = first.session.deviceId;
  assert.ok(deviceId, 'a device token came back');
  await first.close();

  // No OTP this time: the trusted-device token stands in for it.
  const second = await login(nas, { deviceId });
  const status = await second.status();
  assert.equal(status.session.authenticated, true);
  assert.equal(status.session.deviceToken, true);
  await second.close();
});

test('an HTML answer instead of JSON is reported as a portal problem', async (t) => {
  const http = await import('node:http');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!DOCTYPE html><html><body>portal</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;
  await assert.rejects(
    () =>
      createNoteStation({
        mode: 'direct',
        host: '127.0.0.1',
        port,
        https: false,
        account: 'tester',
        password: 'secret',
        timeoutMs: 5000,
      }),
    (error) => {
      assert.match(error.message, /HTML page instead of JSON/);
      assert.match(error.message, /portal/);
      return true;
    },
  );
});

test('portal flavour bootstraps cookies before posting the login', async (t) => {
  const http = await import('node:http');
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ path: request.url, method: request.method, cookie: request.headers.cookie });
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'relay=1; path=/' });
      response.end('<html></html>');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, data: { sid: 'sid123', synotoken: 'tok123' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { AuthSession } = await import('../core/auth.mjs');
  const session = new AuthSession({
    endpoint: {
      kind: 'portal',
      url: `http://127.0.0.1:${server.address().port}`,
      loginFlavor: 'portal',
      allowSelfSigned: false,
    },
    credentials: { account: 'tester', password: 'secret' },
    timeoutMs: 5000,
  });
  const result = await session.login();

  assert.equal(result.sid, 'sid123');
  assert.equal(result.synotoken, 'tok123');
  assert.equal(seen[0].path, '/', 'bootstrap hits the portal root first');
  assert.equal(seen[1].path, '/webapi/entry.cgi', 'portal login posts to entry.cgi, not auth.cgi');
  assert.match(String(seen[1].cookie), /relay=1/, 'the bootstrap cookie is carried into the login');
});
