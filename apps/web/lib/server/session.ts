/**
 * The judge session (SPEC §8.2): after a judge code checks out, a cookie carries the code's hash
 * and an expiry, signed with HMAC-SHA256 (SESSION_SECRET). The code itself is never stored.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'yieldvest_judge';
/** Judge plans run for seven days; the session lasts as long. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signSession(secret: string, codeHash: string, expiresAtMs: number): string {
  const payload = `${codeHash}.${expiresAtMs}`;
  return `${payload}.${mac(secret, payload)}`;
}

export function verifySession(
  secret: string,
  value: string,
  nowMs: number,
): { codeHash: string; expiresAtMs: number } | undefined {
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const [codeHash = '', expires = '', signature = ''] = parts;
  if (!/^[0-9a-f]{64}$/.test(codeHash) || !/^\d{13}$/.test(expires)) return undefined;
  const expected = Buffer.from(mac(secret, `${codeHash}.${expires}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  const expiresAtMs = Number(expires);
  return expiresAtMs > nowMs ? { codeHash, expiresAtMs } : undefined;
}

export function sessionCookie(value: string, maxAgeMs: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
