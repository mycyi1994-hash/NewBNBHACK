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
  .regex(/^\d+(\.\d{1,2})?$/, 'a dollar amount like 5 or 2.50')
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
