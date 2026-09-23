import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, statSync } from 'node:fs';

const scrypt = promisify(scryptCallback);
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function hashPassword(password) {
  const salt = token(16);
  const hash = await scrypt(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = await scrypt(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
  return equal(actual.toString('hex'), hash);
}
export function hashKey(key, salt = token(16)) {
  return { salt, hash: digest(`${salt}\0${key}`) };
}
export const verifyKey = (key, record) => equal(hashKey(key, record.salt).hash, record.hash);
export function encrypt(value, masterKey, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
}
export function decrypt(value, masterKey, context) {
  const [iv, tag, encrypted] = value.split('.').map(b => Buffer.from(b, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}
export function readSecret(path) {
  const stat = statSync(path);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Secret file must have mode 0600');
  return readFileSync(path, 'utf8').trim();
}
export const mask = value => `${value.slice(0, Math.min(10, value.length - 4))}…`;
export function safeText(value) {
  return String(value).replace(/(?:user_|sk-)[A-Za-z0-9_.-]+/g, '[redacted]');
}
