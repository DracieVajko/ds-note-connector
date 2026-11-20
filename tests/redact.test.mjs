import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, redactorForConfig } from '../core/redact.mjs';
import { sanitizeNetworkMessage } from '../core/http.mjs';

test('the password is scrubbed from every string', () => {
  const redactor = createRedactor({ always: ['hunter2secret'] });
  assert.equal(redactor.redactString('login failed for hunter2secret'), 'login failed for «redacted»');
});

test('a QuickConnect ID is scrubbed everywhere, case-insensitively', () => {
  const redactor = createRedactor({ always: ['mynas'] });
  assert.equal(redactor.redactString('connecting to MyNAS now'), 'connecting to «redacted» now');
  assert.ok(!redactor.redactString('https://MyNAS.quickconnect.to').toLowerCase().includes('mynas'));
});

test('the account and host are scrubbed from error text', () => {
  const redactor = redactorForConfig({ account: 'dsnotes', host: 'nas.example.com', password: 'pw' });
  assert.equal(
    redactor.redactString('auth failed for dsnotes at nas.example.com', { errors: true }),
    'auth failed for «redacted» at «redacted»',
  );
});

test('a note that mentions an IP or a URL keeps the user\'s own words', () => {
  const redactor = redactorForConfig({ account: 'home', host: '192.168.1.10' });
  const note = {
    title: 'Home network',
    markdown: 'The router is at 192.168.1.10 and the console is https://nas.example.com/admin.',
  };
  assert.deepEqual(redactor.redactValue(note), note);
});

test('the account is NOT scrubbed from note text, so user data is not mangled', () => {
  const redactor = redactorForConfig({ account: 'home' });
  const note = { title: 'Home', markdown: 'Things around the home: a home router.' };
  assert.deepEqual(redactor.redactValue(note), note);
});

test('error fields get the broader treatment, other fields keep their text', () => {
  const redactor = redactorForConfig({ account: 'dsnotes', host: '10.1.2.3' });
  const outcome = {
    ok: false,
    error: 'request to 10.1.2.3 timed out for dsnotes',
    kind: 'NetworkError',
  };
  assert.deepEqual(redactor.redactValue(outcome), {
    ok: false,
    error: 'request to «redacted» timed out for «redacted»',
    kind: 'NetworkError',
  });
});

test('an address that appears only in an error is still redacted', () => {
  const redactor = createRedactor({});
  assert.equal(
    redactor.redactString('GET https://203.0.113.10:23255/webapi/auth.cgi', { errors: true }),
    'GET https://«host»',
  );
  assert.equal(
    redactor.redactString('connect ECONNREFUSED 203.0.113.10:23255', { errors: true }),
    'connect ECONNREFUSED «ip»:23255',
  );
});

test('network error messages lose the address but keep the failure', () => {
  assert.match(
    sanitizeNetworkMessage('getaddrinfo ENOTFOUND nas.example.com'),
    /ENOTFOUND/,
  );
  assert.ok(!sanitizeNetworkMessage('getaddrinfo ENOTFOUND nas.example.com').includes('nas.example.com'));

  const tls = sanitizeNetworkMessage('Hostname/IP does not match certificate altnames: 203.0.113.10');
  assert.ok(!tls.includes('203.0.113.10'));
  assert.match(tls, /does not match/);
});

test('redaction survives nested objects and arrays', () => {
  const redactor = createRedactor({ always: ['secretpw'] });
  const value = { a: [{ b: 'x secretpw y' }], c: { d: 'secretpw' } };
  assert.deepEqual(redactor.redactValue(value), {
    a: [{ b: 'x «redacted» y' }],
    c: { d: '«redacted»' },
  });
});

test('a note body is never rewritten, even if it contains a credential', () => {
  const redactor = redactorForConfig({ password: 'hunter2secret', account: 'dsnotes', host: '10.0.0.5' });
  const note = {
    id: '1026_X',
    title: 'Passwords',
    markdown: 'mail login: hunter2secret',
    brief: 'mail login: hunter2secret',
  };
  assert.deepEqual(redactor.redactValue(note), note);
});

test('a fingerprint is compared regardless of separators or case', async () => {
  const { normalizeFingerprint } = await import('../core/http.mjs');
  const a = 'AB:CD:EF:01:23:45';
  assert.equal(normalizeFingerprint(a), 'ABCDEF012345');
  assert.equal(normalizeFingerprint('abcdef012345'), 'ABCDEF012345');
  assert.equal(normalizeFingerprint('ab:cd:ef:01:23:45'), 'ABCDEF012345');
  assert.equal(normalizeFingerprint(null), '');
});
