/**
 * Domain types (SPEC §4). Money crosses these boundaries as decimal strings — USD amounts as
 * people write them ("5", "0.25"), token amounts as base-unit integers — and becomes exact
 * 18-decimal bigint inside calculations (amounts.ts). No floats touch money.
 */

export type Issuer = 'bstocks' | 'ondo' | 'xstocks';

export type PlanOwner =
  { kind: 'house' } | { kind: 'judge'; code: string } | { kind: 'skill'; token: string };

export type PlanMode = 'safe' | 'yield';
export type PlanWindow = 'regular_session' | 'anytime';
export type Cadence = 'weekly' | 'daily' | 'once';
export type PlanStatus = 'active' | 'paused' | 'stopped';

/** A registry row: addresses come only from the RWA API after on-chain checks (D-07). */
export interface Instrument {
  /** `${ticker}:${issuer}`, the instruments table key. */
  id: string;
  ticker: string;
  issuer: Issuer;
  chainId: 56;
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  /** Underlying shares per token (bStocks uiMultiplier, Ondo tokenToShareRatio). */
  multiplier: string;
  verifiedAt: string;
}

export interface Plan {
  id: string;
  owner: PlanOwner;
  mode: PlanMode;
  target: { type: 'ticker'; ticker: string } | { type: 'sector'; sector: string };
  /** Default ['bstocks', 'ondo']. */
  issuerPreference: Issuer[];
  /** USD kept in Venus; yield mode only ('0' for safe), at most the principal cap (config). */
  principalUsd: string;
  /** USD added per due cycle; '0' allowed. */
  contributionUsd: string;
  cadence: Cadence;
  window: PlanWindow;
  limits: { maxPerBuyUsd: string; maxDailyUsd: string };
  status: PlanStatus;
  pausedReason?: string;
  createdAt: string;
  nextDueAt: string;
  /** Judge plans stop after 7 days. */
  expiresAt?: string;
}

export type DeferredReason = 'market_closed' | 'price_gap' | 'session_expiring' | 'quote_impact';
export type SkippedReason =
  'below_min' | 'corporate_action' | 'daily_cap' | 'guardian' | 'no_instrument';

export type CycleOutcome =
  | {
      kind: 'BOUGHT';
      spendUsd: string;
      /** Received token amount in base units, parsed from the receipt (never the quote). */
      tokens: string;
      shares: string;
      /** Part of the spend paid from interest (yield plans), else null. */
      interestUsd: string | null;
      /** On-chain share price vs an independent stock price, in percent; null when none. */
      refGapPct: string | null;
    }
  | { kind: 'DEFERRED'; reason: DeferredReason; retryAt: string; detail?: string }
  | { kind: 'SKIPPED'; reason: SkippedReason; detail?: string }
  | { kind: 'FAILED'; code: string; message: string; fundsMoved: 'none' | 'gas_only' };

export interface Receipt {
  kind: 'deposit' | 'redeem' | 'approve' | 'swap';
  txHash: `0x${string}`;
  explorerUrl: string;
  chainId: 56;
  amounts: Record<string, string>;
  broadcastVia: 'transaction_api' | 'rpc';
  simulatedAt: string;
}

export interface Holding {
  planId: string;
  instrumentId: string;
  /** Base units. */
  tokens: string;
  multiplierAtLastUpdate: string;
  shares: string;
  costUsd: string;
  updatedAt: string;
}
