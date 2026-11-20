import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeJsonValue, encodeJsonBody, encodeJsonValue, encodePlainBody } from '../core/encoding.mjs';

test('strings are JSON-quoted for requestFormat:JSON APIs', () => {
  assert.equal(encodeJsonValue('New note'), '"New note"');
  assert.equal(
    encodeJsonBody({ object_id: '1001_QF64' }),
    'object_id=%221001_QF64%22',
  );
});

test('numbers and booleans stay bare', () => {
  assert.equal(encodeJsonValue(120), '120');
  assert.equal(encodeJsonValue(true), 'true');
  assert.equal(encodeJsonBody({ duration: 120, check_conflict: true }), 'duration=120&check_conflict=true');
});

test('arrays and objects are encoded as JSON, once', () => {
  assert.equal(encodeJsonValue(['A', 'B']), '["A","B"]');
  assert.equal(encodeJsonValue({ recycle: false }), '{"recycle":false}');
  assert.equal(
    encodeJsonBody({ tag: ['A', 'B'] }),
    'tag=%5B%22A%22%2C%22B%22%5D',
  );
});

test('null and undefined are omitted, not sent as the string null', () => {
  const body = encodeJsonBody({ object_id: 'x', missing: null, absent: undefined });
  assert.equal(body, 'object_id=%22x%22');
});

test('spaces are percent-encoded, never rendered as +', () => {
  assert.equal(encodeJsonBody({ title: 'a b' }), 'title=%22a%20b%22');
});

test('core APIs keep bare form values', () => {
  assert.equal(
    encodePlainBody({ api: 'SYNO.API.Auth', account: 'tester', passwd: 'secret' }),
    'api=SYNO.API.Auth&account=tester&passwd=secret',
  );
});

test('non-finite numbers are refused instead of silently becoming null', () => {
  assert.throws(() => encodeJsonValue(Number.NaN), TypeError);
});

test('decoding tolerates both JSON literals and bare text', () => {
  assert.equal(decodeJsonValue('"1026_ABC"'), '1026_ABC');
  assert.equal(decodeJsonValue('true'), true);
  assert.equal(decodeJsonValue('1026_ABC'), '1026_ABC');
  assert.equal(decodeJsonValue(''), '');
});
