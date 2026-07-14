// End-to-end encryption: what makes the Cloudflare tunnel safe.
//
// The tunnel goes through Cloudflare, which terminates TLS and COULD read its contents: your
// prompts, code, and everything Claude returns. With this, it moves bytes it cannot open. The
// key originates on the PC and reaches the phone through the QR code, scanned from your own
// screen, so it never travels over the connection it protects.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKey, open, seal, wantsSealed } from '../lib/crypto.mjs';

test('round trip: what goes out is exactly what came in', () => {
  const key = newKey();
  const data = { jobs: [{ id: 'j1', prompt: 'none of Cloudflare\'s business' }], n: 42, ok: true };
  assert.deepEqual(open(seal(data, key), key), data);
});

test('the envelope does NOT contain plaintext (the only thing that really matters here)', () => {
  const key = newKey();
  const envelope = seal({ secret: 'the bank key is 1234' }, key);
  const raw = JSON.stringify(envelope);

  assert.ok(!raw.includes('1234'), 'the content must not appear');
  assert.ok(!raw.includes('bank'), 'not even a word from the original');
  assert.ok(!raw.includes('secret'), 'not even field names');
});

test('it does NOT decrypt with the wrong key (it fails rather than returning garbage)', () => {
  const envelope = seal({ a: 1 }, newKey());
  assert.throws(() => open(envelope, newKey()));
});

test('an envelope tampered with in transit is rejected', () => {
  // AES-GCM authenticates as well as encrypts: a modified payload fails rather than silently
  // decrypting to something else. If Cloudflare changed one byte, we would know.
  const key = newKey();
  const sobre = seal({ jobs: ['bueno'] }, key);

  const tocado = { ...sobre, ct: Buffer.from(sobre.ct, 'base64') };
  tocado.ct[0] ^= 0xff;                                  // un bit distinto
  tocado.ct = tocado.ct.toString('base64');

  assert.throws(() => open(tocado, key), /auth|tag|decrypt/i);
});

test('tampering with the authentication tag does not work either', () => {
  const key = newKey();
  const sobre = seal({ a: 1 }, key);
  assert.throws(() => open({ ...sobre, tag: Buffer.alloc(16).toString('base64') }, key));
});

test('each envelope differs even when content is identical (a new nonce every time)', () => {
  // Otherwise, an observer could see that two responses are identical without opening them.
  const key = newKey();
  const a = seal({ mismo: 'dato' }, key);
  const b = seal({ mismo: 'dato' }, key);
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.iv, b.iv);
});

test('something that is not an envelope does not crash the server', () => {
  assert.throws(() => open(null, newKey()), /not a sealed payload/);
  assert.throws(() => open({ hello: 1 }, newKey()), /not a sealed payload/);
});

test('keys differ every time', () => {
  const keys = new Set(Array.from({ length: 100 }, () => newKey()));
  assert.equal(keys.size, 100);
});

test('wantsSealed: the app requests an envelope through a header or query', () => {
  const req = (headers, url = '/api/state') => ({ headers, url });
  assert.equal(wantsSealed(req({ 'x-kaip-enc': '1' })), true);
  assert.equal(wantsSealed(req({}, '/api/state?enc=1')), true);
  assert.equal(wantsSealed(req({})), false, 'curl and tests still receive plain JSON');
});
