import test from 'node:test';
import assert from 'node:assert/strict';
import { httpRequest } from '../core/http.mjs';

/**
 * Certificate pinning is verified against a real TLS server with a
 * self-signed certificate, because the point of the feature is what happens
 * during the handshake — a mock would prove nothing.
 */
test('pinning rejects a certificate whose fingerprint does not match, before the request is sent', async (t) => {
  const { createServer } = await import('node:https');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  let key;
  let cert;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsnote-pin-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
    key = readFileSync(join(dir, 'key.pem'));
    cert = readFileSync(join(dir, 'cert.pem'));
  } catch {
    t.skip('openssl is not available to mint a throwaway certificate');
    return;
  }

  let requests = 0;
  const server = createServer({ key, cert }, (request, response) => {
    requests += 1;
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `https://127.0.0.1:${server.address().port}/`;

  // With no pin, the self-signed certificate is accepted because the caller
  // asked for it — and the real fingerprint is reported back.
  const open = await httpRequest(url, { allowSelfSigned: true, timeoutMs: 5000 });
  assert.equal(open.status, 200);
  assert.equal(open.fingerprint.length, 64, 'SHA-256, without separators');

  // The same fingerprint, written the way a person would copy it.
  const spaced = open.fingerprint.match(/../g).join(':');
  const pinned = await httpRequest(url, {
    allowSelfSigned: true,
    pinnedFingerprint: spaced,
    timeoutMs: 5000,
  });
  assert.equal(pinned.status, 200);

  // A different certificate must be refused, and the request must not be sent.
  const before = requests;
  await assert.rejects(
    () =>
      httpRequest(url, {
        allowSelfSigned: true,
        pinnedFingerprint: 'AA'.repeat(32),
        timeoutMs: 5000,
      }),
    /fingerprint does not match/,
  );
  assert.equal(requests, before, 'nothing reached the server');
});

test('a supplied certificate is verified properly, hostname mismatch and all', async (t) => {
  const { createServer } = await import('node:https');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const mint = (commonName) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsnote-ca-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', `/CN=${commonName}`,
    ], { stdio: 'ignore' });
    return {
      key: readFileSync(join(dir, 'key.pem')),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    };
  };

  let ours;
  try {
    ours = mint('nas.local');
  } catch {
    t.skip('openssl is not available to mint a throwaway certificate');
    return;
  }
  const other = mint('someone-else.local');

  const server = createServer({ key: ours.key, cert: ours.cert }, (request, response) => response.end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `https://127.0.0.1:${server.address().port}/`;

  // The certificate says nas.local; we dial 127.0.0.1. Real verification is
  // still on, and the identity is the certificate we supplied.
  const trusted = await httpRequest(url, { ca: ours.cert, timeoutMs: 5000 });
  assert.equal(trusted.status, 200);

  // A different certificate is not trusted, even though it is also self-signed.
  await assert.rejects(
    () => httpRequest(url, { ca: other.cert, timeoutMs: 5000 }),
    (error) => /certificate|self.signed|unable to verify/i.test(error.message),
  );

  // Without the certificate and without permission, verification is on.
  await assert.rejects(
    () => httpRequest(url, { timeoutMs: 5000 }),
    (error) => /certificate|self.signed|unable to verify/i.test(error.message),
  );
});

test('a certificate is read from a path or taken as PEM', async () => {
  const { resolveCertificate } = await import('../core/index.mjs');
  assert.equal(await resolveCertificate(null), null);
  assert.equal(await resolveCertificate(''), null);
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  assert.equal(await resolveCertificate(pem), pem);
  await assert.rejects(() => resolveCertificate('/definitely/not/here.crt'));
});

test('a pin alone is enough to accept a self-signed certificate', async (t) => {
  const { createServer } = await import('node:https');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  let key;
  let cert;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsnote-pinonly-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
    key = readFileSync(join(dir, 'key.pem'));
    cert = readFileSync(join(dir, 'cert.pem'));
  } catch {
    t.skip('openssl is not available to mint a throwaway certificate');
    return;
  }

  const server = createServer({ key, cert }, (request, response) => response.end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `https://127.0.0.1:${server.address().port}/`;

  const probe = await httpRequest(url, { allowSelfSigned: true, timeoutMs: 5000 });
  // No allowSelfSigned: the pin has to carry it on its own, because otherwise
  // the handshake fails before the fingerprint is ever compared.
  const pinned = await httpRequest(url, {
    pinnedFingerprint: probe.fingerprint,
    timeoutMs: 5000,
  });
  assert.equal(pinned.status, 200);
});

test('a certificate name is verified properly when dialling by IP', async (t) => {
  const { createServer } = await import('node:https');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  let key;
  let cert;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsnote-name-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=nas.example.test',
      '-addext', 'subjectAltName=DNS:nas.example.test',
    ], { stdio: 'ignore' });
    key = readFileSync(join(dir, 'key.pem'));
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  } catch {
    t.skip('openssl is not available to mint a throwaway certificate');
    return;
  }

  const server = createServer({ key, cert }, (request, response) => response.end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `https://127.0.0.1:${server.address().port}/`;

  // Trusting the certificate by name still needs a trusted chain, so this
  // case is about the name check itself: the wrong name must be rejected.
  await assert.rejects(
    () =>
      httpRequest(url, {
        ca: cert,
        serverName: 'somebody-else.example.test',
        timeoutMs: 5000,
      }),
    /altnames|subject alternative|not match/i,
  );

  const right = await httpRequest(url, { ca: cert, serverName: 'nas.example.test', timeoutMs: 5000 });
  assert.equal(right.status, 200);
});
