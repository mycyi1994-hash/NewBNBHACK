/**
 * Cycles held for review (PD-07) on Postgres: an interrupted cycle that signed with no recorded
 * decision blocks its plan (every cycle answers outbox_busy); it closes only once its transactions
 * are settled and its plan is free, ends FAILED with its reservation counted as spent, and the plan
 * runs again after that.
 */
import {
  acquirePlanLock,
  appendCycleStep,
  createDb,
  getCycle,
  getPlan,
  markOutbox,
  openCycle,
  recordSigned,
  releasePlanLock,
  reserveSpend,
  spendLedger,
  utcDay,
} from '@yieldvest/db';
import { eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTestUrl } from '../test/db.js';
import { cleanup } from '../test/harness.js';
import { createWorld, testInstrument, testPlan } from '../test/world.js';
import { recoverInterrupted, runCycle } from './cycle.js';
import { closeReviewedCycle, cyclesHeldForReview } from './review.js';

const url = agentTestUrl;
const MON_1000 = '2026-09-28T14:00:00.000Z';

describe.skipIf(!url)('cycles held for review (PD-07) on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const planIds: string[] = [];
  let ticker = '';
  let instrumentId = '';

  beforeAll(async () => {
    ({ ticker, instrumentId } = await testInstrument(db));
  });
  afterAll(async () => {
    await cleanup(db, planIds, [instrumentId]);
    await close();
  });

  it('blocks the plan until closed after review, then lets it run again', async () => {
    const w = await createWorld(db, MON_1000);
    const id = await testPlan(db, ticker);
    planIds.push(id);
    const { cycle } = await openCycle(db, {
      planId: id,
      dueAt: '2026-09-28T13:32:00.000Z',
      executionMode: 'live',
    });
    await appendCycleStep(db, cycle.id, { step: 'INPUTS' });
    await reserveSpend(db, {
      planId: id,
      ownerKind: 'house',
      ownerRef: null,
      day: utcDay(new Date(MON_1000)),
      caps: { globalDailyUsd: '1000000', planDailyUsd: '1000' },
      cycleId: cycle.id,
      amountUsd: '5',
    });
    // Signed, then the process died before writing its decision down: a person must look.
    const hash = `0x${'cd'.repeat(31)}${(cycle.id % 256).toString(16).padStart(2, '0')}` as Hex;
    await recordSigned(db, {
      planId: id,
      cycleId: cycle.id,
      kind: 'approve',
      chainId: 56,
      // A sender of its own, so the shared test wallet's nonces are untouched.
      fromAddress: '0x000000000000000000000000000000000000bEEF',
      nonce: cycle.id,
      rawTx: '0x00',
      txHash: hash,
    });
    await markOutbox(db, hash, { status: 'PENDING' });
    const running = await getCycle(db, cycle.id);
    if (!running) throw new Error('cycle missing');
    await recoverInterrupted(w.deps('live'), running);
    expect(await getPlan(db, id)).toMatchObject({ status: 'paused', pausedReason: 'needs_review' });
    expect((await cyclesHeldForReview(db, id)).map((c) => c.id)).toEqual([cycle.id]);
    // Every cycle of the plan waits on it.
    expect(await runCycle(w.deps('simulate'), id, { manual: true })).toMatchObject({
      status: 'outbox_busy',
    });

    // Not while the chain has not decided its transaction.
    expect(await closeReviewedCycle(w.deps('live'), id, cycle.id)).toEqual({
      kind: 'refused',
      reason: 'unsettled',
      pending: [hash],
    });
    await markOutbox(db, hash, { status: 'CONFIRMED' });
    // Not while another process holds the plan.
    const lock = await acquirePlanLock(db, id, w.deps('live').now(), 60_000);
    expect(await closeReviewedCycle(w.deps('live'), id, cycle.id)).toEqual({
      kind: 'refused',
      reason: 'locked',
    });
    await releasePlanLock(db, id, lock?.lockUntil ?? null);
    // Only a cycle of this plan that is held.
    expect(await closeReviewedCycle(w.deps('live'), id, cycle.id + 1_000_000)).toEqual({
      kind: 'refused',
      reason: 'not_held',
    });

    expect(await closeReviewedCycle(w.deps('live'), id, cycle.id)).toEqual({
      kind: 'closed',
      cycleId: cycle.id,
      confirmed: [hash],
    });
    expect(await getCycle(db, cycle.id)).toMatchObject({
      state: 'done',
      outcomeKind: 'FAILED',
      outcome: { code: 'CLOSED_AFTER_REVIEW', fundsMoved: 'gas_only' },
      whyKey: 'why.closed.review',
    });
    const [ledger] = await db.select().from(spendLedger).where(eq(spendLedger.cycleId, cycle.id));
    expect(ledger).toMatchObject({ status: 'spent' });
    expect(await getPlan(db, id)).toMatchObject({
      status: 'paused',
      pausedReason: 'paused_by_operator',
      lockUntil: null,
    });
    expect(await cyclesHeldForReview(db, id)).toEqual([]);
    expect(await closeReviewedCycle(w.deps('live'), id, cycle.id)).toMatchObject({
      reason: 'not_held',
    });
    // The plan runs again.
    expect(await runCycle(w.deps('simulate'), id, { manual: true })).not.toMatchObject({
      status: 'outbox_busy',
    });
  });
});
