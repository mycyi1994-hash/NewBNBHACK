/**
 * Request bodies of the API routes, validated with zod — and the same schemas feed the OpenAPI
 * document (lib/server/openapi.ts), so the published contract cannot drift from what is enforced.
 * Amounts are decimal strings, never floats.
 */
import { isAddress } from 'viem';
import { z } from 'zod';

export const usdAmount = z
  .string()
  .trim()
  // Nine digits before the point: far above any cap, far below numeric(38,18).
  .regex(/^\d{1,9}(\.\d{1,2})?$/, 'a dollar amount like 5 or 2.50')
  .describe('US dollars as a decimal string with at most two decimals, e.g. "5" or "2.50"');

const ticker = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,6}$/)
  .describe('US ticker in the verified registry (GET /api/instruments), e.g. "NVDA"');

const window = z
  .enum(['regular_session', 'anytime'])
  .default('regular_session')
  .describe(
    'When buys may run: the US regular session (default) or any time (off-hours halves the per-buy limit; below the minimum buy it waits for the session)',
  );

const txHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .describe('BSC transaction hash');

export const JudgeSessionBody = z.object({
  code: z.string().trim().min(1).max(128).describe('Judge code from the submission page'),
});

export const JudgePlanBody = z.object({
  ticker,
  mode: z
    .enum(['safe', 'yield'])
    .default('safe')
    .describe(
      'safe: buy with the amount; yield: deposit the amount in Venus and buy with its interest',
    ),
  amountUsd: usdAmount,
  window,
});

export const SkillPlanBody = z.object({
  owner: z.literal('skill'),
  walletAddress: z
    .string()
    .refine((v) => isAddress(v), 'an EVM address')
    .describe('The user’s own wallet (Binance Agentic Wallet); it signs, we never do'),
  ticker,
  issuer: z
    .enum(['bstocks', 'ondo'])
    .describe(
      'The issuer the user chose for the ticker: bstocks (…B) or ondo (…on). The plan buys only that token, never the other one in its place',
    ),
  mode: z
    .enum(['safe', 'yield'])
    .default('safe')
    .describe('yield plans start paused until their Venus deposit is reported'),
  contributionUsd: usdAmount.describe('Fixed amount per buy (safe mode); "0" for interest only'),
  cadence: z.enum(['daily', 'weekly']).default('weekly'),
  window,
  maxPerBuyUsd: usdAmount.describe('Hard limit per buy, at most the house per-transaction cap'),
  maxDailyUsd: usdAmount.describe('Hard limit per UTC day, at least maxPerBuyUsd'),
});

export const RunBody = z.object({
  depositUsd: usdAmount
    .optional()
    .describe('Yield plans only: the Venus deposit that starts the plan (at most the sandbox cap)'),
});

export const ReportRequest = z.object({
  kind: z.enum(['swap', 'deposit', 'redeem']),
  txHash,
  orderId: z.string().max(64).optional().describe('baw market-order id, kept with the receipt'),
});

/** A GET request's query string as an object, for the schemas below. */
export const queryOf = (request: Request): Record<string, string> =>
  Object.fromEntries(new URL(request.url).searchParams);

const issuer = z
  .enum(['bstocks', 'ondo'])
  .describe('bstocks (symbols end in B) or ondo (symbols end in "on")');

/** GET /api/compare (DECISIONS D-31, F2). */
export const CompareQuery = z.object({
  ticker: ticker
    .optional()
    .describe('The stock to compare; without it, the tickers that can be compared'),
});

/** GET /api/preflight (DECISIONS D-31, F1): a fixed-amount plan that does not exist yet. */
export const PreflightQuery = z.object({
  ticker,
  issuer: issuer.optional().describe('Only this issuer; both when absent'),
  usd: usdAmount.describe(
    'The amount per buy: at least the minimum buy, at most the house per-transaction cap',
  ),
  window,
});

/** GET /api/projection (DECISIONS D-31, F3). */
export const ProjectionQuery = z.object({
  depositUsd: usdAmount.describe('The USDT a person would put in the interest account'),
  ticker: ticker.optional().describe('Price the monthly interest in shares of this stock'),
  issuer: issuer.optional().describe('Whose token prices the share (default: bstocks, then ondo)'),
});

/** GET /api/wallet (DECISIONS D-32): any BNB Smart Chain address, read at one block. */
export const WalletQuery = z.object({
  address: z
    .string()
    .trim()
    .refine((v) => isAddress(v, { strict: false }), 'an EVM address (0x and 40 hex characters)')
    .describe(
      'A BNB Smart Chain wallet: a Binance Wallet or an Agentic Wallet (baw wallet address)',
    ),
});
