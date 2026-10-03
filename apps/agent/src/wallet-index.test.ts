/**
 * The Wallet API beside the chain (DECISIONS D-34), on Postgres with the fake API: each fresh
 * receipt gets the Wallet API's status once it is final, agreeing with its BSC receipt or not; a
 * receipt not indexed yet, or pending, is asked about again; an API failure records nothing; the
 * house balances are written beside the chain read and compared with it.
 */
import { randomBytes } from 'node:crypto';
import { createDb, insertReceipt, readWorkerStatus, receiptByHash } from '@yieldvest/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTestUrl } from '../test/db.js';
import { cleanup } from '../test/harness.js';
import { createWorld, testInstrument, testPlan, USDT } from '../test/world.js';
import { houseViaWalletApi, indexReceipts } from './wallet-index.js';

const url = agentTestUrl;
const DETAIL = '/api/v1/dex/post-transaction/transaction-detail-by-txhash';
const BALANCES = '/api/v1/dex/balance/token-balances-by-address';
const hash = () => `0x${randomBytes(32).toString('hex')}`;

describe.skipIf(!url)('the Wallet API beside the chain (D-34) on Postgres', () => {
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

  it('records each fresh receipt’s Wallet API status, and asks again until it is final', async () => {
    // Far from every other test's receipts, so the window below holds only these.
    const start = '2033-04-05T14:00:00.000Z';
    const w = await createWorld(db, start);
    const deps = w.deps('simulate');
    const planId = await testPlan(db, ticker);
    planIds.push(planId);
    const hoursAgo = (h: number) => new Date(Date.parse(start) - h * 3_600_000).toISOString();
    const tx = {
      agrees: hash(),
      disagrees: hash(),
      notIndexed: hash(),
      pending: hash(),
      apiDown: hash(),
      old: hash(),
    };
    const receipt = (txHash: string, status: string, createdAt: string) =>
      insertReceipt(db, {
        planId,
        cycleId: null,
        kind: 'swap',
        txHash,
        explorerUrl: `https://bscscan.com/tx/${txHash}`,
        chainId: 56,
        amounts: {},
        broadcastVia: 'transaction_api',
        status,
        createdAt,
      });
    await receipt(tx.agrees, 'success', hoursAgo(1));
    await receipt(tx.disagrees, 'failed', hoursAgo(2));
    await receipt(tx.notIndexed, 'success', hoursAgo(3));
    await receipt(tx.pending, 'success', hoursAgo(4));
    await receipt(tx.apiDown, 'success', hoursAgo(5));
    await receipt(tx.old, 'success', hoursAgo(25));

    const asked: string[] = [];
    let indexedLater = false;
    w.api.routes[DETAIL] = (u) => {
      const h = u.searchParams.get('txHash') ?? '';
      asked.push(h);
      if (h === tx.agrees) return [{ txStatus: 'success', txFee: '0.0000123', height: '9001' }];
      if (h === tx.disagrees) return [{ txStatus: 'success', txFee: '0.0000123', height: '9002' }];
      if (h === tx.notIndexed)
        return indexedLater ? [{ txStatus: 'success', txFee: '0.00001', height: '9003' }] : [];
      if (h === tx.pending) return [{ txStatus: 'pending' }];
      return { code: 50001, msg: 'Service temporarily unavailable, please retry later' };
    };

    expect(await indexReceipts(deps)).toEqual({ asked: 5, recorded: 4 });
    const index = async (h: string) => (await receiptByHash(db, h))?.indexed;
    const checkedAt = start;
    expect(await index(tx.agrees)).toEqual({
      state: 'indexed',
      txStatus: 'success',
      txFee: '0.0000123',
      height: '9001',
      agrees: true,
      checkedAt,
    });
    expect(await index(tx.disagrees)).toMatchObject({ txStatus: 'success', agrees: false });
    expect(w.lines.join('\n')).toMatch(
      /is "success" in the Wallet API but "failed" by its BSC receipt — the receipt stays the record/,
    );
    expect(await index(tx.notIndexed)).toEqual({ state: 'not_indexed', tries: 1, checkedAt });
    expect(await index(tx.pending)).toMatchObject({ txStatus: 'pending', agrees: null });
    expect(await index(tx.apiDown)).toBeNull();
    expect(w.lines.join('\n')).toMatch(/transaction detail of 0x[0-9a-f]{64} not read/);
    // A day old: out of the window, never asked.
    expect(asked).not.toContain(tx.old);
    expect(await index(tx.old)).toBeNull();

    // The next tick asks only about what is not final yet.
    asked.length = 0;
    indexedLater = true;
    expect(await indexReceipts(deps)).toEqual({ asked: 3, recorded: 2 });
    // The 50001 is retried by the client (twice), so that hash is asked three times.
    expect([...new Set(asked)].sort()).toEqual([tx.notIndexed, tx.pending, tx.apiDown].sort());
    expect(await index(tx.notIndexed)).toMatchObject({ txStatus: 'success', agrees: true });
  });

  it('writes the house balances as the Wallet API reports them, compared with the chain', async () => {
    const w = await createWorld(db, '2033-04-06T14:00:00.000Z');
    const deps = w.deps('simulate');
    const usdt = 10n ** 21n;
    const bnb = 2n * 10n ** 16n;
    let sent: unknown;
    w.api.routes[BALANCES] = (_u, body) => {
      sent = body;
      return [
        {
          tokenAssets: [
            { tokenContractAddress: USDT.toLowerCase(), rawBalance: usdt.toString() },
            { tokenContractAddress: '', rawBalance: bnb.toString() },
          ],
        },
      ];
    };
    await houseViaWalletApi(deps, { usdt, bnb });
    expect(sent).toMatchObject({
      tokenContractAddresses: [
        { binanceChainId: '56', tokenContractAddress: USDT },
        { binanceChainId: '56', tokenContractAddress: '' },
      ],
    });
    expect((await readWorkerStatus(db, 'house_index'))?.value).toEqual({
      usdtUnits: usdt.toString(),
      bnbWei: bnb.toString(),
      agrees: { usdt: true, bnb: true },
      at: '2033-04-06T14:00:00.000Z',
    });

    await houseViaWalletApi(deps, { usdt: usdt + 1n, bnb });
    expect((await readWorkerStatus(db, 'house_index'))?.value).toMatchObject({
      agrees: { usdt: false, bnb: true },
    });
    expect(w.lines.join('\n')).toMatch(
      /house balances differ from the chain \(usdt false, bnb true\)/,
    );

    // Without the chain's read there is nothing to compare with.
    await houseViaWalletApi(deps, undefined);
    expect((await readWorkerStatus(db, 'house_index'))?.value).toMatchObject({
      agrees: { usdt: null, bnb: null },
    });

    w.api.routes[BALANCES] = () => ({ code: 50001, msg: 'Service temporarily unavailable' });
    await houseViaWalletApi(deps, { usdt, bnb });
    expect((await readWorkerStatus(db, 'house_index'))?.value).toEqual({
      error: 'not read',
      at: '2033-04-06T14:00:00.000Z',
    });
  });
});
