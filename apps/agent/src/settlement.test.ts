/**
 * What happens between signing and writing down (DECISIONS D-23), on real Postgres with the fake
 * API and chain: a cycle that dies after its redeem confirmed books it once; a cycle a dead worker
 * left running is recovered by the next lock holder; a deposit mined late is applied once and
 * starts its plan; a whole-position redeem waits for the plan's lock and for its unsettled
 * transactions; a manual run left awaiting never moves the schedule; a lagging node is waited for.
 */
import { toUnits } from '@yieldvest/core';
import {
  acquirePlanLock,
  appendCycleStep,
  createDb,
  cycles,
  cyclesOfPlan,
  getCycle,
  getHolding,
  getPlan,
  listReceipts,
  markOutbox,
  openCycle,
  recordSigned,
  releasePlanLock,
  reserveSpend,
  spendLedger,
  txOutbox,
  usdText,
} from '@yieldvest/db';
import { eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTestUrl } from '../test/db.js';
import { cleanup } from '../test/harness.js';
import {
  createWorld,
  RECEIVED,
  testInstrument,
  testPlan,
  withVenus,
  type World,
} from '../test/world.js';
import { LockLostError, recoverInterrupted, runCycle } from './cycle.js';
import { startYieldPlan } from './deposit.js';
import { redeemPlanPosition } from './guardian.js';
import { settleOutbox } from './settlement.js';

const url = agentTestUrl;
const MON_1000 = '2026-09-28T14:00:00.000Z'; // Mon 10:00 ET, regular session
const MINT_SELECTOR = '0xa0712d68';
const REDEEM_SELECTOR = '0xdb006a75';
const E18 = 10n ** 18n;

describe.skipIf(!url)('settling what was sent (D-23) on Postgres', () => {
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

  async function plan(overrides: Record<string, unknown> = {}) {
    const id = await testPlan(db, ticker, overrides);
    planIds.push(id);
    return id;
  }

  /** A house yield plan: $100 principal, a $106 position (rate 1e28: 1 USDT = 1e8 vTokens). */
  const yieldPlan = (overrides: Record<string, unknown> = {}) =>
    plan({
      mode: 'yield',
      contributionUsd: '0',
      cadence: 'weekly',
      principalUsd: '100',
      vtokenUnits: '10600000000',
      ...overrides,
    });

  const ledgerOf = async (cycleId: number) =>
    (await db.select().from(spendLedger).where(eq(spendLedger.cycleId, cycleId)))[0];

  const units = (usd: string | undefined) => toUnits(usdText(usd ?? ''), 18);

  it('books an interest redeem once when the cycle dies after it confirmed', async () => {
    const w = await createWorld(db, MON_1000);
    withVenus(w);
    const id = await yieldPlan();
    // The redeem goes out and confirms; then the RPC fails while the approval is prepared.
    w.chain.allowance = () => Promise.reject(new Error('rpc down'));
    await expect(runCycle(w.deps('live'), id)).rejects.toThrow('rpc down');

    expect(w.chain.sent.map((tx) => tx.data.slice(0, 10))).toEqual([REDEEM_SELECTOR]);
    const [receipt] = await listReceipts(db, { planIds: [id] });
    expect(receipt).toMatchObject({ kind: 'redeem', status: 'success' });
    const cycleId = receipt?.cycleId ?? -1;
    // The redeem is on record the moment it confirmed: $5 of interest, 5e8 vTokens burned.
    const afterRedeem = await getPlan(db, id);
    expect(afterRedeem?.vtokenUnits).toBe('10100000000');
    expect(units(afterRedeem?.harvestedUnspentUsd)).toBe(5n * E18);
    expect(afterRedeem?.lockUntil).toBeNull();
    // The cycle is handed to the awaiting path, not left running.
    expect(await getCycle(db, cycleId)).toMatchObject({ state: 'awaiting_tx' });

    const settled = await settleOutbox(w.deps('live'));
    expect(settled.completed).toEqual([`${id}#${cycleId}`]);
    expect(await getCycle(db, cycleId)).toMatchObject({
      state: 'done',
      outcomeKind: 'FAILED',
      outcome: { code: 'INTERRUPTED', fundsMoved: 'gas_only' },
    });
    expect(await ledgerOf(cycleId)).toMatchObject({ status: 'released' });
    // Applied once: settling again (or a second settle) never doubles it.
    await settleOutbox(w.deps('live'));
    const after = await getPlan(db, id);
    expect(after?.vtokenUnits).toBe('10100000000');
    expect(units(after?.harvestedUnspentUsd)).toBe(5n * E18);
    // The scheduled slot is closed: the plan moved to its next week.
    expect(Date.parse(after?.nextDueAt ?? '')).toBeGreaterThan(Date.parse(MON_1000));
    expect(w.chain.sent).toHaveLength(1);
  });

  it('closes a cycle a dead worker left running before signing, and frees its reservation', async () => {
    const w = await createWorld(db, MON_1000);
    const id = await plan();
    const row = await getPlan(db, id);
    const { cycle } = await openCycle(db, {
      planId: id,
      dueAt: row?.nextDueAt ?? '',
      executionMode: 'live',
    });
    const reserved = await reserveSpend(db, {
      planId: id,
      ownerKind: 'house',
      ownerRef: null,
      day: '2026-09-28',
      caps: { globalDailyUsd: '1000000', planDailyUsd: '5' },
      cycleId: cycle.id,
      amountUsd: '5',
    });
    expect(reserved.ok).toBe(true);

    // The next tick holds the lock, closes the dead cycle and moves the plan to its next slot.
    expect(await runCycle(w.deps('live'), id)).toEqual({ status: 'not_due', planId: id });
    expect(await getCycle(db, cycle.id)).toMatchObject({
      state: 'done',
      outcomeKind: 'FAILED',
      outcome: { code: 'INTERRUPTED', fundsMoved: 'none' },
    });
    expect(await ledgerOf(cycle.id)).toMatchObject({ status: 'released' });
    expect((await getPlan(db, id))?.nextDueAt).toMatch(/^2026-09-29 13:32/);
    expect(w.chain.sent).toEqual([]);
  });

  it('finishes from the chain a cycle that died after signing', async () => {
    const w = await createWorld(db, MON_1000);
    const id = await plan();
    // An approval goes out and is not mined; then the process "dies" before writing AWAITING.
    w.chain.mines = false;
    const first = await runCycle(w.deps('live'), id);
    expect(first).toMatchObject({ status: 'awaiting_tx' });
    const cycleId = first.status === 'awaiting_tx' ? first.cycleId : -1;
    const cycle = await getCycle(db, cycleId);
    const steps = (cycle?.steps ?? []) as { step?: string }[];
    await db
      .update(cycles)
      .set({ state: 'running', steps: steps.filter((s) => s.step !== 'AWAITING') })
      .where(eq(cycles.id, cycleId));

    w.chain.mines = true;
    // Settling confirms the approval, takes the dead cycle's free lock, hands it to the awaiting
    // path and finishes it from the chain — the next run opens nothing on top of it.
    const settled = await settleOutbox(w.deps('live'));
    expect(settled.completed).toEqual([`${id}#${cycleId}`]);
    expect(await runCycle(w.deps('live'), id)).toEqual({ status: 'not_due', planId: id });
    expect(await getCycle(db, cycleId)).toMatchObject({
      outcomeKind: 'FAILED',
      outcome: { code: 'INTERRUPTED', fundsMoved: 'gas_only' },
    });
    expect(await ledgerOf(cycleId)).toMatchObject({ status: 'released' });
    expect((await getPlan(db, id))?.nextDueAt).toMatch(/^2026-09-29 13:32/);
    expect(w.chain.sent.map((tx) => tx.data.slice(0, 10))).toEqual(['0x095ea7b3']);
  });

  it('recovers at the next settle a cycle that died while its plan waits for nobody (a judge’s buy now)', async () => {
    const w = await createWorld(db, MON_1000);
    const id = await plan({ status: 'paused', pausedReason: 'awaiting_run' });
    w.chain.mines = false;
    const first = await runCycle(w.deps('live'), id, { manual: true });
    expect(first).toMatchObject({ status: 'awaiting_tx' });
    const cycleId = first.status === 'awaiting_tx' ? first.cycleId : -1;
    const cycle = await getCycle(db, cycleId);
    const steps = (cycle?.steps ?? []) as { step?: string }[];
    // The worker dies mid-cycle: still 'running', and its lock still held for a while.
    await db
      .update(cycles)
      .set({ state: 'running', steps: steps.filter((s) => s.step !== 'AWAITING') })
      .where(eq(cycles.id, cycleId));
    const held = await acquirePlanLock(db, id, new Date(), 60_000);
    w.chain.mines = true;
    // While the lock is held the cycle may still be running somewhere: left alone.
    await settleOutbox(w.deps('live'));
    expect(await getCycle(db, cycleId)).toMatchObject({ state: 'running' });
    // Once the dead holder's lock is gone, the next settle finishes it — no due time needed.
    await releasePlanLock(db, id, held?.lockUntil ?? null);
    const settled = await settleOutbox(w.deps('live'));
    expect(settled.completed).toEqual([`${id}#${cycleId}`]);
    expect(await getCycle(db, cycleId)).toMatchObject({
      state: 'done',
      outcomeKind: 'FAILED',
      outcome: { code: 'INTERRUPTED', fundsMoved: 'gas_only' },
    });
    expect(await ledgerOf(cycleId)).toMatchObject({ status: 'released' });
  });

  it('stops a cycle that outlived its lock once a settle took the plan over: nothing more is signed', async () => {
    const w = await createWorld(db, MON_1000);
    const id = await plan({ status: 'paused', pausedReason: 'awaiting_run' });
    const allowance = w.chain.allowance.bind(w.chain);
    let cycleId = -1;
    // The cycle has reserved its $5 and reads the allowance 13 minutes in (slow receipts, API
    // retries): its lock lapsed, and another process's settle takes the plan over.
    w.chain.allowance = async (token, owner, spender) => {
      if (cycleId === -1) {
        cycleId = (await cyclesOfPlan(db, id, ['running']))[0]?.id ?? -2;
        expect(await ledgerOf(cycleId)).toMatchObject({ status: 'reserved' });
        w.clock.advance(13 * 60_000);
        await settleOutbox(w.deps('live'));
      }
      return allowance(token, owner, spender);
    };
    await expect(runCycle(w.deps('live'), id, { manual: true })).rejects.toThrow(LockLostError);
    // The approval it was about to sign never was, and the cycle stays as the settle closed it.
    expect(w.chain.sent).toEqual([]);
    expect(await db.select().from(txOutbox).where(eq(txOutbox.planId, id))).toEqual([]);
    expect(await getCycle(db, cycleId)).toMatchObject({
      state: 'done',
      outcomeKind: 'FAILED',
      outcome: { code: 'INTERRUPTED', fundsMoved: 'none' },
    });
    expect(await ledgerOf(cycleId)).toMatchObject({ status: 'released' });
    expect((await getPlan(db, id))?.lockUntil).toBeNull();
  });

  it('renews the lock of a slow cycle nobody took over, and buys', async () => {
    const w = await createWorld(db, MON_1000);
    const id = await plan({ status: 'paused', pausedReason: 'awaiting_run' });
    const allowance = w.chain.allowance.bind(w.chain);
    let slow = true;
    w.chain.allowance = (token, owner, spender) => {
      // Once, 13 minutes go by: the lock lapsed, but it is still this cycle's.
      if (slow) w.clock.advance(13 * 60_000);
      slow = false;
      return allowance(token, owner, spender);
    };
    expect(await runCycle(w.deps('live'), id, { manual: true })).toMatchObject({
      status: 'done',
      outcome: { kind: 'BOUGHT', spendUsd: '5' },
    });
    expect((await getPlan(db, id))?.lockUntil).toBeNull();
  });

  it('holds a cycle that signed with no recorded decision for a human', async () => {
    const w = await createWorld(db, MON_1000);
    const id = await plan();
    const { cycle } = await openCycle(db, {
      planId: id,
      dueAt: '2026-09-28T13:32:00.000Z',
      executionMode: 'live',
    });
    await appendCycleStep(db, cycle.id, { step: 'INPUTS' });
    // A row from another sender, so it never touches the shared test wallet's nonces.
    const hash = `0x${'ab'.repeat(32)}${cycle.id.toString(16)}`.slice(0, 66) as Hex;
    await recordSigned(db, {
      planId: id,
      cycleId: cycle.id,
      kind: 'approve',
      chainId: 56,
      fromAddress: '0x000000000000000000000000000000000000dEaD',
      nonce: cycle.id,
      rawTx: '0x00',
      txHash: hash,
    });
    await markOutbox(db, hash, { status: 'FAILED', error: 'test' });
    const current = await getCycle(db, cycle.id);
    if (!current) throw new Error('cycle missing');
    await recoverInterrupted(w.deps('live'), current);
    expect(await getCycle(db, cycle.id)).toMatchObject({ state: 'awaiting_tx' });
    expect(await getPlan(db, id)).toMatchObject({ status: 'paused', pausedReason: 'needs_review' });
    expect(w.alerts.join('\n')).toContain('no recorded decision');
    // Held: settling leaves it to the human.
    expect((await settleOutbox(w.deps('live'))).completed).not.toContain(`${id}#${cycle.id}`);
  });

  it('applies a Judge Mode deposit mined late once, starts the plan, and keeps the code cap', async () => {
    const w = await createWorld(db, MON_1000);
    withVenus(w);
    const code = `code-${planIds.length}-${Date.now()}`;
    const judge = {
      ownerKind: 'judge',
      ownerRef: code,
      status: 'paused',
      pausedReason: 'awaiting_run',
    };
    const a = await yieldPlan({ ...judge, principalUsd: '0', vtokenUnits: '0' });
    const b = await yieldPlan({ ...judge, principalUsd: '0', vtokenUnits: '0' });
    // The approval confirms; the deposit is not mined before the job stops waiting.
    w.chain.mines = (tx) => !tx.data.startsWith(MINT_SELECTOR);
    const rowA = await getPlan(db, a);
    const result = await startYieldPlan(w.deps('live'), rowA!, '3');
    expect(result).toMatchObject({ status: 'awaiting_tx' });
    expect(await getPlan(db, a)).toMatchObject({ status: 'paused', pausedReason: 'awaiting_run' });
    // Nothing else of this code deposits while it settles.
    await expect(startYieldPlan(w.deps('live'), (await getPlan(db, b))!, '1')).rejects.toThrow(
      'still settling',
    );

    w.chain.mines = true;
    const settled = await settleOutbox(w.deps('live'));
    expect(settled.applied).toContain(result.txHash);
    const started = await getPlan(db, a);
    expect(started).toMatchObject({
      status: 'active',
      pausedReason: null,
      vtokenUnits: '300000000',
    });
    expect(usdText(started?.principalUsd ?? '')).toBe('3');
    expect((await settleOutbox(w.deps('live'))).applied).toEqual([]);
    expect(usdText((await getPlan(db, a))?.principalUsd ?? '')).toBe('3');

    // The code has $2 of its $5 left: principal counts.
    await expect(startYieldPlan(w.deps('live'), (await getPlan(db, b))!, '3')).rejects.toThrow(
      'this code has 2 USD left',
    );
    expect(await startYieldPlan(w.deps('live'), (await getPlan(db, b))!, '2')).toMatchObject({
      status: 'deposited',
      depositedUsd: '2',
    });
  });

  it('says a Judge Mode deposit waits for its approval, and uses that approval on the next try', async () => {
    const w = await createWorld(db, MON_1000);
    withVenus(w);
    const id = await yieldPlan({
      ownerKind: 'judge',
      ownerRef: `code-approve-${Date.now()}`,
      status: 'paused',
      pausedReason: 'awaiting_run',
      principalUsd: '0',
      vtokenUnits: '0',
    });
    // The exact approval is not mined before the job stops waiting: the deposit was never sent.
    w.chain.mines = false;
    const first = await startYieldPlan(w.deps('live'), (await getPlan(db, id))!, '1');
    expect(first).toMatchObject({ status: 'approval_pending' });
    expect(w.chain.sent.map((tx) => tx.data.slice(0, 10))).toEqual(['0x095ea7b3']);
    // Once it is mined, asking again settles it and deposits with the allowance it left — no tick
    // in between.
    w.chain.mines = true;
    expect(await startYieldPlan(w.deps('live'), (await getPlan(db, id))!, '1')).toMatchObject({
      status: 'deposited',
      depositedUsd: '1',
    });
    expect(w.chain.sent.map((tx) => tx.data.slice(0, 10))).toEqual(['0x095ea7b3', MINT_SELECTOR]);
    expect(await getPlan(db, id)).toMatchObject({ status: 'active', vtokenUnits: '100000000' });
  });

  it('never activates a plan a stop reached while its deposit was out', async () => {
    const w = await createWorld(db, MON_1000);
    withVenus(w);
    const code = `code-stop-${Date.now()}`;
    const id = await yieldPlan({
      ownerKind: 'judge',
      ownerRef: code,
      status: 'paused',
      pausedReason: 'awaiting_run',
      principalUsd: '0',
      vtokenUnits: '0',
    });
    w.chain.mines = (tx) => !tx.data.startsWith(MINT_SELECTOR);
    const pending = await startYieldPlan(w.deps('live'), (await getPlan(db, id))!, '1');
    expect(pending).toMatchObject({ status: 'awaiting_tx' });
    // The owner stops the plan meanwhile. Its vTokens are not on record yet, but the deposit is
    // out: not "nothing to redeem" — the plan is stopped and a human is told to redeem it.
    expect(
      await redeemPlanPosition(w.deps('live'), (await getPlan(db, id))!, {
        status: 'stopped',
        reason: 'stopped_by_owner',
      }),
    ).toBe('pending');
    expect(w.alerts.join('\n')).toContain('not settled yet');
    w.chain.mines = true;
    await settleOutbox(w.deps('live'));
    // The late deposit is on record, the stop stands, and the plan says what is left to do.
    const row = await getPlan(db, id);
    expect(row).toMatchObject({
      status: 'stopped',
      pausedReason: 'stopped_by_owner:redeem_pending',
    });
    expect(row?.vtokenUnits).toBe('100000000');
  });

  it('lets only a live run stop an expired plan that still holds a position', async () => {
    const w = await createWorld(db, MON_1000);
    withVenus(w);
    const id = await yieldPlan({
      ownerKind: 'judge',
      ownerRef: `code-expired-${Date.now()}`,
      expiresAt: '2026-09-27T00:00:00.000Z',
    });
    // A preview job (simulate) reaches the expired plan first: it signs nothing, so it changes
    // nothing — a stopped plan would never be looked at again, with its deposit still in Venus.
    expect(await runCycle(w.deps('simulate'), id)).toEqual({ status: 'stopped', planId: id });
    expect(await getPlan(db, id)).toMatchObject({ status: 'active', vtokenUnits: '10600000000' });
    expect(w.chain.sent).toEqual([]);
    // A live worker that has not found the Venus market yet leaves it due: no human is needed.
    const { venus: _unknown, ...blind } = w.deps('live');
    expect(await runCycle(blind, id)).toEqual({ status: 'stopped', planId: id });
    expect(await getPlan(db, id)).toMatchObject({ status: 'active', vtokenUnits: '10600000000' });
    expect(w.alerts).toEqual([]);
    // The live worker that knows it stops it and takes the position back to the house wallet.
    expect(await runCycle(w.deps('live'), id)).toEqual({ status: 'stopped', planId: id });
    const row = await getPlan(db, id);
    expect(row).toMatchObject({ status: 'stopped', pausedReason: 'expired' });
    expect(BigInt(row?.vtokenUnits ?? '1')).toBeLessThanOrEqual(1n);
    expect(w.chain.sent.map((tx) => tx.data.slice(0, 10))).toEqual([REDEEM_SELECTOR]);
  });

  it('redeems a whole position only with the lock and a settled plan', async () => {
    const w = await createWorld(db, MON_1000);
    withVenus(w);
    const id = await yieldPlan({ principalUsd: '1', vtokenUnits: '100000000' });
    const stop = { status: 'stopped', reason: 'stopped_by_owner' } as const;

    // A cycle of this plan (another process) holds the lock: nothing is signed.
    const held = await acquirePlanLock(db, id, new Date(MON_1000), 60_000);
    expect(await redeemPlanPosition(w.deps('live'), (await getPlan(db, id))!, stop)).toBe('locked');
    expect(await getPlan(db, id)).toMatchObject({
      status: 'stopped',
      pausedReason: 'stopped_by_owner:redeem_locked',
    });
    await releasePlanLock(db, id, held?.lockUntil ?? null);

    // A deposit of this plan still out on chain: its vTokens are not known yet.
    w.chain.mines = (tx) => !tx.data.startsWith(MINT_SELECTOR);
    const other = await yieldPlan({ principalUsd: '1', vtokenUnits: '100000000' });
    expect(await startYieldPlan(w.deps('live'), (await getPlan(db, other))!, '1')).toMatchObject({
      status: 'awaiting_tx',
    });
    expect(await redeemPlanPosition(w.deps('live'), (await getPlan(db, other))!, stop)).toBe(
      'pending',
    );
    expect(w.chain.sent.some((tx) => tx.data.startsWith(REDEEM_SELECTOR))).toBe(false);

    // Settled and unlocked: the whole position comes home, once.
    w.chain.mines = true;
    await settleOutbox(w.deps('live'));
    expect(await redeemPlanPosition(w.deps('live'), (await getPlan(db, other))!, stop)).toBe(
      'redeemed',
    );
    const done = await getPlan(db, other);
    expect(done).toMatchObject({ status: 'stopped', pausedReason: 'stopped_by_owner' });
    expect(usdText(done?.principalUsd ?? '')).toBe('0');
    expect(done?.lockUntil).toBeNull();
  });

  it('leaves the schedule alone when a manual run finishes after waiting', async () => {
    const w = await createWorld(db, MON_1000);
    const id = await plan();
    w.chain.mines = (tx) => tx.data.startsWith('0x095ea7b3');
    const report = await runCycle(w.deps('live'), id, { manual: true });
    expect(report).toMatchObject({ status: 'awaiting_tx' });
    const cycleId = report.status === 'awaiting_tx' ? report.cycleId : -1;

    w.chain.mines = true;
    expect((await settleOutbox(w.deps('live'))).completed).toEqual([`${id}#${cycleId}`]);
    expect(await getCycle(db, cycleId)).toMatchObject({ state: 'done', outcomeKind: 'BOUGHT' });
    expect(await ledgerOf(cycleId)).toMatchObject({ status: 'spent' });
    expect((await getHolding(db, id, instrumentId))?.tokens).toBe(RECEIVED.toString());
    // A manual cycle never moves the plan's own slot.
    expect((await getPlan(db, id))?.nextDueAt).toMatch(/^2026-09-28 13:32/);
  });

  it('waits for a lagging node instead of calling a mined swap failed, then asks a human', async () => {
    const w: World = await createWorld(db, MON_1000);
    const id = await plan();
    w.chain.mines = (tx) => tx.data.startsWith('0x095ea7b3');
    const report = await runCycle(w.deps('live'), id);
    const cycleId = report.status === 'awaiting_tx' ? report.cycleId : -1;
    const hash = (report.status === 'awaiting_tx' ? report.txHash : '0x') as Hex;
    // The swap is mined, but this node does not return its receipt yet.
    w.chain.mines = true;
    await w.chain.waitForReceipt(hash, 1);
    const receipt = w.chain.receipt.bind(w.chain);
    w.chain.receipt = (h) => (h === hash ? Promise.resolve(undefined) : receipt(h));

    const lagging = await settleOutbox(w.deps('live'));
    expect(lagging.pending).toContain(hash);
    expect(lagging.needsHuman).toEqual([]);
    expect(await getCycle(db, cycleId)).toMatchObject({ state: 'awaiting_tx' });
    // Half an hour on, still no receipt: still PENDING (no new signing), and a human is asked.
    await db
      .update(txOutbox)
      .set({ createdAt: new Date(Date.now() - 31 * 60_000).toISOString() })
      .where(eq(txOutbox.txHash, hash));
    const stuck = await settleOutbox(w.deps('live'));
    expect(stuck.needsHuman.map((n) => n.txHash)).toEqual([hash]);
    expect(w.alerts.join('\n')).toContain('RUNBOOK §3.4');
    const [row] = await db.select().from(txOutbox).where(eq(txOutbox.txHash, hash));
    expect(row?.status).toBe('PENDING');
    expect(await runCycle(w.deps('live'), await plan())).toMatchObject({ status: 'outbox_busy' });

    // The node catches up: the buy is booked, once.
    w.chain.receipt = receipt;
    expect((await settleOutbox(w.deps('live'))).completed).toEqual([`${id}#${cycleId}`]);
    expect(await getCycle(db, cycleId)).toMatchObject({ outcomeKind: 'BOUGHT' });
    expect((await getHolding(db, id, instrumentId))?.tokens).toBe(RECEIVED.toString());
  });
});
