// End-to-end encryption between this machine and the phone.
//
// The tunnel goes through Cloudflare, which terminates TLS — so without this, Cloudflare
// could read your prompts, your code and everything Claude said back. With it, they move
// bytes they cannot read.
//
// The key never crosses the tunnel. It is generated here and handed to the phone in the
// pairing QR, which you scan off your own screen, so it goes straight from this machine to
// that phone and nowhere else. That is what makes "nothing readable leaves your machine"
// true again even though the wire belongs to someone else.
//
// AES-256-GCM: encrypts AND authenticates, so a tampered payload is rejected rather than
// silently decrypted into garbage.

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;                      // GCM's nonce size

export const newKey = () => crypto.randomBytes(32).toString('base64url');
const keyBuf = (key) => Buffer.from(String(key), 'base64url');

/** Anything JSON-serialisable → a sealed envelope. */
export function seal(value, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, keyBuf(key), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);

  return {
    v: 1,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),   // proves nobody edited it in transit
  };
}

/**
 * Envelope → the value. Throws if the key is wrong OR the payload was touched: GCM will
 * not hand back plaintext it cannot vouch for, and neither will we.
 */
export function open(envelope, key) {
  if (!envelope || envelope.v !== 1) throw new Error('not a sealed payload');

  const decipher = crypto.createDecipheriv(ALGO, keyBuf(key), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    decipher.final(),                      // throws on a bad key or a tampered payload
  ]);
  return JSON.parse(plain.toString('utf8'));
}

/** Did the client ask for a sealed answer? The app always does; curl and tests may not. */
export const wantsSealed = (req) =>
  req.headers['x-kaip-enc'] === '1' || new URL(req.url, 'http://x').searchParams.get('enc') === '1';
