/**
 * Sending and reconciling one transaction (SPEC §5.8, DECISIONS D-13/D-23) against the fake API
 * and chain, with the outbox on real Postgres: a broadcast that may have gone out is tracked, one
 * that certainly did not is released, and stale swap bytes the node lost are never sent again.
 */
import { encodeApprove, signableTx } from '@yieldvest/chain';
import {
  acquirePlanLock,
  createDb,
  lastOutboxNonce,
  markOutbox,
  recordSigned,
  releasePlanLock,
  txOutbox,
} from '@yieldvest/db';
import { eq } from 'drizzle-orm';
import { keccak256 } from 'viem';
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
    // A server error of the API's own (50000/50001) can come after it relayed the bytes: with the
    // node's "underpriced", that is not proof they never went out — tracked, not released.
    w.api.routes['/api/v1/dex/pre-transaction/broadcast-transaction'] = () => ({
      code: 50000,
      msg: 'Internal server error',
    });
    w.chain.sendRaw = () => Promise.reject(new Error('transaction underpriced'));
    const serverError = await sendTransaction(sendDeps(w), {
      ...(await request('approve')),
      data: encodeApprove(ROUTER, 10n),
    });
    expect(serverError).toMatchObject({ state: 'pending', broadcastVia: 'unknown' });
    expect(await rowOf(serverError.txHash)).toMatchObject({ status: 'PENDING' });
    w.chain.sendRaw = accept;
    expect(await reconcileOutbox(sendDeps(w), { from: HOUSE, waitMs: 1 })).toMatchObject({
      confirmed: [serverError.txHash],
    });
  });

  it('tells a human about bytes the node still refuses to hold half an hour after signing', async () => {
    const w = await createWorld(db, MON_1000);
    // The API timed out; the RPC node turns the bytes away for its own policy, every time.
    w.api.routes['/api/v1/dex/pre-transaction/broadcast-transaction'] = () => {
      throw new Error('socket hang up');
    };
    w.chain.sendRaw = () => Promise.reject(new Error('transaction underpriced'));
    const result = await sendTransaction(sendDeps(w), {
      ...(await request('approve')),
      data: encodeApprove(ROUTER, 9n),
    });
    expect(result).toMatchObject({ state: 'pending' });
    const hash = result.txHash;
    // Young: sent again and waited for, no human yet.
    const early = await reconcileOutbox(sendDeps(w), { from: HOUSE, waitMs: 1 });
    expect(early).toMatchObject({ rebroadcast: [hash], pending: [hash], needsHuman: [] });
    await db
      .update(txOutbox)
      .set({ createdAt: new Date(Date.now() - 31 * 60_000).toISOString() })
      .where(eq(txOutbox.txHash, hash));
    const late = await reconcileOutbox(sendDeps(w), { from: HOUSE, waitMs: 1 });
    expect(late.pending).toEqual([hash]);
    expect(late.needsHuman).toEqual([
      {
        txHash: hash,
        reason:
          'approve not held by the node 31 min after signing; the resend was refused (transaction underpriced)',
      },
    ]);
    // Still PENDING: nothing new is signed until a human settles it.
    expect(await rowOf(hash)).toMatchObject({ status: 'PENDING' });
    await db
      .update(txOutbox)
      .set({ status: 'FAILED', broadcastVia: null, error: 'never went out (human)' })
      .where(eq(txOutbox.txHash, hash));
  });

  it('tells a human about bytes the node holds but nobody mines half an hour after signing', async () => {
    const w = await createWorld(db, MON_1000);
    // Broadcast and held in the mempool, under the validators' gas floor: never mined.
    w.chain.mines = false;
    const result = await sendTransaction(sendDeps(w), {
      ...(await request('approve')),
      data: encodeApprove(ROUTER, 10n),
    });
    expect(result).toMatchObject({ state: 'pending' });
    const hash = result.txHash;
    expect(await reconcileOutbox(sendDeps(w), { from: HOUSE, waitMs: 1 })).toMatchObject({
      pending: [hash],
      needsHuman: [],
    });
    await db
      .update(txOutbox)
      .set({ createdAt: new Date(Date.now() - 31 * 60_000).toISOString() })
      .where(eq(txOutbox.txHash, hash));
    const late = await reconcileOutbox(sendDeps(w), { from: HOUSE, waitMs: 1 });
    expect(late.rebroadcast).toEqual([]);
    expect(late.needsHuman).toEqual([
      { txHash: hash, reason: 'approve held by the node but not mined 31 min after signing' },
    ]);
    // A human replaces or drops it (RUNBOOK §3.4); until then it stays PENDING.
    expect(await rowOf(hash)).toMatchObject({ status: 'PENDING' });
    await db
      .update(txOutbox)
      .set({ status: 'FAILED', broadcastVia: null, error: 'replaced (human)' })
      .where(eq(txOutbox.txHash, hash));
  });

  /** Bytes another process signed and wrote down (SIGNED), from a sender of their own. */
  async function signedElsewhere(req: SendRequest) {
    const sender = '0x000000000000000000000000000000000000dEaD';
    const nonce = 1_000_000 + (Date.now() % 1_000_000_000);
    const raw = await signer.sign(
      signableTx({
        to: req.to,
        data: req.data,
        value: 0n,
        gas: req.gas,
        gasPrice: req.gasPrice,
        nonce,
      }),
    );
    const hash = keccak256(raw);
    await recordSigned(db, {
      planId: req.planId,
      cycleId: null,
      kind: req.kind,
      chainId: 56,
      fromAddress: sender,
      nonce,
      rawTx: raw,
      txHash: hash,
    });
    return { sender, nonce, hash };
  }

  it('leaves a row to the process holding its plan’s lock: never sent around its broadcast', async () => {
    const w = await createWorld(db, MON_1000);
    const req = await request('approve');
    // A live command (cycle:once, yield:deposit, yield:redeem) holds the plan's lock, has written
    // its bytes down and is waiting for the Transaction API, while the worker's tick settles.
    const lock = await acquirePlanLock(db, req.planId, new Date(), 60_000);
    if (!lock?.lockUntil) throw new Error('no lock');
    const { sender, hash } = await signedElsewhere(req);
    const sentBefore = w.chain.sent.length;
    expect(await reconcileOutbox(sendDeps(w), { from: sender, waitMs: 1 })).toMatchObject({
      pending: [hash],
      rebroadcast: [],
      confirmed: [],
    });
    expect(w.chain.sent.length).toBe(sentBefore);
    expect(await rowOf(hash)).toMatchObject({ status: 'SIGNED' });
    expect(w.lines.join('\n')).toMatch(/left to it/);
    // The command's broadcast is refused for compliance: final (D-13) — nothing went out meanwhile.
    expect(
      await markOutbox(db, hash, { status: 'FAILED', error: 'refused: 40301' }, ['SIGNED']),
    ).toBe(true);
    await releasePlanLock(db, req.planId, lock.lockUntil);
    expect(await reconcileOutbox(sendDeps(w), { from: sender, waitMs: 1 })).toMatchObject({
      pending: [],
      rebroadcast: [],
    });
    expect(w.chain.sent.length).toBe(sentBefore);
  });

  it('settles the row of a process that died once its lock has lapsed', async () => {
    const w = await createWorld(db, MON_1000);
    const req = await request('approve');
    const lapsed = await acquirePlanLock(db, req.planId, new Date(Date.now() - 120_000), 60_000);
    if (!lapsed) throw new Error('no lock');
    const { sender, hash } = await signedElsewhere(req);
    expect(await reconcileOutbox(sendDeps(w), { from: sender, waitMs: 1 })).toMatchObject({
      rebroadcast: [hash],
      confirmed: [hash],
    });
    expect(await rowOf(hash)).toMatchObject({ status: 'CONFIRMED' });
  });

  it('never writes over a status another process recorded while it read the chain', async () => {
    const w = await createWorld(db, MON_1000);
    const { sender, nonce, hash } = await signedElsewhere(await request('approve'));
    // The node holds the bytes; while the worker reads the chain, the sender settles the row.
    w.chain.minedNonce = async () => {
      await markOutbox(db, hash, { status: 'CONFIRMED' });
      return nonce;
    };
    w.chain.pendingNonce = () => Promise.resolve(nonce + 1);
    await reconcileOutbox(sendDeps(w), { from: sender, waitMs: 1 });
    // Before: the worker's "PENDING" landed on the CONFIRMED row, and the sender's next
    // transaction met an unsettled outbox.
    expect(await rowOf(hash)).toMatchObject({ status: 'CONFIRMED' });
    expect(await markOutbox(db, hash, { status: 'PENDING' }, ['SIGNED', 'PENDING'])).toBe(false);
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
