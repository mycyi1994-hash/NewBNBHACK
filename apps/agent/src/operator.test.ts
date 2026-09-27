/**
 * The operator's redeem (pnpm yield:redeem, DECISIONS D-21): the preview changes nothing, the live
 * run signs only after the simulation passes, takes the whole position home and pauses the plan,
 * a late receipt is applied once from our own outbox, and a skill plan is never touched. Real
 * Postgres (the agent tests' database), fake API and chain, public test key.
 */
import { toUnits } from '@ijaro/core';
import {
  acquirePlanLock,
  createDb,
  getPlan,
  listReceipts,
  releasePlanLock,
  updatePlan,
} from '@ijaro/db';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTestUrl } from '../test/db.js';
import { cleanup, HOUSE } from '../test/harness.js';
import { createWorld, testInstrument, testPlan, withVenus } from '../test/world.js';
import { reconcileOutbox } from './executor/send.js';
import { operatorRedeem, previewOperatorRedeem, recordOperatorRedeem } from './operator.js';

const url = agentTestUrl;
const REDEEM_SELECTOR = '0xdb006a75';

describe.skipIf(!url)('operator redeem on Postgres', () => {
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

  /** A house yield plan with $1 of principal and $0.0005 of interest in Venus. */
  async function yieldPlan(overrides: Record<string, unknown> = {}) {
    const id = await testPlan(db, ticker, {
      mode: 'yield',
      contributionUsd: '0',
      cadence: 'weekly',
      principalUsd: '1',
      vtokenUnits: '100050000',
      ...overrides,
    });
    planIds.push(id);
    return id;
  }

  it('previews without signing or changing the plan, and refuses what it must not redeem', async () => {
    const w = await createWorld(db, '2026-09-28T14:00:00.000Z');
    withVenus(w);
    const id = await yieldPlan();
    const before = await getPlan(db, id);
    const preview = await previewOperatorRedeem(w.deps('simulate'), id);
    expect(preview).toMatchObject({
      kind: 'preview',
      amountUsd: '1.00049999',
      planVTokens: '100050000',
      principalUsd: '1',
      result: { kind: 'simulated', redeem: { status: 'SUCCESS' }, vTokens: 100_049_999n },
    });
    expect(await getPlan(db, id)).toEqual(before);
    expect(w.chain.sent).toEqual([]);

    const skill = await yieldPlan({
      ownerKind: 'skill',
      ownerRef: 'sk_operator_test',
      walletAddress: '0x000000000000000000000000000000000000dEaD',
    });
    const safe = await yieldPlan({ mode: 'safe', contributionUsd: '1', vtokenUnits: '0' });
    const empty = await yieldPlan({ vtokenUnits: '1' });
    for (const [planId, reason] of [
      ['T-missing', 'not_found'],
      [skill, 'users_wallet'],
      [safe, 'not_yield'],
      [empty, 'nothing_to_redeem'],
    ] as const) {
      expect(await previewOperatorRedeem(w.deps('simulate'), planId)).toEqual({
        kind: 'refused',
        reason,
      });
      expect(await operatorRedeem(w.deps('live'), planId)).toEqual({ kind: 'refused', reason });
    }
    expect(await operatorRedeem(w.deps('simulate'), id)).toEqual({
      kind: 'refused',
      reason: 'not_live',
    });
    await expect(previewOperatorRedeem(w.deps('live'), id)).rejects.toThrow('simulate deps');
    expect(w.api.calls.filter((p) => p.includes('/defi/transaction'))).toHaveLength(1);
    expect(w.chain.sent).toEqual([]);
  });

  it('redeems the whole position live, records it and pauses the plan (a stopped one stays stopped)', async () => {
    const w = await createWorld(db, '2026-09-28T14:00:00.000Z');
    withVenus(w);
    const id = await yieldPlan({ harvestedUnspentUsd: '0.1' });
    const result = await operatorRedeem(w.deps('live'), id);
    expect(result).toMatchObject({
      kind: 'redeemed',
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) as unknown,
      amounts: {
        amountUsd: '1.00049999',
        usdtReceived: '1000499990000000000',
        vTokensBurned: '100049999',
        reason: 'operator_redeem',
      },
    });
    expect(await getPlan(db, id)).toMatchObject({
      status: 'paused',
      pausedReason: 'operator_redeem',
      principalUsd: expect.stringMatching(/^0(\.0+)?$/) as unknown,
      vtokenUnits: '1',
      lockUntil: null,
    });
    // What came back above the principal is interest, kept for the plan's next buys.
    const row = await getPlan(db, id);
    expect(toUnits(row?.harvestedUnspentUsd ?? '', 18)).toBe(toUnits('0.10049999', 18));
    const [receipt] = await listReceipts(db, { planIds: [id], limit: 5 });
    expect(receipt).toMatchObject({ kind: 'redeem', status: 'success', cycleId: null });
    expect(w.chain.sent.map((tx) => tx.data.slice(0, 10))).toEqual([REDEEM_SELECTOR]);

    const stopped = await yieldPlan({ status: 'stopped' });
    expect(await operatorRedeem(w.deps('live'), stopped)).toMatchObject({ kind: 'redeemed' });
    expect(await getPlan(db, stopped)).toMatchObject({
      status: 'stopped',
      pausedReason: 'operator_redeem',
    });
  });

  it('signs nothing when the simulation fails, and waits for a running cycle', async () => {
    const w = await createWorld(db, '2026-09-28T14:00:00.000Z');
    const venus = withVenus(w);
    venus.redeemSimulation = { status: 'FAILED', failReason: 'execution reverted: math error' };
    const id = await yieldPlan();
    expect(await operatorRedeem(w.deps('live'), id)).toEqual({
      kind: 'failed',
      pausedReason: 'operator_redeem:redeem_failed',
      pending: [],
    });
    expect(w.chain.sent).toEqual([]);
    expect(w.alerts.join('\n')).toContain('operator_redeem: redeeming');
    const kept = await getPlan(db, id);
    expect(kept?.vtokenUnits).toBe('100050000');
    expect(toUnits(kept?.principalUsd ?? '', 18)).toBe(10n ** 18n);

    venus.redeemSimulation = { status: 'SUCCESS', failReason: '' };
    const now = new Date('2026-09-28T14:00:00.000Z');
    const held = await acquirePlanLock(db, id, now, 60_000);
    expect(held).toBeTruthy();
    expect(await operatorRedeem(w.deps('live'), id)).toEqual({ kind: 'refused', reason: 'locked' });
    await releasePlanLock(db, id, held?.lockUntil ?? null);
    expect(w.chain.sent).toEqual([]);
  });

  it('applies a redeem mined after the run stopped waiting, once, only from our outbox', async () => {
    const w = await createWorld(db, '2026-09-28T14:00:00.000Z');
    withVenus(w);
    const id = await yieldPlan();
    const other = await yieldPlan();
    w.chain.mines = false;
    const result = await operatorRedeem(w.deps('live'), id);
    expect(result).toMatchObject({
      kind: 'failed',
      pausedReason: 'operator_redeem:redeem_pending',
    });
    const pending = result.kind === 'failed' ? result.pending : [];
    expect(pending).toHaveLength(1);
    const hash = pending[0] as Hex;
    // One signer: nothing else signs while that transaction is out.
    expect(await operatorRedeem(w.deps('live'), other)).toEqual({
      kind: 'refused',
      reason: 'outbox_busy',
      pending,
    });

    w.chain.mines = true;
    await w.chain.waitForReceipt(hash, 1);
    const deps = w.deps('live');
    await expect(recordOperatorRedeem(deps, other, hash)).rejects.toThrow(
      'not a position redeem our outbox',
    );
    expect(await recordOperatorRedeem(deps, id, hash)).toBe('recorded');
    expect(await recordOperatorRedeem(deps, id, hash)).toBe('already_recorded');
    expect(await getPlan(db, id)).toMatchObject({
      status: 'paused',
      pausedReason: 'operator_redeem',
      vtokenUnits: '1',
    });
    expect(await reconcileOutbox(deps, { from: HOUSE })).toMatchObject({ confirmed: [hash] });
    await updatePlan(db, other, { status: 'stopped' });
  });
});
