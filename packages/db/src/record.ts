/**
 * Writing down what happened on chain, shared by the worker and the web's /report: a receipt row
 * and its effect on the plan (principal, vTokens, harvested interest, holdings, the spend ledger).
 *
 * Every effect is applied in one transaction that holds the plan row (SELECT … FOR UPDATE) and
 * inserts the receipt first: the receipt's unique tx hash makes the effect happen exactly once,
 * money columns are read and written by one writer at a time across processes, and a crash
 * between the receipt and its effect is impossible. Nothing writes these columns from a snapshot
 * taken earlier (DECISIONS D-23). Holdings snapshot the multiplier on every buy and recompute
 * shares from all tokens at the current multiplier; a change since the last write is logged.
 */
import { fromUnits, sameMultiplier, sharesFromTokens, toUnits, type Instrument } from '@ijaro/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import { usdText } from './mappers.js';
import { insertReceipt, type PlanPatch, type PlanRow } from './plans.js';
import { guardianEvents, holdings, plans, receipts, spendLedger } from './schema.js';

export interface ReceiptFacts {
  kind: 'approve' | 'swap' | 'deposit' | 'redeem';
  txHash: string;
  broadcastVia: string;
  blockNumber: bigint | string;
  status: 'success' | 'failed';
  simulatedAt?: string | null;
  amounts: Record<string, string>;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const units = (usd: string) => toUnits(usdText(usd), 18);
const decimal = (value: bigint) => fromUnits(value, 18);
const atLeastZero = (value: bigint) => (value > 0n ? value : 0n);

function receiptRow(planId: string, cycleId: number | null, facts: ReceiptFacts) {
  return {
    cycleId,
    planId,
    kind: facts.kind,
    // Hashes are compared as text: one spelling, so a re-spelled hash is the same receipt.
    txHash: facts.txHash.toLowerCase(),
    explorerUrl: `https://bscscan.com/tx/${facts.txHash.toLowerCase()}`,
    chainId: 56,
    amounts: facts.amounts,
    broadcastVia: facts.broadcastVia,
    simulatedAt: facts.simulatedAt ?? null,
    blockNumber: facts.blockNumber.toString(),
    status: facts.status,
  };
}

/** Stores the receipt once per transaction hash; false when it was already there. */
export async function recordReceiptFacts(
  db: Db,
  planId: string,
  cycleId: number | null,
  facts: ReceiptFacts,
): Promise<boolean> {
  return insertReceipt(db, receiptRow(planId, cycleId, facts));
}

async function insertReceiptTx(
  tx: Tx,
  planId: string,
  cycleId: number | null,
  facts: ReceiptFacts,
): Promise<boolean> {
  const created = await tx
    .insert(receipts)
    .values(receiptRow(planId, cycleId, facts))
    .onConflictDoNothing({ target: receipts.txHash })
    .returning({ id: receipts.id });
  return created.length > 0;
}

/**
 * Runs `apply` in one transaction holding the plan row, after inserting the receipt. Returns false
 * (and changes nothing) when the receipt was already recorded: its effect happened then.
 */
async function withReceipt(
  db: Db,
  planId: string,
  cycleId: number | null,
  facts: ReceiptFacts,
  apply: (tx: Tx, row: PlanRow) => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(plans).where(eq(plans.id, planId)).for('update');
    if (!row) throw new Error(`plan ${planId} not found`);
    if (!(await insertReceiptTx(tx, planId, cycleId, facts))) return false;
    await apply(tx, row);
    return true;
  });
}

async function updatePlanTx(tx: Tx, planId: string, patch: PlanPatch): Promise<void> {
  if (Object.keys(patch).length > 0) await tx.update(plans).set(patch).where(eq(plans.id, planId));
}

async function addToHoldingTx(
  tx: Tx,
  planId: string,
  instrument: Instrument,
  received: bigint,
  spentUsd: string,
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(holdings)
    .where(and(eq(holdings.planId, planId), eq(holdings.instrumentId, instrument.id)))
    .for('update');
  if (existing && !sameMultiplier(existing.multiplierAtLastUpdate, instrument.multiplier)) {
    await tx.insert(guardianEvents).values({
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
  const cost = (existing ? units(existing.costUsd) : 0n) + units(spentUsd);
  const row = {
    planId,
    instrumentId: instrument.id,
    tokens: tokens.toString(),
    decimals: instrument.decimals,
    multiplierAtLastUpdate: instrument.multiplier,
    shares: sharesFromTokens(tokens, instrument.decimals, instrument.multiplier),
    costUsd: decimal(cost),
  };
  await tx
    .insert(holdings)
    .values(row)
    .onConflictDoUpdate({
      target: [holdings.planId, holdings.instrumentId],
      set: {
        tokens: row.tokens,
        decimals: row.decimals,
        multiplierAtLastUpdate: row.multiplierAtLastUpdate,
        shares: row.shares,
        costUsd: row.costUsd,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Adds tokens to the plan's holding outside a receipt (kept for callers that record the receipt
 * themselves); holds the plan row like every other writer.
 */
export async function addToHolding(
  db: Db,
  planId: string,
  instrument: Instrument,
  received: bigint,
  spentUsd: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: plans.id }).from(plans).where(eq(plans.id, planId)).for('update');
    await addToHoldingTx(tx, planId, instrument, received, spentUsd);
  });
}

/**
 * A confirmed Venus deposit: the receipt, then principal += USDT spent and vTokens += minted.
 * An approval's receipt changes nothing else.
 */
export async function applyDeposit(
  db: Db,
  planId: string,
  facts: ReceiptFacts,
  minted: { vTokens: bigint; usdtSpent: bigint },
): Promise<boolean> {
  return withReceipt(db, planId, null, facts, async (tx, row) => {
    if (facts.kind !== 'deposit') return;
    await updatePlanTx(tx, planId, {
      principalUsd: decimal(units(row.principalUsd) + minted.usdtSpent),
      vtokenUnits: (BigInt(row.vtokenUnits) + minted.vTokens).toString(),
    });
  });
}

/**
 * A confirmed redemption of a plan's whole Venus position (guardian redeem_all, a stop, the
 * operator's yield:redeem): principal 0, vTokens less those burned, and what came back above the
 * principal kept as harvested interest. `patch` sets the plan's status in the same write; a plan
 * left active would fail the yield-principal CHECK, so an active plan is paused.
 */
export async function applyPositionRedeem(
  db: Db,
  planId: string,
  facts: ReceiptFacts,
  redeemed: { usdtReceived: bigint; vTokensBurned: bigint },
  patch: PlanPatch = {},
): Promise<boolean> {
  return withReceipt(db, planId, null, facts, async (tx, row) => {
    const interest = atLeastZero(redeemed.usdtReceived - units(row.principalUsd));
    const status = patch.status ?? row.status;
    await updatePlanTx(tx, planId, {
      ...patch,
      ...(status === 'active'
        ? { status: 'paused', pausedReason: patch.pausedReason ?? 'redeemed' }
        : {}),
      principalUsd: '0',
      vtokenUnits: atLeastZero(BigInt(row.vtokenUnits) - redeemed.vTokensBurned).toString(),
      harvestedUnspentUsd: decimal(units(row.harvestedUnspentUsd) + interest),
    });
  });
}

/** A confirmed redemption of interest inside a cycle: harvested += received, vTokens −= burned. */
export async function applyInterestRedeem(
  db: Db,
  planId: string,
  cycleId: number | null,
  facts: ReceiptFacts,
  redeemed: { usdtReceived: bigint; vTokensBurned: bigint },
): Promise<boolean> {
  return withReceipt(db, planId, cycleId, facts, async (tx, row) => {
    await updatePlanTx(tx, planId, {
      harvestedUnspentUsd: decimal(units(row.harvestedUnspentUsd) + redeemed.usdtReceived),
      vtokenUnits: atLeastZero(BigInt(row.vtokenUnits) - redeemed.vTokensBurned).toString(),
    });
  });
}

/**
 * A confirmed swap: the receipt, the cycle's reservation settled as spent (with what actually
 * left the wallet), the tokens added to the holding, and the interest it used taken out of
 * harvested — all at once, or none of it.
 */
export async function applySwap(
  db: Db,
  args: {
    planId: string;
    cycleId: number | null;
    facts: ReceiptFacts;
    instrument: Instrument;
    receivedTokens: bigint;
    spentUsd: string;
    /** Interest this buy used (yield plans); taken out of harvested, never below zero. */
    interestUsd: string | null;
  },
): Promise<boolean> {
  return withReceipt(db, args.planId, args.cycleId, args.facts, async (tx, row) => {
    if (args.cycleId !== null) {
      await tx
        .update(spendLedger)
        .set({ status: 'spent', amountUsd: args.spentUsd, updatedAt: sql`now()` })
        .where(eq(spendLedger.cycleId, args.cycleId));
    }
    await addToHoldingTx(tx, args.planId, args.instrument, args.receivedTokens, args.spentUsd);
    if (args.interestUsd !== null) {
      const harvested = units(row.harvestedUnspentUsd);
      const used = units(args.interestUsd);
      await updatePlanTx(tx, args.planId, {
        harvestedUnspentUsd: decimal(atLeastZero(harvested - used)),
      });
    }
  });
}
