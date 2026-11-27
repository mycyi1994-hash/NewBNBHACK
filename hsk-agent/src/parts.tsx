// The logged-in wallet's vault as the server reports it (/api/vault).

import type { Net } from './account.ts';

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
  /** Version 3: the factory guardian stopped agent trading on every vault (funds and the stop-loss are untouched). */
  halted?: boolean;
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
