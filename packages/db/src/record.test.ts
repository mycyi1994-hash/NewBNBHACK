/**
 * Writing on-chain effects (DECISIONS D-23): each receipt is applied once, in one transaction that
 * holds the plan row, so concurrent writers never lose an update and a replayed or re-spelled
 * hash changes nothing. Also the money CHECKs that back it and the compare-and-set plan update.
 */
import { randomBytes } from 'node:crypto';
import type { Instrument } from '@ijaro/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deletePlans,
  isolatedDay,
  newCycle,
  testPlan,
  testDatabaseUrl as url,
  violatedConstraint,
} from '../test/helpers.js';
import {
  applyDeposit,
  applyInterestRedeem,
  applyPositionRedeem,
  applySwap,
  createDb,
  getHolding,
  getPlan,
  holdings,
  insertPlan,
  listReceipts,
  reserveSpend,
  spendLedger,
  updatePlan,
  updatePlanIf,
  usdText,
  type ReceiptFacts,
} from './index.js';

const txHash = () => `0x${randomBytes(32).toString('hex')}`;
const E18 = 10n ** 18n;

const facts = (kind: ReceiptFacts['kind'], hash = txHash()): ReceiptFacts => ({
  kind,
  txHash: hash,
  broadcastVia: 'transaction_api',
  blockNumber: 123n,
  status: 'success',
  amounts: {},
});

const instrument: Instrument = {
  id: 'TREC:bstocks',
  ticker: 'TREC',
  issuer: 'bstocks',
  chainId: 56,
  address: '0x00000000000000000000000000000000000000b1',
  symbol: 'TRECB',
  decimals: 18,
  multiplier: '1',
  verifiedAt: '2026-09-24T00:00:00.000Z',
};

describe.skipIf(!url)('recording on-chain effects on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const created: string[] = [];

  afterAll(async () => {
    await deletePlans(db, created);
    await close();
  });

  async function plan(overrides: Parameters<typeof testPlan>[0] = {}) {
    const row = await insertPlan(db, testPlan(overrides));
    created.push(row.id);
    return row;
  }

  const yieldPlan = (overrides: Parameters<typeof testPlan>[0] = {}) =>
    plan({ mode: 'yield', contributionUsd: '0', status: 'paused', ...overrides });

  it('adds concurrent deposits up without losing one, and applies a replayed hash once', async () => {
    const p = await yieldPlan();
    const hashes = Array.from({ length: 8 }, () => txHash());
    const minted = { vTokens: 100n, usdtSpent: E18 };
    const results = await Promise.all(
      hashes.map((hash) => applyDeposit(db, p.id, facts('deposit', hash), minted)),
    );
    expect(results).toEqual(hashes.map(() => true));
    // The same deposit arriving twice at once (tick and command), and once more re-spelled.
    const again = await Promise.all([
      applyDeposit(db, p.id, facts('deposit', hashes[0]), minted),
      applyDeposit(db, p.id, facts('deposit', hashes[0]), minted),
      applyDeposit(
        db,
        p.id,
        facts('deposit', (hashes[1] ?? '').toUpperCase().replace('0X', '0x')),
        minted,
      ),
    ]);
    expect(again).toEqual([false, false, false]);
    const row = await getPlan(db, p.id);
    expect(usdText(row?.principalUsd ?? '')).toBe('8');
    expect(row?.vtokenUnits).toBe('800');
    const stored = await listReceipts(db, { planIds: [p.id], limit: 20 });
    expect(stored).toHaveLength(8);
    expect(stored.every((r) => r.txHash === r.txHash.toLowerCase())).toBe(true);
  });

  it('never lets an interest redeem and a deposit overwrite each other', async () => {
    const p = await yieldPlan({ principalUsd: '10', vtokenUnits: '1000' });
    await Promise.all([
      applyInterestRedeem(db, p.id, null, facts('redeem'), {
        usdtReceived: E18 / 2n,
        vTokensBurned: 50n,
      }),
      applyDeposit(db, p.id, facts('deposit'), { vTokens: 200n, usdtSpent: 2n * E18 }),
      applyInterestRedeem(db, p.id, null, facts('redeem'), {
        usdtReceived: E18 / 4n,
        vTokensBurned: 25n,
      }),
    ]);
    const row = await getPlan(db, p.id);
    expect(row?.vtokenUnits).toBe('1125');
    expect(usdText(row?.principalUsd ?? '')).toBe('12');
    expect(usdText(row?.harvestedUnspentUsd ?? '')).toBe('0.75');
  });

  it('redeems a whole position: paused, principal 0, only the excess counted as interest', async () => {
    const p = await yieldPlan({
      status: 'active',
      principalUsd: '10',
      vtokenUnits: '1001',
      harvestedUnspentUsd: '0.1',
    });
    const hash = txHash();
    const redeemed = { usdtReceived: (1025n * E18) / 100n, vTokensBurned: 1000n };
    expect(await applyPositionRedeem(db, p.id, facts('redeem', hash), redeemed)).toBe(true);
    expect(await applyPositionRedeem(db, p.id, facts('redeem', hash), redeemed)).toBe(false);
    const row = await getPlan(db, p.id);
    expect(row).toMatchObject({ status: 'paused', pausedReason: 'redeemed', vtokenUnits: '1' });
    expect(usdText(row?.principalUsd ?? '')).toBe('0');
    expect(usdText(row?.harvestedUnspentUsd ?? '')).toBe('0.35');

    // Below principal (a loss): no interest, principal still cleared; a stop keeps its status.
    const stopped = await yieldPlan({ status: 'stopped', principalUsd: '10', vtokenUnits: '1001' });
    await applyPositionRedeem(
      db,
      stopped.id,
      facts('redeem'),
      { usdtReceived: 9n * E18, vTokensBurned: 5000n },
      { status: 'stopped', pausedReason: 'expired' },
    );
    expect(await getPlan(db, stopped.id)).toMatchObject({
      status: 'stopped',
      pausedReason: 'expired',
      vtokenUnits: '0',
    });
    expect(usdText((await getPlan(db, stopped.id))?.harvestedUnspentUsd ?? '')).toBe('0');
  });

  it('settles a swap once: reservation spent, holding added, used interest taken out', async () => {
    const p = await yieldPlan({ principalUsd: '10', harvestedUnspentUsd: '3' });
    const cycleId = await newCycle(db, p.id);
    const reservation = await reserveSpend(db, {
      planId: p.id,
      ownerKind: p.ownerKind,
      ownerRef: p.ownerRef,
      day: isolatedDay(),
      caps: { globalDailyUsd: '50', planDailyUsd: '5' },
      cycleId,
      amountUsd: '5',
    });
    expect(reservation.ok).toBe(true);
    const hash = txHash();
    const swap = {
      planId: p.id,
      cycleId,
      facts: facts('swap', hash),
      instrument,
      receivedTokens: 2n * E18,
      spentUsd: '4.99',
      interestUsd: '5',
    };
    const [first, second] = await Promise.all([applySwap(db, swap), applySwap(db, swap)]);
    expect([first, second].sort()).toEqual([false, true]);
    const [ledger] = await db.select().from(spendLedger).where(eq(spendLedger.cycleId, cycleId));
    expect(ledger).toMatchObject({ status: 'spent' });
    expect(usdText(ledger?.amountUsd ?? '')).toBe('4.99');
    const holding = await getHolding(db, p.id, instrument.id);
    expect(holding).toMatchObject({ tokens: (2n * E18).toString(), shares: '2' });
    // 5 of interest used from 3 harvested: never below zero.
    expect(usdText((await getPlan(db, p.id))?.harvestedUnspentUsd ?? '')).toBe('0');
  });

  it('refuses negative vTokens and tokens, and a hash that is not lowercase', async () => {
    const p = await plan();
    expect(await violatedConstraint(updatePlan(db, p.id, { vtokenUnits: '-5' }))).toBe(
      'plans_vtokens_ck',
    );
    expect(
      await violatedConstraint(
        db.insert(holdings).values({
          planId: p.id,
          instrumentId: instrument.id,
          tokens: '-1',
          decimals: 18,
          multiplierAtLastUpdate: '1',
          shares: '0',
          costUsd: '0',
        }),
      ),
    ).toBe('holdings_tokens_ck');
    const upper = `0x${randomBytes(32).toString('hex').toUpperCase()}`;
    expect(
      await violatedConstraint(
        db.execute(
          sql`insert into receipts (plan_id, kind, tx_hash, explorer_url, chain_id, amounts, broadcast_via, status)
              values (${p.id}, 'approve', ${upper}, 'x', 56, '{}'::jsonb, 'rpc', 'success')`,
        ),
      ),
    ).toBe('receipts_tx_hash_ck');
  });

  it('changes a plan only while it is in the state the caller read', async () => {
    const p = await plan({ status: 'paused', pausedReason: 'awaiting_run' });
    const expected = { status: 'paused', pausedReason: 'awaiting_run' };
    // A review hold came in between: the activation must not undo it.
    await updatePlan(db, p.id, { pausedReason: 'needs_review' });
    expect(await updatePlanIf(db, p.id, expected, { status: 'active', pausedReason: null })).toBe(
      false,
    );
    expect(await getPlan(db, p.id)).toMatchObject({
      status: 'paused',
      pausedReason: 'needs_review',
    });
    await updatePlan(db, p.id, { pausedReason: 'awaiting_run' });
    expect(await updatePlanIf(db, p.id, expected, { status: 'active', pausedReason: null })).toBe(
      true,
    );
    expect(await getPlan(db, p.id)).toMatchObject({ status: 'active', pausedReason: null });
    expect(
      await updatePlanIf(db, p.id, { status: 'active', pausedReason: null }, { status: 'stopped' }),
    ).toBe(true);
  });
});
