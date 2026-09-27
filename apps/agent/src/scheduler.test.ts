/**
 * The worker tick end to end (M1-06, M2-06): scheduling across a weekend, the guardian's verdicts,
 * finishing a cycle whose swap confirmed late, and jobs from the web. Real Postgres (the agent
 * tests' own database), fake API and chain, public test key.
 */
import { randomUUID } from 'node:crypto';
import {
  createDb,
  enqueueJob,
  getJob,
  getPlan,
  guardianEvents,
  guardianSamples,
  insertGuardianSample,
  listCycles,
  listGuardianEvents,
  resolveGuardianEvents,
  updatePlan,
} from '@ijaro/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTestUrl } from '../test/db.js';
import { cleanup, ROUTER } from '../test/harness.js';
import { createWorld, testInstrument, testPlan } from '../test/world.js';
import { processJobs, schedulerTick } from './scheduler.js';

const url = agentTestUrl;
const MIN = 60_000;

describe.skipIf(!url)('schedulerTick on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const planIds: string[] = [];
  let ticker = '';
  let instrumentId = '';

  beforeAll(async () => {
    ({ ticker, instrumentId } = await testInstrument(db));
  });
  afterAll(async () => {
    await cleanup(db, planIds, [instrumentId]);
    await db.delete(guardianSamples);
    await db
      .delete(guardianEvents)
      .where(
        inArray(guardianEvents.rule, [
          'usdt_depeg',
          'tvl_drop',
          'protocol_paused',
          'utilization_high',
        ]),
      );
    await close();
  });

  async function plan(overrides: Record<string, unknown> = {}) {
    const id = await testPlan(db, ticker, overrides);
    planIds.push(id);
    return id;
  }

  /** Clears guardian history so each test starts calm. */
  async function calm() {
    await db.delete(guardianSamples);
    for (const rule of ['usdt_depeg', 'tvl_drop', 'protocol_paused', 'utilization_high']) {
      await resolveGuardianEvents(db, rule, new Date());
    }
  }

  it('defers over the weekend and buys by itself after Monday’s open (M1-06)', async () => {
    await calm();
    const id = await plan({ nextDueAt: '2026-09-26T13:32:00.000Z' }); // due Saturday
    const w = await createWorld(db, '2026-09-26T15:00:00.000Z'); // Sat 11:00 ET
    const live = w.deps('live');
    const sim = w.deps('simulate');

    const saturday = await schedulerTick(live, sim);
    expect(saturday.errors).toEqual([]);
    expect(saturday.cycles).toMatchObject([
      {
        status: 'done',
        planId: id,
        outcome: { kind: 'DEFERRED', reason: 'market_closed', retryAt: '2026-09-28T13:32:00.000Z' },
      },
    ]);
    // Sunday: not due, nothing runs.
    w.clock.advance(24 * 60 * MIN);
    expect((await schedulerTick(live, sim)).cycles.filter((c) => c.planId === id)).toEqual([]);
    // Monday 09:33 ET: due; the tick buys without anyone asking.
    w.clock.advance(Date.parse('2026-09-28T13:33:00Z') - w.clock.now());
    const monday = await schedulerTick(live, sim);
    expect(monday.cycles).toMatchObject([
      { status: 'done', planId: id, outcome: { kind: 'BOUGHT' } },
    ]);
    const cycles = await listCycles(db, { planIds: [id] });
    expect(cycles.map((c) => c.outcomeKind).sort()).toEqual(['BOUGHT', 'DEFERRED']);
    expect((await getPlan(db, id))?.nextDueAt).toMatch(/^2026-09-29 13:32/);
  });

  it('stops buying while USDT has been under 0.99 for 30 minutes, and resumes when it recovers', async () => {
    await calm();
    const id = await plan();
    const w = await createWorld(db, '2026-09-28T13:00:00.000Z'); // Mon 09:00 ET, before the open
    const live = w.deps('live');
    const sim = w.deps('simulate');
    w.market.usdtPrice = '0.985';
    await schedulerTick(live, sim); // 09:00: first sample under the peg
    w.clock.advance(35 * MIN); // 09:35: 35 minutes under → rule fires; the plan is due
    const depegged = await schedulerTick(live, sim);
    expect(depegged.guardian?.opened).toEqual(['usdt_depeg']);
    expect(depegged.cycles).toMatchObject([
      {
        planId: id,
        status: 'done',
        outcome: { kind: 'SKIPPED', reason: 'guardian', detail: 'usdt_depeg' },
        why: { key: 'why.skipped.guardian.hold' },
      },
    ]);
    expect(w.alerts.some((line) => line.includes('usdt_depeg'))).toBe(true);
    expect(w.chain.sent).toEqual([]);

    w.market.usdtPrice = '1.0002';
    const recovered = await schedulerTick(live, sim);
    expect(recovered.guardian?.resolved).toEqual(['usdt_depeg']);
    expect(await listGuardianEvents(db, { openOnly: true })).toEqual([]);
  });

  it('pauses yield plans on a 30 % TVL drop (simulate: nothing is redeemed)', async () => {
    await calm();
    const id = await plan({
      mode: 'yield',
      contributionUsd: '0',
      principalUsd: '100',
      vtokenUnits: '4700000000',
    });
    const w = await createWorld(db, '2026-09-28T13:00:00.000Z');
    await insertGuardianSample(db, {
      ts: '2026-09-27T13:00:00.000Z',
      metric: 'venus_tvl_usd',
      value: '1353914642',
      source: 'defi-data',
    });
    w.market.venusTvl = '900000000';
    const report = await schedulerTick(w.deps('simulate'), w.deps('simulate'));
    expect(report.guardian?.actions).toMatchObject([{ rule: 'tvl_drop', action: 'redeem_all' }]);
    expect(report.guardian?.paused).toContain(id);
    expect(await getPlan(db, id)).toMatchObject({
      status: 'paused',
      pausedReason: 'guardian:tvl_drop',
    });
  });

  it('finishes a cycle whose swap confirmed after the runner stopped waiting', async () => {
    await calm();
    const id = await plan();
    const w = await createWorld(db, '2026-09-28T14:00:00.000Z');
    // The approval mines, the swap does not (yet).
    w.chain.mines = (tx) => tx.to.toLowerCase() !== ROUTER.toLowerCase();
    const first = await schedulerTick(w.deps('live'), w.deps('simulate'));
    expect(first.cycles).toMatchObject([{ planId: id, status: 'awaiting_tx' }]);
    w.chain.mines = true;
    w.clock.advance(5 * MIN);
    const next = await schedulerTick(w.deps('live'), w.deps('simulate'));
    expect(next.reconciled?.confirmed).toHaveLength(1);
    expect(next.completed).toHaveLength(1);
    const [cycle] = await listCycles(db, { planIds: [id] });
    expect(cycle).toMatchObject({
      state: 'done',
      outcomeKind: 'BOUGHT',
      whyKey: 'why.bought.regular',
    });
  });

  it('picks up web jobs between ticks without running due plans', async () => {
    await calm();
    const due = await plan(); // due now: only a tick may run it
    const judged = await plan({ status: 'paused', pausedReason: 'awaiting_funding' });
    const w = await createWorld(db, '2026-09-28T14:00:00.000Z');
    await enqueueJob(db, { id: `job-poll-${judged}`, kind: 'preview', planId: judged });
    const polled = await processJobs(w.deps('live'), w.deps('simulate'));
    expect(polled).toEqual({
      jobs: [{ id: `job-poll-${judged}`, kind: 'preview', status: 'done' }],
      errors: [],
    });
    expect(await listCycles(db, { planIds: [due] })).toEqual([]);
    expect(w.chain.sent).toEqual([]);
    expect(await processJobs(w.deps('live'), w.deps('simulate'))).toEqual({ jobs: [], errors: [] });
    await updatePlan(db, due, { status: 'stopped' }); // later ticks must not buy it
  });

  it("never redeems a skill plan's position from the house wallet (stop job, guardian)", async () => {
    await calm();
    const skill = () =>
      plan({
        ownerKind: 'skill',
        ownerRef: `sk_${randomUUID()}`,
        walletAddress: '0x000000000000000000000000000000000000dEaD',
        mode: 'yield',
        contributionUsd: '0',
        principalUsd: '100',
        vtokenUnits: '4700000000',
      });
    const stopped = await skill();
    const w = await createWorld(db, '2026-09-28T14:00:00.000Z');
    await enqueueJob(db, { id: `job-skill-stop-${stopped}`, kind: 'stop', planId: stopped });
    await enqueueJob(db, { id: `job-skill-run-${stopped}`, kind: 'run', planId: stopped });
    await processJobs(w.deps('live'), w.deps('simulate'));
    expect(await getJob(db, `job-skill-stop-${stopped}`)).toMatchObject({
      status: 'done',
      result: { status: 'stopped', redeemed: 'users_wallet' },
    });
    expect(await getJob(db, `job-skill-run-${stopped}`)).toMatchObject({
      status: 'failed',
      error: 'skill plans run in their own wallet (GET /next)',
    });
    expect((await getPlan(db, stopped))?.status).toBe('stopped');

    // A 30 % TVL drop in live mode pauses the skill plan but redeems nothing for it. (House yield
    // plans from earlier tests would rightly be redeemed; stop them so only the skill plan is left.)
    for (const id of planIds) await updatePlan(db, id, { status: 'stopped' });
    const held = await skill();
    await insertGuardianSample(db, {
      ts: '2026-09-27T14:00:00.000Z',
      metric: 'venus_tvl_usd',
      value: '1353914642',
      source: 'defi-data',
    });
    w.market.venusTvl = '900000000';
    const report = await schedulerTick(w.deps('live'), w.deps('simulate'));
    expect(report.guardian?.paused).toContain(held);
    expect(report.guardian?.redeemed).not.toContain(held);
    expect(await getPlan(db, held)).toMatchObject({
      status: 'paused',
      pausedReason: 'guardian:tvl_drop',
    });
    expect(w.api.calls.filter((path) => path.includes('/defi/transaction'))).toEqual([]);
    expect(w.chain.sent).toEqual([]);
  });

  it('runs preview, run and stop jobs from the web; preview never signs', async () => {
    await calm();
    const id = await plan({ status: 'paused', pausedReason: 'awaiting_funding' });
    const w = await createWorld(db, '2026-09-28T14:00:00.000Z');
    await enqueueJob(db, { id: `job-p-${id}`, kind: 'preview', planId: id });
    const tick = await schedulerTick(w.deps('live'), w.deps('simulate'));
    expect(tick.jobs).toEqual([{ id: `job-p-${id}`, kind: 'preview', status: 'done' }]);
    expect(await getJob(db, `job-p-${id}`)).toMatchObject({
      status: 'done',
      result: { status: 'simulated' },
    });
    expect(w.chain.sent).toEqual([]);

    await enqueueJob(db, { id: `job-r-${id}`, kind: 'run', planId: id });
    await enqueueJob(db, { id: `job-s-${id}`, kind: 'stop', planId: id });
    await schedulerTick(w.deps('live'), w.deps('simulate'));
    expect(await getJob(db, `job-r-${id}`)).toMatchObject({
      status: 'done',
      result: { status: 'done', outcome: { kind: 'BOUGHT' } },
    });
    expect(await getJob(db, `job-s-${id}`)).toMatchObject({
      status: 'done',
      result: { status: 'stopped' },
    });
    expect((await getPlan(db, id))?.status).toBe('stopped');
  });
});
