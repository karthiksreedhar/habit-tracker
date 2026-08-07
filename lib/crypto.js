// App-level field encryption (AES-256-GCM).
//
// Why: Atlas must allow 0.0.0.0/0 for Vercel, so the connection string is the
// real security boundary. Sensitive fields are encrypted before they reach
// Mongo — a leaked connection string yields ciphertext, not Google tokens.
//
// Key: DATA_ENCRYPTION_KEY env var, 64 hex chars (32 bytes). The SAME key must
// be set locally and in Vercel (they share the database). Rollout is graceful:
// - no key set -> fields pass through as plaintext (app keeps working)
// - legacy plaintext fields decrypt as-is and get encrypted on next write
// Losing the key means encrypted fields are unrecoverable (users re-auth,
// coach cards/reports regenerate) — keep it safe.

const crypto = require('crypto');

let keyBuf;
function key() {
  if (keyBuf !== undefined) return keyBuf;
  const hex = process.env.DATA_ENCRYPTION_KEY;
  keyBuf = hex && /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
  if (process.env.DATA_ENCRYPTION_KEY && !keyBuf) {
    console.warn('DATA_ENCRYPTION_KEY is set but not 64 hex chars — encryption disabled');
  }
  return keyBuf;
}

// Any JSON-serializable value -> {__enc:1, iv, tag, data}. Null/undefined and
// keyless environments pass through unchanged.
function encryptField(value) {
  const k = key();
  if (!k || value === undefined || value === null) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
  return {
    __enc: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ct.toString('base64'),
  };
}

function decryptField(value) {
  if (!value || typeof value !== 'object' || value.__enc !== 1) return value; // legacy plaintext
  const k = key();
  if (!k) throw new Error('Encrypted data found but DATA_ENCRYPTION_KEY is not set — add it to the environment.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString());
}

module.exports = { encryptField, decryptField };
