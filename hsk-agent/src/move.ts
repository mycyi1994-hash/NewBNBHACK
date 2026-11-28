// Moving to a new vault. Vaults cannot be upgraded, so a wallet whose vault an earlier factory made gets a new one
// and carries its money over itself: Moa makes the new vault (no signature, no fee), the owner takes everything out
// of the old one, and puts the USDT into the new one. Where a wallet stands is read from the chain every time (the
// server's /api/vault: the old vault's balances, the new vault's, the wallet's), never from a flag kept here, so
// closing the tab in the middle loses nothing: the same step is waiting on return. (The card remembers one thing in
// the browser, only to stop offering step 3 once it was done or put off: see MoveVault.tsx.)
// Only USDT goes into the new vault. A coin sent into a vault by plain transfer has no cost on the vault's books:
// the stop-loss never covers it, and it weakens the stop-loss of whatever the agent buys of that coin afterwards
// (checked on a fork: contracts/scripts/upgrade-fork-test.mjs). Coins are sold to USDT first, or stay in the wallet.
import { authHeaders } from './account.ts';
import type { OldVault, VaultInfo } from './parts.tsx';

/**
 * make: a newer vault can be made for this wallet. takeOut: the new vault exists and is empty, the old one still
 * holds something. putIn: the old one is empty, the new one is empty, the wallet holds USDT. left: the move is done
 * (the new vault holds money) and the old one still holds something. null: nothing to do.
 */
export type MoveStage = 'make' | 'takeOut' | 'putIn' | 'left' | null;

const positive = (s?: string) => Number(s ?? 0) > 0;
const empty = (v: VaultInfo) => !positive(v.usdtBalance) && !v.holdings?.length;

export function moveStage(v: VaultInfo | null | undefined): MoveStage {
  if (!v?.configured) return null;
  if (v.upgrade?.available) return 'make';
  if (v.old) return empty(v) ? 'takeOut' : 'left';
  return v.moved && empty(v) && positive(v.walletUsdt) ? 'putIn' : null;
}

/** 1, 2 or 3: the step that is waiting. Steps before it are done. */
export const stepOf = (stage: MoveStage): 1 | 2 | 3 | null => (stage === 'make' ? 1 : stage === 'takeOut' ? 2 : stage === 'putIn' ? 3 : null);

export interface TakeOut { symbol: string; address: string; decimals: number; amount: string }
/** Everything an old vault holds, one withdrawal each (one wallet confirmation each), USDT first, in exact amounts. */
export function takeOutList(old: Pick<OldVault, 'usdtBalance' | 'holdings'>, usdt: string): TakeOut[] {
  return [
    ...(positive(old.usdtBalance) ? [{ symbol: 'USDT', address: usdt, decimals: 6, amount: old.usdtBalance }] : []),
    ...old.holdings.filter((h) => positive(h.amount)).map((h) => ({ symbol: h.symbol, address: h.address, decimals: h.decimals, amount: h.amount })),
  ];
}

/** The coins (not USDT) in the vault the money is leaving: the active one before the new vault is made, the old one after. */
export function coinsToLeave(v: VaultInfo, stage: MoveStage): string[] {
  const held = stage === 'make' ? v.holdings ?? [] : v.old?.holdings ?? [];
  return held.filter((h) => positive(h.amount)).map((h) => h.symbol);
}

/** How a new vault starts, read from the vault itself: its limits, its stop-loss, and the days its agent permission lasts. */
export function startTerms(v: VaultInfo, now = Date.now()): { perTrade?: string; perDay?: string; stopPct?: number; days?: number } {
  const left = v.session ? Math.round((v.session.until * 1000 - now) / 86_400_000) : undefined;
  return { perTrade: v.maxTradeUsdt, perDay: v.maxDailyUsdt, stopPct: v.stopLossBps ? v.stopLossBps / 100 : undefined, days: left !== undefined && left > 0 ? left : undefined };
}

export type MakeResult = { ok: true; made: boolean; paused: number } | { ok: false; reason: string };
/** Step one: ask the server to make the new vault. It pays; the wallet signs nothing. Asking twice makes one vault. */
export async function makeNewVault(): Promise<MakeResult> {
  try {
    const r = await fetch('/api/vault/upgrade', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: '{}' });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; made?: boolean; paused?: number; reason?: string; error?: string } | null;
    return r.ok && j?.ok ? { ok: true, made: !!j.made, paused: Number(j.paused) || 0 } : { ok: false, reason: j?.reason ?? j?.error ?? `HTTP ${r.status}` };
  } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
}
