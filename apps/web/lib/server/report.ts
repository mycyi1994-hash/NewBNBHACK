/**
 * POST /api/plans/:id/report for skill plans (SPEC §8.2, §9): the user's wallet says what it did;
 * we believe the chain, not the report. A transaction is recorded only when it is mined, succeeded
 * and was sent from the plan's wallet. A swap must have delivered the plan's stock to that wallet;
 * spending more than the plan allows is still recorded (it happened) but pauses the plan.
 */
import { BSC_USDT, transferredFrom, transferredTo, type BscClient } from '@ijaro/chain';
import {
  boughtOutcome,
  fromUnits,
  toUnits,
  usSession,
  type Instrument,
  type Plan,
  type Why,
} from '@ijaro/core';
import {
  addToHolding,
  applyDeposit,
  openCycle,
  receiptByHash,
  recordReceiptFacts,
  reserveSpend,
  settleSpend,
  updateCycle,
  updatePlan,
  usdText,
  utcDay,
  type Db,
  type PlanRow,
} from '@ijaro/db';
import { getAddress, isAddressEqual, type Hex, type Log } from 'viem';

/** A skill yield plan's state until its first deposit is reported (POST /api/plans). */
export const AWAITING_DEPOSIT = 'awaiting_deposit';

export interface MinedTx {
  status: 'success' | 'reverted';
  from: string;
  blockNumber: bigint;
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
        return {
          status: receipt.status,
          from: tx.from,
          blockNumber: receipt.blockNumber,
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
  body: ReportBody;
  now: Date;
}): Promise<ReportResult> {
  const { db, row, plan, body, now } = args;
  const wallet = row.walletAddress;
  if (!wallet) return { status: 'rejected', reason: 'the plan has no wallet' };
  if (await receiptByHash(db, body.txHash))
    return { status: 'already_recorded', txHash: body.txHash };
  const tx = await args.reader.mined(body.txHash);
  if (!tx) return { status: 'pending' };
  if (tx.status !== 'success') return { status: 'rejected', reason: 'the transaction reverted' };
  if (!isAddressEqual(getAddress(tx.from), getAddress(wallet))) {
    return { status: 'rejected', reason: 'the transaction was not sent by the plan wallet' };
  }
  const facts = (amounts: Record<string, string>) => ({
    kind: body.kind,
    txHash: body.txHash,
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
        {
          vTokens,
          usdtSpent: usdt,
        },
      );
      if (!fresh) return { status: 'already_recorded', txHash: body.txHash };
      // A skill yield plan waits for its deposit; with the principal on record it starts running.
      if (row.status === 'paused' && row.pausedReason === AWAITING_DEPOSIT) {
        await updatePlan(db, plan.id, {
          status: 'active',
          pausedReason: null,
          nextDueAt: now.toISOString(),
        });
      }
      return { status: 'recorded', kind: body.kind, txHash: body.txHash };
    }
    const received = transferredTo(tx.logs, BSC_USDT, wallet);
    const burned = transferredFrom(tx.logs, args.vToken, wallet);
    if (received === 0n) return { status: 'rejected', reason: 'no USDT reached the wallet' };
    const fresh = await recordReceiptFacts(
      db,
      plan.id,
      null,
      facts({ usdtReceived: received.toString(), vTokensBurned: burned.toString() }),
    );
    if (!fresh) return { status: 'already_recorded', txHash: body.txHash };
    await updatePlan(db, plan.id, {
      harvestedUnspentUsd: fromUnits(toUnits(usdText(row.harvestedUnspentUsd), 18) + received, 18),
      vtokenUnits: (BigInt(row.vtokenUnits) > burned
        ? BigInt(row.vtokenUnits) - burned
        : 0n
      ).toString(),
    });
    return { status: 'recorded', kind: body.kind, txHash: body.txHash };
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

  const { cycle } = await openCycle(db, {
    planId: plan.id,
    dueAt: now.toISOString(),
    executionMode: 'live',
  });
  const fresh = await recordReceiptFacts(
    db,
    plan.id,
    cycle.id,
    facts({
      instrumentId: bought.instrument.id,
      spentUsdtUnits: spent.toString(),
      receivedTokens: bought.received.toString(),
    }),
  );
  if (!fresh) {
    await updateCycle(db, cycle.id, {
      state: 'done',
      outcome: { kind: 'DUPLICATE_REPORT' },
      finishedAt: now.toISOString(),
    });
    return { status: 'already_recorded', txHash: body.txHash };
  }
  await addToHolding(db, plan.id, bought.instrument, bought.received, spentUsd);

  // The plan's own limits bound what its wallet may spend; going past them pauses the plan.
  const perBuy = toUnits(plan.limits.maxPerBuyUsd, 18);
  const reservation = await reserveSpend(db, {
    planId: plan.id,
    ownerKind: 'skill',
    ownerRef: row.ownerRef,
    day: utcDay(now),
    caps: { globalDailyUsd: plan.limits.maxDailyUsd, planDailyUsd: plan.limits.maxDailyUsd },
    cycleId: cycle.id,
    amountUsd: spentUsd,
  });
  if (reservation.ok) await settleSpend(db, cycle.id, 'spent', spentUsd);
  const overLimit = spent > perBuy + perBuy / 100n || !reservation.ok;

  const result = boughtOutcome(
    {
      kind: 'execute',
      instrumentId: bought.instrument.id,
      spendUsd: spentUsd,
      quote: {
        instrumentId: bought.instrument.id,
        spendUsd: spentUsd,
        receivedAt: now.toISOString(),
      },
      redeemUsd: '0',
      interestUsd: null,
      offHours: usSession(now) !== 'regular',
      refGapPct: null,
    },
    bought.instrument,
    bought.received.toString(),
  );
  await updateCycle(db, cycle.id, {
    state: 'done',
    outcomeKind: 'BOUGHT',
    outcome: result.outcome,
    whyKey: result.why.key,
    whyParams: result.why.params,
    instrumentId: bought.instrument.id,
    spendUsd: spentUsd,
    finishedAt: now.toISOString(),
  });
  if (overLimit) {
    await updatePlan(db, plan.id, { status: 'paused', pausedReason: 'report_over_limit' });
  }
  return {
    status: 'recorded',
    kind: 'swap',
    txHash: body.txHash,
    outcome: result.outcome,
    why: result.why,
    ...(overLimit ? { paused: 'report_over_limit' } : {}),
  };
}
