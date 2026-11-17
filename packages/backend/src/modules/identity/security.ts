import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../errors.js';

const scryptParameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, scryptParameters, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}
export function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 256)
    throw new AppError(400, 'INVALID_PASSWORD', '密码长度应为 12 至 256 个字符。');
}
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length > 256) return false;
  const parts = encoded.split('$');
  if (
    parts.length !== 6 ||
    parts[0] !== 'scrypt' ||
    parts[1] !== '32768' ||
    parts[2] !== '8' ||
    parts[3] !== '1'
  )
    return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length !== 16 || expected.length !== 64) return false;
  return timingSafeEqual(await derive(password, salt), expected);
}
// Missing identities use the same expensive password operation as an incorrect password.
export async function verifyDummyPassword(password: string): Promise<void> {
  await derive(password.slice(0, 256), Buffer.alloc(16));
}
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function csrfForToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${token}`).digest('base64url');
}
export function constantTimeTextEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(hashToken(left), 'hex'), Buffer.from(hashToken(right), 'hex'));
}
export function normalizeLoginName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(normalized))
    throw new AppError(
      400,
      'INVALID_LOGIN_NAME',
      '账号仅支持 3 至 64 位字母、数字、点、短横线和下划线。',
    );
  return normalized;
}
export function normalizeDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 80)
    throw new AppError(400, 'INVALID_DISPLAY_NAME', '显示名称长度应为 1 至 80 个字符。');
  return normalized;
}
