/**
 * POST /api/plans/:id/report for skill plans (SPEC §8.2, §9): the user's wallet says what it did;
 * we believe the chain, not the report. A transaction is recorded only when it is mined, succeeded,
 * was sent from the plan's wallet after the plan was made, and is not one the house wallet sent.
 * A swap must have delivered the plan's stock to that wallet; spending more than the plan allows
 * is still recorded (it happened) but pauses the plan. Each report is written in one transaction
 * with its receipt (packages/db record.ts), so a replayed or concurrent report changes nothing.
 */
import { BSC_USDT, transferredFrom, transferredTo, type BscClient } from '@yieldvest/chain';
import {
  boughtOutcome,
  fromUnits,
  nextDue,
  toUnits,
  usSession,
  type Instrument,
  type Plan,
  type Why,
} from '@yieldvest/core';
import {
  applyDeposit,
  applyReportedRedeem,
  isoTime,
  outboxByHash,
  receiptByHash,
  recordSkillSwap,
  updatePlanIf,
  utcDay,
  type Db,
  type PlanRow,
} from '@yieldvest/db';
import { getAddress, isAddressEqual, type Hex, type Log } from 'viem';

/** A skill yield plan's state until its first deposit is reported (POST /api/plans). */
export const AWAITING_DEPOSIT = 'awaiting_deposit';

export interface MinedTx {
  status: 'success' | 'reverted';
  from: string;
  blockNumber: bigint;
  /** The block's time, unix seconds. */
  timestamp: bigint;
  logs: readonly Log[];
}

export interface ChainReader {
  /** The mined transaction, or undefined while it is not mined. */
  mined(hash: Hex): Promise<MinedTx | undefined>;
}

export function viemReader(bsc: BscClient): ChainReader {
  return {
    async mined(hash) {
      try {
        const [receipt, tx] = await Promise.all([
          bsc.getTransactionReceipt({ hash }),
          bsc.getTransaction({ hash }),
        ]);
        const block = await bsc.getBlock({ blockNumber: receipt.blockNumber });
        return {
          status: receipt.status,
          from: tx.from,
          blockNumber: receipt.blockNumber,
          timestamp: block.timestamp,
          logs: receipt.logs,
        };
      } catch (error) {
        if (error instanceof Error && /not (be )?found/i.test(error.message)) return undefined;
        throw error;
      }
    },
  };
}

export interface ReportBody {
  kind: 'swap' | 'deposit' | 'redeem';
  txHash: Hex;
  orderId?: string | undefined;
}

export type ReportResult =
  | { status: 'pending' }
  | { status: 'rejected'; reason: string }
  | {
      status: 'recorded';
      kind: ReportBody['kind'];
      txHash: string;
      outcome?: unknown;
      why?: Why;
      paused?: string;
    }
  | { status: 'already_recorded'; txHash: string };

export async function recordReport(args: {
  db: Db;
  reader: ChainReader;
  row: PlanRow;
  plan: Plan;
  instruments: readonly Instrument[];
  vToken?: string | undefined;
  /** The house wallet (worker status): never a skill plan's wallet. */
  houseAddress?: string | undefined;
  body: ReportBody;
  now: Date;
}): Promise<ReportResult> {
  const { db, row, plan, now } = args;
  // Hashes are compared as text: one spelling (receipts store lowercase).
  const txHash = args.body.txHash.toLowerCase() as Hex;
  const body = { ...args.body, txHash };
  const wallet = row.walletAddress;
  if (!wallet) return { status: 'rejected', reason: 'the plan has no wallet' };
  if (args.houseAddress && isAddressEqual(getAddress(wallet), getAddress(args.houseAddress))) {
    return { status: 'rejected', reason: 'the plan wallet is the house wallet' };
  }
  if (await receiptByHash(db, txHash)) return { status: 'already_recorded', txHash };
  // What the house wallet signed is the worker's to record, never a report's.
  if (await outboxByHash(db, txHash)) {
    return { status: 'rejected', reason: 'the transaction was sent by the house wallet' };
  }
  const tx = await args.reader.mined(txHash);
  if (!tx) return { status: 'pending' };
  if (tx.status !== 'success') return { status: 'rejected', reason: 'the transaction reverted' };
  if (!isAddressEqual(getAddress(tx.from), getAddress(wallet))) {
    return { status: 'rejected', reason: 'the transaction was not sent by the plan wallet' };
  }
  // Only what the wallet did for this plan: nothing from before the plan existed.
  const createdSeconds = BigInt(Math.floor(Date.parse(isoTime(row.createdAt)) / 1000));
  if (tx.timestamp < createdSeconds) {
    return { status: 'rejected', reason: 'the transaction is older than the plan' };
  }
  const minedAt = new Date(Number(tx.timestamp) * 1000);
  const facts = (amounts: Record<string, string>) => ({
    kind: body.kind,
    txHash,
    broadcastVia: 'user_wallet',
    blockNumber: tx.blockNumber,
    status: 'success' as const,
    amounts: { ...amounts, ...(body.orderId ? { orderId: body.orderId } : {}) },
  });

  if (body.kind === 'deposit' || body.kind === 'redeem') {
    if (!args.vToken) return { status: 'rejected', reason: 'the Venus market is not known yet' };
    if (body.kind === 'deposit') {
      const vTokens = transferredTo(tx.logs, args.vToken, wallet);
      const usdt = transferredFrom(tx.logs, BSC_USDT, wallet);
      if (vTokens === 0n) return { status: 'rejected', reason: 'no vUSDT reached the wallet' };
      const fresh = await applyDeposit(
        db,
        plan.id,
        facts({ vTokens: vTokens.toString(), usdt: usdt.toString() }),
        { vTokens, usdtSpent: usdt },
      );
      if (!fresh) return { status: 'already_recorded', txHash };
      // A skill yield plan waits for its deposit; with the principal on record it starts running
      // (unless it was stopped meanwhile).
      await updatePlanIf(
        db,
        plan.id,
        { status: 'paused', pausedReason: AWAITING_DEPOSIT },
        { status: 'active', pausedReason: null, nextDueAt: now.toISOString() },
      );
      return { status: 'recorded', kind: body.kind, txHash };
    }
    const received = transferredTo(tx.logs, BSC_USDT, wallet);
    const burned = transferredFrom(tx.logs, args.vToken, wallet);
    if (received === 0n) return { status: 'rejected', reason: 'no USDT reached the wallet' };
    // A Venus redeem always burns vUSDT: without it the USDT is not from this position.
    if (burned === 0n) return { status: 'rejected', reason: 'no vUSDT left the wallet' };
    const fresh = await applyReportedRedeem(
      db,
      plan.id,
      facts({ usdtReceived: received.toString(), vTokensBurned: burned.toString() }),
      { usdtReceived: received, vTokensBurned: burned },
    );
    if (!fresh) return { status: 'already_recorded', txHash };
    return { status: 'recorded', kind: body.kind, txHash };
  }

  // swap
  const bought = args.instruments
    .map((instrument) => ({
      instrument,
      received: transferredTo(tx.logs, instrument.address, wallet),
    }))
    .find((b) => b.received > 0n);
  if (!bought)
    return {
      status: 'rejected',
      reason: `no ${plan.target.type === 'ticker' ? plan.target.ticker : ''} token reached the wallet`,
    };
  const spent = transferredFrom(tx.logs, BSC_USDT, wallet);
  if (spent === 0n) return { status: 'rejected', reason: 'no USDT left the wallet' };
  const spentUsd = fromUnits(spent, 18);

  const result = boughtOutcome(
    {
      kind: 'execute',
      instrumentId: bought.instrument.id,
      spendUsd: spentUsd,
      quote: {
        instrumentId: bought.instrument.id,
        spendUsd: spentUsd,
        receivedAt: minedAt.toISOString(),
      },
      redeemUsd: '0',
      interestUsd: null,
      offHours: usSession(minedAt) !== 'regular',
      refGapPct: null,
    },
    bought.instrument,
    bought.received.toString(),
  );
  // The next buy waits for the plan's cadence, counted from this one.
  const next = nextDue(plan.cadence, minedAt);
  const written = await recordSkillSwap(db, {
    planId: plan.id,
    facts: facts({
      instrumentId: bought.instrument.id,
      spentUsdtUnits: spent.toString(),
      receivedTokens: bought.received.toString(),
    }),
    instrument: bought.instrument,
    receivedTokens: bought.received,
    spentUsd,
    day: utcDay(minedAt),
    cycle: {
      dueAt: now.toISOString(),
      outcome: result.outcome,
      whyKey: result.why.key,
      whyParams: result.why.params,
      finishedAt: now.toISOString(),
    },
    planPatch: next.kind === 'due' ? { nextDueAt: next.nextDueAt } : {},
  });
  if (!written) return { status: 'already_recorded', txHash };

  // The plan's own limits bound what its wallet may spend (1 % for rounding); going past them
  // pauses the plan.
  const perBuy = toUnits(plan.limits.maxPerBuyUsd, 18);
  const perDay = toUnits(plan.limits.maxDailyUsd, 18);
  const overLimit =
    spent > perBuy + perBuy / 100n || toUnits(written.daySpentUsd, 18) > perDay + perDay / 100n;
  if (overLimit) {
    await updatePlanIf(
      db,
      plan.id,
      { status: 'active', pausedReason: null },
      { status: 'paused', pausedReason: 'report_over_limit' },
    );
  }
  return {
    status: 'recorded',
    kind: 'swap',
    txHash,
    outcome: result.outcome,
    why: result.why,
    ...(overLimit ? { paused: 'report_over_limit' } : {}),
  };
}
