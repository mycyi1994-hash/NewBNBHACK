// Two guards in front of what costs money:
//  - order tickets: a trade Moa proposes in the chat runs only when the user presses Confirm on the card, which sends
//    back a ticket the server signed for exactly that wallet, coin, side and amount. A ticket works once and for a
//    few minutes. No words in a message can execute anything any more ("실행하지 마" used to match the old gate).
//  - request limits: how many questions Moa answers per minute and per day, per wallet or per address, and in all,
//    so nobody can spend the server's model credit for it.
// Nothing here is stored on disk: tickets are signed with the server's secret, spent ones are kept in memory until
// they expire (a restart forgets them, and they expire within minutes anyway).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Asset = 'HSK' | 'ETH' | 'BTC';
export interface Order { asset: Asset; side: 'buy' | 'sell'; amount: number; note: string }
export interface Ticket extends Order { token: string; expiresAt: number }

export const TICKET_MS = 5 * 60_000;
const ASSETS: Asset[] = ['HSK', 'ETH', 'BTC'];
const mac = (secret: string, text: string) => createHmac('sha256', secret).update(`order|${text}`).digest('base64url');

/** A sane order, or null: a known coin, buy or sell, a positive finite amount, a short note. */
export function cleanOrder(x: unknown): Order | null {
  const o = x as Partial<Order> | null;
  if (!o || !ASSETS.includes(o.asset as Asset) || (o.side !== 'buy' && o.side !== 'sell')) return null;
  const amount = Number(o.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return null;
  return { asset: o.asset as Asset, side: o.side, amount, note: String(o.note ?? '').slice(0, 120) };
}

/** A ticket for this wallet to confirm this one order. */
export function issueTicket(secret: string, owner: string, order: Order, now = Date.now()): Ticket {
  const expiresAt = now + TICKET_MS;
  const body = Buffer.from(JSON.stringify({ w: owner.toLowerCase(), o: order, e: expiresAt, n: randomBytes(9).toString('base64url') })).toString('base64url');
  return { ...order, token: `${body}.${mac(secret, body)}`, expiresAt };
}

export type Redeem = { ok: true; order: Order } | { ok: false; why: 'invalid' | 'otherWallet' | 'expired' | 'used' };
/** Single use: the first redeem of a good ticket by its own wallet returns the order; any other gets a reason. */
export function ticketBook(secret: string) {
  const spent = new Map<string, number>();
  return {
    redeem(token: unknown, who: string, now = Date.now()): Redeem {
      const [body, sig] = typeof token === 'string' ? token.split('.') : [];
      if (!body || !sig) return { ok: false, why: 'invalid' };
      const want = Buffer.from(mac(secret, body)), got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, why: 'invalid' };
      let t: { w?: string; o?: unknown; e?: number; n?: string };
      try { t = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return { ok: false, why: 'invalid' }; }
      const order = cleanOrder(t.o);
      if (!order || typeof t.e !== 'number' || typeof t.n !== 'string') return { ok: false, why: 'invalid' };
      if (t.w !== who.toLowerCase()) return { ok: false, why: 'otherWallet' };
      if (t.e < now) return { ok: false, why: 'expired' };
      for (const [n, e] of spent) if (e < now) spent.delete(n);
      if (spent.has(t.n)) return { ok: false, why: 'used' };
      spent.set(t.n, t.e);
      return { ok: true, order };
    },
  };
}

/* ---------- request limits ---------- */

export interface Limits { perMinute: number; perDayKnown: number; perDayAnon: number; perDayAll: number }
export const MOA_LIMITS: Limits = { perMinute: 6, perDayKnown: 150, perDayAnon: 30, perDayAll: 3_000 };

/** Counts per key in a sliding minute and a UTC day, and in all per day. */
export function rateLimiter(limits: Limits) {
  const minute = new Map<string, number[]>();
  const day = new Map<string, number>();
  let dayOf = -1, all = 0;
  return {
    /** Take one request for `key` (a wallet when logged in, else an address). Returns why it is refused, or null. */
    take(key: string, known: boolean, now = Date.now()): 'minute' | 'day' | 'all' | null {
      const d = Math.floor(now / 86_400_000);
      if (d !== dayOf) { dayOf = d; day.clear(); all = 0; }
      const recent = (minute.get(key) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= limits.perMinute) { minute.set(key, recent); return 'minute'; }
      if ((day.get(key) ?? 0) >= (known ? limits.perDayKnown : limits.perDayAnon)) return 'day';
      if (all >= limits.perDayAll) return 'all';
      recent.push(now);
      minute.set(key, recent);
      day.set(key, (day.get(key) ?? 0) + 1);
      all++;
      if (minute.size > 10_000) for (const [k, v] of minute) if (!v.some((t) => now - t < 60_000)) minute.delete(k);
      return null;
    },
  };
}

/** The conversation the model may see: at most 20 turns of at most 2,000 characters, user and assistant only. */
export function cleanHistory(x: unknown): { role: 'user' | 'assistant'; content: string }[] | null {
  if (!Array.isArray(x) || !x.length) return null;
  const out = x.slice(-20).map((t) => t as { role?: unknown; content?: unknown });
  if (out.some((t) => (t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string')) return null;
  while (out.length && out[0].role !== 'user') out.shift();   // the model's conversation starts with the user
  return out.length ? out.map((t) => ({ role: t.role as 'user' | 'assistant', content: (t.content as string).slice(0, 2_000) })) : null;
}
