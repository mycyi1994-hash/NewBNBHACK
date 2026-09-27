/**
 * The worker's queues on Postgres: jobs claimed by exactly one worker, signed transactions recorded
 * with a nonce that is unique per sender (SPEC §5 v2, §5.8).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deletePlans,
  newCycle,
  testPlan,
  testDatabaseUrl as url,
  violatedConstraint,
} from '../test/helpers.js';
import {
  abandonRunningJobs,
  claimJob,
  createDb,
  enqueueJob,
  finishJob,
  getJob,
  insertPlan,
  lastOutboxNonce,
  markOutbox,
  recordSigned,
  unsettledOutbox,
} from './index.js';

const hex = (bytes: number) => `0x${randomBytes(bytes).toString('hex')}`;

describe.skipIf(!url)('jobs and tx_outbox on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const created: string[] = [];

  afterAll(async () => {
    await deletePlans(db, created);
    await close();
  });

  async function plan() {
    const row = await insertPlan(db, testPlan());
    created.push(row.id);
    return row;
  }

  it('hands each queued job to exactly one of several concurrent claimers, oldest first', async () => {
    const p = await plan();
    const ids = [`job-${randomUUID()}`, `job-${randomUUID()}`, `job-${randomUUID()}`];
    for (const id of ids)
      await enqueueJob(db, { id, kind: 'preview', planId: p.id, payload: { spendUsd: '5' } });

    const claims = await Promise.all(Array.from({ length: 5 }, () => claimJob(db, ['preview'])));
    const claimed = claims.filter((c) => c !== undefined);
    expect(claimed.map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(claimed.every((c) => c.status === 'running' && c.attempts === 1)).toBe(true);
    expect(await claimJob(db, ['preview'])).toBeUndefined();

    await finishJob(db, ids[0] ?? '', { status: 'done', result: { whyKey: 'why.bought.regular' } });
    await finishJob(db, ids[1] ?? '', { status: 'failed', error: 'quote 40401' });
    expect(await getJob(db, ids[0] ?? '')).toMatchObject({
      status: 'done',
      result: { whyKey: 'why.bought.regular' },
    });
    expect(await getJob(db, ids[1] ?? '')).toMatchObject({
      status: 'failed',
      error: 'quote 40401',
    });

    // A finish for a job that is no longer running (closed at boot) changes nothing.
    await finishJob(db, ids[1] ?? '', { status: 'done', result: {} });
    expect(await getJob(db, ids[1] ?? '')).toMatchObject({ status: 'failed' });
  });

  it('claims only the kinds asked for, and refuses unknown kinds and plans', async () => {
    const p = await plan();
    const id = `job-${randomUUID()}`;
    await enqueueJob(db, { id, kind: 'stop', planId: p.id });
    expect(await claimJob(db, ['run'])).toBeUndefined();
    expect(await claimJob(db, ['stop'])).toMatchObject({ id, payload: {} });
    expect(
      await violatedConstraint(
        enqueueJob(db, { id: `job-${randomUUID()}`, kind: 'withdraw', planId: p.id }),
      ),
    ).toBe('jobs_kind_ck');
    expect(
      await violatedConstraint(
        enqueueJob(db, { id: `job-${randomUUID()}`, kind: 'run', planId: 'nope' }),
      ),
    ).toBe('jobs_plan_id_plans_id_fk');
  });

  it('closes jobs a stopped worker left running, and leaves queued ones alone', async () => {
    const p = await plan();
    const running = `job-${randomUUID()}`;
    const queued = `job-${randomUUID()}`;
    await enqueueJob(db, { id: running, kind: 'run', planId: p.id });
    expect((await claimJob(db, ['run']))?.id).toBe(running);
    await enqueueJob(db, { id: queued, kind: 'preview', planId: p.id });
    // Every running job counts (the concurrency test above leaves some claimed).
    expect(
      await abandonRunningJobs(db, new Date(Date.now() + 1000), 'worker restarted'),
    ).toBeGreaterThanOrEqual(1);
    expect(await getJob(db, running)).toMatchObject({
      status: 'failed',
      error: 'worker restarted',
    });
    expect((await getJob(db, running))?.finishedAt).not.toBeNull();
    expect((await getJob(db, queued))?.status).toBe('queued');
    await claimJob(db, ['preview']); // leave the queue as other tests expect it
  });

  it('records a signed transaction before broadcast, one per sender nonce', async () => {
    const p = await plan();
    const cycleId = await newCycle(db, p.id);
    const from = hex(20);
    const signed = {
      planId: p.id,
      cycleId,
      kind: 'approve',
      chainId: 56,
      fromAddress: from,
      rawTx: hex(120),
    };

    expect(await lastOutboxNonce(db, 56, from)).toBeUndefined();
    const first = await recordSigned(db, { ...signed, nonce: 7, txHash: hex(32) });
    expect(first.status).toBe('SIGNED');
    expect(
      await violatedConstraint(recordSigned(db, { ...signed, nonce: 7, txHash: hex(32) })),
    ).toBe('tx_outbox_nonce_uq');
    // Signed but not broadcast yet: the nonce is not known to be used on chain.
    expect(await lastOutboxNonce(db, 56, from)).toBeUndefined();
    const second = await recordSigned(db, { ...signed, kind: 'swap', nonce: 8, txHash: hex(32) });

    await markOutbox(db, first.txHash, {
      status: 'PENDING',
      broadcastVia: 'transaction_api',
      attempted: true,
    });
    expect(await lastOutboxNonce(db, 56, from)).toBe(7);
    expect(await lastOutboxNonce(db, 56, from.toUpperCase().replace('0X', '0x'))).toBe(7);
    // Another chain has its own nonces.
    expect(await lastOutboxNonce(db, 97, from)).toBeUndefined();
    const pending = (await unsettledOutbox(db)).filter((r) => r.fromAddress === from);
    expect(pending.map((r) => [r.nonce, r.status, r.attempts])).toEqual([
      [7, 'PENDING', 1],
      [8, 'SIGNED', 0],
    ]);

    await markOutbox(db, first.txHash, { status: 'CONFIRMED' });
    await markOutbox(db, second.txHash, { status: 'FAILED', error: 'refused by every path' });
    expect((await unsettledOutbox(db)).filter((r) => r.fromAddress === from)).toEqual([]);
    expect(await violatedConstraint(markOutbox(db, second.txHash, { status: 'LOST' }))).toBe(
      'tx_outbox_status_ck',
    );

    // Never broadcast: its nonce is free again for the next transaction.
    const retry = await recordSigned(db, { ...signed, kind: 'swap', nonce: 8, txHash: hex(32) });
    expect(retry.nonce).toBe(8);
    expect(await lastOutboxNonce(db, 56, from)).toBe(7);
    await markOutbox(db, retry.txHash, { status: 'PENDING', broadcastVia: 'rpc', attempted: true });
    await markOutbox(db, retry.txHash, { status: 'FAILED', error: 'receipt status 0 (reverted)' });
    // A transaction mined as a failure did use its nonce.
    expect(await lastOutboxNonce(db, 56, from)).toBe(8);
    expect(
      await violatedConstraint(recordSigned(db, { ...signed, nonce: 8, txHash: hex(32) })),
    ).toBe('tx_outbox_nonce_uq');
  });
});
