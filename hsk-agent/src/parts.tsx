// The logged-in wallet's vault as the server reports it (/api/vault).

import type { Net } from './account.ts';

/**
 * `configured` is "orders are real": the logged-in wallet has its own vault. Otherwise the app is a demo, for one of
 * three reasons: the server has no vault service (`service` false), nobody is logged in, or the vault is being made.
 */
export interface VaultInfo {
  configured: boolean; service?: boolean; signedIn?: boolean; owner?: string; making?: boolean; makeError?: string;
  vault?: string; explorerUrl?: string; localFork?: boolean; paused?: boolean; net?: Net;
  usdtBalance?: string; walletUsdt?: string; holdings?: { symbol: string; address: string; decimals: number; amount: string }[];
  remainingTodayUsdt?: string; maxTradeUsdt?: string; maxDailyUsdt?: string; maxSlippageBps?: number;
}

/** Why orders are or are not real right now. */
export type VaultWhy = 'on' | 'login' | 'making' | 'off';
export function vaultWhy(v: VaultInfo | null): VaultWhy {
  if (v?.configured) return 'on';
  if (!v?.service) return 'off';
  return v.signedIn ? 'making' : 'login';
}
