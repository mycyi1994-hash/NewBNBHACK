/**
 * Sending and reconciling one transaction (SPEC §5.8, DECISIONS D-13/D-23) against the fake API
 * and chain, with the outbox on real Postgres: a broadcast that may have gone out is tracked, one
 * that certainly did not is released, and stale swap bytes the node lost are never sent again.
 */
import { encodeApprove } from '@yieldvest/chain';
import { createDb, lastOutboxNonce, txOutbox } from '@yieldvest/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTestUrl } from '../../test/db.js';
import { cleanup, HOUSE, ROUTER, signer } from '../../test/harness.js';
import { createWorld, testInstrument, testPlan, USDT, type World } from '../../test/world.js';
import { reconcileOutbox, sendTransaction, type SendDeps, type SendRequest } from './send.js';

const url = agentTestUrl;
const MON_1000 = '2026-09-28T14:00:00.000Z';

describe.skipIf(!url)('sending and reconciling on Postgres', () => {
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

  const sendDeps = (w: World): SendDeps => ({
    client: w.api.client,
    chain: w.chain,
    db,
    signer,
    log: (line) => w.lines.push(line),
  });

  async function request(kind: SendRequest['kind']): Promise<SendRequest> {
    const planId = await testPlan(db, ticker);
    planIds.push(planId);
    return {
      planId,
      cycleId: null,
      kind,
      to: kind === 'swap' ? ROUTER : USDT,
      data: kind === 'swap' ? '0xad43f73d' : encodeApprove(ROUTER, 1n),
      value: 0n,
      gas: 60_000n,
      gasPrice: 58_339_710n,
    };
  }

  /** Both broadcast paths fail: the Transaction API with 40431, the RPC with `rpcError`. */
  function failBroadcast(w: World, rpcError: string) {
    w.api.routes['/api/v1/dex/pre-transaction/broadcast-transaction'] = () => ({
      code: 40431,
      msg: 'Transaction broadcast failed, please check gas settings and retry',
    });
    w.chain.sendRaw = () => Promise.reject(new Error(rpcError));
  }

  const rowOf = async (hash: string) =>
    (await db.select().from(txOutbox).where(eq(txOutbox.txHash, hash)))[0];

  it('tracks bytes that may have gone out, and sends them again once the node is back', async () => {
    const w = await createWorld(db, MON_1000);
    const accept = w.chain.sendRaw.bind(w.chain);
    failBroadcast(w, 'request timed out after 10000ms');
    const result = await sendTransaction(sendDeps(w), await request('approve'));
    expect(result).toMatchObject({ state: 'pending', broadcastVia: 'unknown' });
    const hash = result.txHash;
    expect(await rowOf(hash)).toMatchObject({ status: 'PENDING', broadcastVia: 'unknown' });
    // Nothing new is signed while it is unclear.
    await expect(sendTransaction(sendDeps(w), await request('approve'))).rejects.toThrow(
      'unsettled outbox',
    );
    // The node never got them: reconciliation sends the same bytes again and they confirm.
    w.chain.sendRaw = accept;
    const settled = await reconcileOutbox(sendDeps(w), { from: HOUSE, waitMs: 1 });
    expect(settled).toMatchObject({ rebroadcast: [hash], confirmed: [hash], needsHuman: [] });
    expect(await rowOf(hash)).toMatchObject({ status: 'CONFIRMED' });
  });

  it('releases the nonce of bytes every node refused', async () => {
    const w = await createWorld(db, MON_1000);
    const before = await lastOutboxNonce(db, 56, HOUSE);
    failBroadcast(w, 'insufficient funds for gas * price + value');
    const result = await sendTransaction(sendDeps(w), await request('approve'));
    expect(result).toMatchObject({ state: 'not_sent' });
    expect(await rowOf(result.txHash)).toMatchObject({ status: 'FAILED', broadcastVia: null });
    // Never went out: the next transaction may use the same nonce.
    expect(await lastOutboxNonce(db, 56, HOUSE)).toBe(before);
  });

  it('calls "underpriced" final only when the Transaction API itself answered', async () => {
    const w = await createWorld(db, MON_1000);
    const accept = w.chain.sendRaw.bind(w.chain);
    // The API never answers (it may have relayed the bytes), and the node already holds a
    // transaction with this nonce — very likely ours: tracked, not released.
    w.api.routes['/api/v1/dex/pre-transaction/broadcast-transaction'] = () => {
      throw new Error('socket hang up');
    };
    w.chain.sendRaw = () => Promise.reject(new Error('replacement transaction underpriced'));
    // Bytes of their own (an earlier test's released nonce must not make the same hash).
    const unclear = await sendTransaction(sendDeps(w), {
      ...(await request('approve')),
      data: encodeApprove(ROUTER, 7n),
    });
    expect(unclear).toMatchObject({ state: 'pending', broadcastVia: 'unknown' });
    expect(await rowOf(unclear.txHash)).toMatchObject({ status: 'PENDING' });
    w.chain.sendRaw = accept;
    expect(await reconcileOutbox(sendDeps(w), { from: HOUSE, waitMs: 1 })).toMatchObject({
      confirmed: [unclear.txHash],
    });
    // The API answered with a refusal of its own: the node's "underpriced" settles it.
    failBroadcast(w, 'transaction underpriced');
    const refused = await sendTransaction(sendDeps(w), {
      ...(await request('approve')),
      data: encodeApprove(ROUTER, 8n),
    });
    expect(refused).toMatchObject({ state: 'not_sent' });
    expect(await rowOf(refused.txHash)).toMatchObject({ status: 'FAILED', broadcastVia: null });
  });

  it('never sends again swap bytes the node lost after their quote went stale', async () => {
    const w = await createWorld(db, MON_1000);
    const accept = w.chain.sendRaw.bind(w.chain);
    failBroadcast(w, 'socket hang up');
    const result = await sendTransaction(sendDeps(w), await request('swap'));
    expect(result).toMatchObject({ state: 'pending' });
    const hash = result.txHash;
    w.chain.sendRaw = accept;
    await db
      .update(txOutbox)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000).toISOString() })
      .where(eq(txOutbox.txHash, hash));
    const sentBefore = w.chain.sent.length;
    const settled = await reconcileOutbox(sendDeps(w), { from: HOUSE, waitMs: 1 });
    expect(settled.rebroadcast).toEqual([]);
    expect(settled.pending).toEqual([hash]);
    expect(settled.needsHuman).toMatchObject([{ txHash: hash }]);
    expect(w.chain.sent.length).toBe(sentBefore);
    expect(await rowOf(hash)).toMatchObject({ status: 'PENDING' });
    // What a human does after checking BscScan (RUNBOOK §3.4): it never went out.
    await db
      .update(txOutbox)
      .set({ status: 'FAILED', broadcastVia: null, error: 'dropped; not sent again (human)' })
      .where(eq(txOutbox.txHash, hash));
    expect(await reconcileOutbox(sendDeps(w), { from: HOUSE })).toMatchObject({ pending: [] });
  });
});
