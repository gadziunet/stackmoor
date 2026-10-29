import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Encrypts secrets (DNS API keys, later backup credentials) stored in the database.
// The key lives in a separate file next to the database, readable only by root.
// Note: Caddy itself still needs the plain value, which is written to its .env file (mode 600).

let key = null;

export function initSecrets(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`Invalid secret key in ${file}`);
}

export function encrypt(value) {
  if (!key) throw new Error('secrets not initialised');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, data] = String(blob).split(':');
  if (v !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    return null;
  }
}

/** "abcdef123456" -> "••••••3456" for showing a saved secret without revealing it. */
export function mask(value) {
  const s = String(value || '');
  if (!s) return '';
  return '••••••' + s.slice(-4);
}
