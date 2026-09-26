/**
 * Writing down what happened on chain, shared by the worker and the web's /report: a receipt row
 * and the plan's holding. Holdings snapshot the multiplier on every buy and recompute shares from
 * all tokens at the current multiplier; a change since the last write is logged (TASKS M1-08).
 */
import { fromUnits, sameMultiplier, sharesFromTokens, toUnits, type Instrument } from '@ijaro/core';
import type { Db } from './index.js';
import { usdText } from './mappers.js';
import {
  getHolding,
  getPlan,
  insertGuardianEvent,
  insertReceipt,
  updatePlan,
  upsertHolding,
} from './plans.js';

export interface ReceiptFacts {
  kind: 'approve' | 'swap' | 'deposit' | 'redeem';
  txHash: string;
  broadcastVia: string;
  blockNumber: bigint | string;
  status: 'success' | 'failed';
  simulatedAt?: string | null;
  amounts: Record<string, string>;
}

/** Stores the receipt once per transaction hash; false when it was already there. */
export async function recordReceiptFacts(
  db: Db,
  planId: string,
  cycleId: number | null,
  facts: ReceiptFacts,
): Promise<boolean> {
  return insertReceipt(db, {
    cycleId,
    planId,
    kind: facts.kind,
    txHash: facts.txHash,
    explorerUrl: `https://bscscan.com/tx/${facts.txHash}`,
    chainId: 56,
    amounts: facts.amounts,
    broadcastVia: facts.broadcastVia,
    simulatedAt: facts.simulatedAt ?? null,
    blockNumber: facts.blockNumber.toString(),
    status: facts.status,
  });
}

/** Adds a confirmed buy to the plan's holding (tokens in base units, spend in USD). */
export async function addToHolding(
  db: Db,
  planId: string,
  instrument: Instrument,
  received: bigint,
  spentUsd: string,
): Promise<void> {
  const existing = await getHolding(db, planId, instrument.id);
  if (existing && !sameMultiplier(existing.multiplierAtLastUpdate, instrument.multiplier)) {
    await insertGuardianEvent(db, {
      rule: 'multiplier_changed',
      action: 'warn',
      planId,
      detail: {
        instrumentId: instrument.id,
        from: existing.multiplierAtLastUpdate,
        to: instrument.multiplier,
      },
    });
  }
  const tokens = BigInt(existing?.tokens ?? '0') + received;
  const cost = toUnits(existing ? usdText(existing.costUsd) : '0', 18) + toUnits(spentUsd, 18);
  await upsertHolding(db, {
    planId,
    instrumentId: instrument.id,
    tokens: tokens.toString(),
    decimals: instrument.decimals,
    multiplierAtLastUpdate: instrument.multiplier,
    shares: sharesFromTokens(tokens, instrument.decimals, instrument.multiplier),
    costUsd: fromUnits(cost, 18),
  });
}

/**
 * Records a confirmed Venus deposit for a plan: the receipt, then principal += USDT spent and
 * vTokens += minted — once per transaction hash, so a repeated report or --record changes nothing.
 */
export async function applyDeposit(
  db: Db,
  planId: string,
  facts: ReceiptFacts,
  minted: { vTokens: bigint; usdtSpent: bigint },
): Promise<boolean> {
  const fresh = await recordReceiptFacts(db, planId, null, facts);
  if (!fresh || facts.kind !== 'deposit') return fresh;
  const row = await getPlan(db, planId);
  if (!row) throw new Error(`plan ${planId} vanished`);
  await updatePlan(db, planId, {
    principalUsd: fromUnits(toUnits(usdText(row.principalUsd), 18) + minted.usdtSpent, 18),
    vtokenUnits: (BigInt(row.vtokenUnits) + minted.vTokens).toString(),
  });
  return true;
}
