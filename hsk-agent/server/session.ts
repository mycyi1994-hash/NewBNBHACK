// Logging in with a wallet: the browser signs a short message (free, no transaction), the server checks the
// signature and hands back a session token that says "this request comes from the owner of 0x…".
// A vault only ever trades on requests carrying its own owner's token.
// Nothing is stored: the nonce and the token are both signed with the server's secret and checked on the way back.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';

const CHALLENGE_MS = 10 * 60_000;
const SESSION_MS = 7 * 24 * 60 * 60_000;
const fallback = randomBytes(32).toString('hex');

/** MOA_SESSION_SECRET, else one derived from the agent key (stable across restarts), else random for this run. */
export function sessionSecret(env: Record<string, string | undefined>): string {
  if (env.MOA_SESSION_SECRET) return env.MOA_SESSION_SECRET;
  if (env.MOA_AGENT_PRIVATE_KEY) return createHmac('sha256', env.MOA_AGENT_PRIVATE_KEY).update('moa-session-v1').digest('hex');
  return fallback;
}

const mac = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex');
const nonceOf = (secret: string, address: Address, host: string, issuedAt: number) => mac(secret, `nonce|${address.toLowerCase()}|${host}|${issuedAt}`).slice(0, 16);

/** The text the wallet shows. It names the site, so a signature made for another site is useless here. */
export function loginMessage(address: Address, host: string, issuedAt: number, nonce: string): string {
  return [
    `${host} wants you to log in to Moa with your wallet:`,
    address,
    '',
    'Signing this is free. It sends no transaction and moves no funds.',
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
  ].join('\n');
}

export function challenge(secret: string, rawAddress: string, host: string, now = Date.now()): { message: string; issuedAt: number } | null {
  if (!isAddress(rawAddress, { strict: false })) return null;
  const address = getAddress(rawAddress);
  return { message: loginMessage(address, host, now, nonceOf(secret, address, host, now)), issuedAt: now };
}

export type Login = { ok: true; token: string; address: Address; expiresAt: number } | { ok: false; reason: string };
export async function login(secret: string, body: { address?: unknown; issuedAt?: unknown; signature?: unknown }, host: string, now = Date.now()): Promise<Login> {
  const issuedAt = Number(body.issuedAt);
  if (typeof body.address !== 'string' || !isAddress(body.address, { strict: false }) || !Number.isFinite(issuedAt)) return { ok: false, reason: 'Invalid login.' };
  if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.signature)) return { ok: false, reason: 'Invalid signature.' };
  if (issuedAt > now + 60_000 || now - issuedAt > CHALLENGE_MS) return { ok: false, reason: 'The login request expired. Try again.' };
  const address = getAddress(body.address);
  const message = loginMessage(address, host, issuedAt, nonceOf(secret, address, host, issuedAt));
  const good = await verifyMessage({ address, message, signature: body.signature as Hex }).catch(() => false);
  if (!good) return { ok: false, reason: 'The signature does not match this wallet.' };
  const expiresAt = now + SESSION_MS;
  return { ok: true, token: issue(secret, address, expiresAt), address, expiresAt };
}

export function issue(secret: string, address: Address, expiresAt: number): string {
  const body = Buffer.from(JSON.stringify({ a: address, e: expiresAt })).toString('base64url');
  return `${body}.${mac(secret, `session|${body}`)}`;
}

/** The wallet a token belongs to, or null when the token is missing, altered or expired. */
export function whoIs(secret: string, token: string | undefined | null, now = Date.now()): Address | null {
  const [body, sig] = (token ?? '').split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(secret, `session|${body}`)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const { a, e } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { a?: string; e?: number };
    if (typeof a !== 'string' || !isAddress(a) || typeof e !== 'number' || e < now) return null;
    return getAddress(a);
  } catch { return null; }
}

/** `Authorization: Bearer <token>` → the wallet, or null. */
export const fromHeader = (secret: string, header: string | undefined, now = Date.now()) => whoIs(secret, /^Bearer (.+)$/.exec(header ?? '')?.[1], now);
