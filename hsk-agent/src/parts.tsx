// The logged-in wallet's vault as the server reports it (/api/vault).

import type { Net, SendResult } from './account.ts';

/**
 * `configured` is "orders are real": the logged-in wallet has its own vault. Otherwise the app is a demo, for one of
 * three reasons: the server has no vault service (`service` false), nobody is logged in, or the vault is being made.
 */
export interface VaultInfo {
  configured: boolean; service?: boolean; signedIn?: boolean; owner?: string; making?: boolean; makeError?: string;
  vault?: string; explorerUrl?: string; localFork?: boolean; paused?: boolean; net?: Net;
  usdtBalance?: string; walletUsdt?: string; holdings?: { symbol: string; address: string; decimals: number; amount: string; costUsdt?: string; valueUsdt?: string; stopUsdt?: string; stopDue?: boolean }[];
  /** 0 or missing = no stop-loss; otherwise the loss on a holding (in basis points) at which anyone may sell it */
  stopLossBps?: number;
  /** The owner's limits on the agent. A missing value means the owner set no limit. */
  remainingTodayUsdt?: string; maxTradeUsdt?: string; maxDailyUsdt?: string; maxSlippageBps?: number;
  /** 3 and up can pay the maker of a shared agent a fee the owner approved; 2 cannot. */
  version?: number;
  /** Version 3: each buy spends from the hired agent's own on-chain budget. */
  budgetsOn?: boolean;
  /** Version 3: the factory's platform fee in basis points (0 unless its guardian set one; at most 20 = 0.2%). */
  platformFeeBps?: number;
  /** Version 3: the agent key's session on this vault, set by the owner (until: unix seconds; ours: Moa holds that key). */
  session?: { agent: string; until: number; maxTradeUsdt?: string; assets: string[]; ours: boolean };
  /** Version 3: the factory guardian stopped agent trading on every vault (funds and the stop-loss are untouched). */
  halted?: boolean;
  /** This vault is from an earlier factory and a newer one can be made for the wallet (`to` is its version). */
  upgrade?: { available: boolean; to?: number };
  /** The wallet has this vault and an earlier one: it has moved, or is moving. */
  moved?: boolean;
  /** The wallet's earlier vault, for as long as it holds anything: its address, version and balances. */
  old?: OldVault;
  /** Whether a newly shared agent may ask a creator fee: only when the vaults this server makes can pay one. */
  creatorFees?: boolean;
}
export interface OldVault {
  vault: string; version: number; explorerUrl?: string; usdtBalance: string; totalUsdt: string;
  holdings: { symbol: string; address: string; decimals: number; amount: string; valueUsdt?: string }[];
}

/** What the wallet said about a transaction, in words. Empty when it went through. */
export function sendNote(t: { txRejected: string; txReverted: string; txSlow: string; acNoWallet: string; txFailed: (d: string) => string }, r: SendResult): string {
  return r.ok ? '' : r.why === 'rejected' ? t.txRejected : r.why === 'reverted' ? t.txReverted : r.why === 'slow' ? t.txSlow : r.why === 'nowallet' ? t.acNoWallet : t.txFailed(r.detail ?? '');
}

/** The vault's limits in one line: "$10 per trade · $30 per day", or that there are none. */
export function limitsText(t: { limTrade: (a: string) => string; limDay: (a: string) => string; limNone: string }, v: VaultInfo): string {
  // A per-trade limit equal to the daily one says nothing more than the daily one does.
  const trade = v.maxTradeUsdt !== undefined && v.maxTradeUsdt !== v.maxDailyUsdt ? t.limTrade(v.maxTradeUsdt) : '';
  const parts = [trade, v.maxDailyUsdt !== undefined ? t.limDay(v.maxDailyUsdt) : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : t.limNone;
}

/** Why orders are or are not real right now. */
export type VaultWhy = 'on' | 'login' | 'making' | 'wait' | 'off';
export function vaultWhy(v: VaultInfo | null): VaultWhy {
  if (!v) return 'wait';
  if (v.configured) return 'on';
  if (!v.service) return 'off';
  return v.signedIn ? 'making' : 'login';
}
