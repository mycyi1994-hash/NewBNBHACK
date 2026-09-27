import type { Plan } from '@ijaro/core';
import { describe, expect, it } from 'vitest';
import { liveChecks, type LiveCheckFacts } from './live-check-rules.js';

const NOW = new Date('2026-09-28T13:00:00.000Z');
const E18 = 10n ** 18n;
const SAFE: Plan = {
  id: 'H-SAFE',
  owner: { kind: 'house' },
  mode: 'safe',
  target: { type: 'ticker', ticker: 'NVDA' },
  issuerPreference: ['bstocks', 'ondo'],
  principalUsd: '0',
  contributionUsd: '1',
  cadence: 'daily',
  window: 'regular_session',
  limits: { maxPerBuyUsd: '1', maxDailyUsd: '1' },
  status: 'paused',
  pausedReason: 'awaiting_funding',
  createdAt: '2026-09-24T00:00:00.000Z',
  nextDueAt: '2026-09-28T13:32:00.000Z',
};
const YIELD: Plan = {
  ...SAFE,
  id: 'H-YIELD',
  mode: 'yield',
  target: { type: 'ticker', ticker: 'QQQ' },
  contributionUsd: '0',
  cadence: 'weekly',
  limits: { maxPerBuyUsd: '5', maxDailyUsd: '5' },
};

function facts(overrides: Partial<LiveCheckFacts> = {}): LiveCheckFacts {
  return {
    now: NOW,
    testUsd: '1',
    config: {
      executionMode: 'simulate',
      minBuyUsd: '0.25',
      apiCredentials: true,
      houseKey: true,
      telegram: true,
    },
    safe: SAFE,
    yield: YIELD,
    unsettled: [],
    worker: {
      tick: { at: '2026-09-28T12:57:00.000Z', mode: 'simulate' },
      tapeSlotAt: '2026-09-28T12:50:00.000Z',
      venusVerifiedAt: '2026-09-28T09:00:00.000Z',
    },
    house: { usdtUnits: 5n * E18, bnbWei: 5n * 10n ** 15n },
    venus: { mintPaused: false, redeemPaused: false },
    guardian: [],
    registry: [
      { ticker: 'NVDA', issuer: 'bstocks', verifiedAt: '2026-09-28T00:00:00.000Z' },
      { ticker: 'NVDA', issuer: 'ondo', verifiedAt: '2026-09-28T00:00:00.000Z' },
      { ticker: 'QQQ', issuer: 'bstocks', verifiedAt: '2026-09-28T00:00:00.000Z' },
    ],
    apiCodes: ['0', '0', '40101'],
    ...overrides,
  };
}

const mark = (f: LiveCheckFacts, name: string) => liveChecks(f).checks.find((c) => c.name === name);

describe('liveChecks', () => {
  it('says GO when everything the $1 test needs holds', () => {
    const { checks, go } = liveChecks(facts());
    expect(go).toBe(true);
    expect(checks.map((c) => [c.name, c.mark])).toEqual([
      ['config', 'ok'],
      ['H-SAFE', 'ok'],
      ['H-YIELD', 'ok'],
      ['outbox', 'ok'],
      ['house', 'ok'],
      ['venus', 'ok'],
      ['guardian', 'ok'],
      ['registry', 'ok'],
      ['worker', 'ok'],
      ['tape', 'ok'],
      ['web3api', 'ok'],
    ]);
    expect(mark(facts(), 'house')?.detail).toBe('USDT 5.0000, BNB 0.0050');
    expect(mark(facts(), 'web3api')?.detail).toBe('2/3 calls with code 0 in the last hour');
  });

  it('refuses a test bigger than the plan it expects, or a minimum above it', () => {
    const big = facts({ safe: { ...SAFE, limits: { maxPerBuyUsd: '5', maxDailyUsd: '5' } } });
    expect(liveChecks(big).go).toBe(false);
    expect(mark(big, 'H-SAFE')?.detail).toContain(
      'pnpm plan:set --plan H-SAFE --contribution 1 --per-buy 1 --daily 1',
    );
    const contribution = facts({ safe: { ...SAFE, contributionUsd: '2' } });
    expect(mark(contribution, 'H-SAFE')?.mark).toBe('fail');
    const daily = facts({ safe: { ...SAFE, limits: { maxPerBuyUsd: '1', maxDailyUsd: '3' } } });
    expect(mark(daily, 'H-SAFE')?.mark).toBe('fail');
    const minimum = facts({ config: { ...facts().config, minBuyUsd: '2' } });
    expect(mark(minimum, 'config')).toMatchObject({ mark: 'fail' });
    expect(mark(minimum, 'config')?.detail).toContain('is above the $1 test');
    // A $5 test with a $5 plan and $12.50 in the wallet is fine.
    const five = facts({
      testUsd: '5',
      safe: { ...SAFE, contributionUsd: '5', limits: { maxPerBuyUsd: '5', maxDailyUsd: '5' } },
      house: { usdtUnits: 13n * E18, bnbWei: 5n * 10n ** 15n },
    });
    expect(liveChecks(five).go).toBe(true);
  });

  it('needs the credentials and the house key where it runs', () => {
    const bare = facts({
      config: { ...facts().config, apiCredentials: false, houseKey: false },
      house: undefined,
    });
    expect(mark(bare, 'config')?.detail).toBe(
      'missing here: Binance Web3 API key/secret, house key — run the live steps on the worker machine',
    );
    expect(mark(bare, 'house')).toMatchObject({
      mark: 'fail',
      detail: 'no house key: balances unknown',
    });
    const noApi = facts({ config: { ...facts().config, apiCredentials: false } });
    expect(mark(noApi, 'config')?.detail).toContain('missing here: Binance Web3 API key/secret —');
    const noHouse = facts({ config: { ...facts().config, houseKey: false } });
    expect(mark(noHouse, 'config')?.detail).toContain('missing here: house key —');
  });

  it('refuses while a transaction is unsettled, the guardian holds, or the API blocks the region', () => {
    expect(liveChecks(facts({ unsettled: ['0xabc'] })).go).toBe(false);
    const held = facts({ guardian: [{ rule: 'tvl_drop', action: 'redeem_all' }] });
    expect(mark(held, 'guardian')).toMatchObject({
      mark: 'fail',
      detail: 'open: tvl_drop (redeem_all)',
    });
    expect(mark(facts({ guardian: [{ rule: 'x', action: 'warn' }] }), 'guardian')?.mark).toBe('ok');
    const region = facts({ apiCodes: ['0', '40303', '40303'] });
    expect(mark(region, 'web3api')).toMatchObject({ mark: 'fail' });
    expect(mark(region, 'web3api')?.detail).toContain('40303 — stop');
  });

  it('checks the house balances against the test, the gas and the $300 limit', () => {
    const house = (usdt: bigint, bnb: bigint) =>
      mark(facts({ house: { usdtUnits: usdt, bnbWei: bnb } }), 'house');
    expect(house(19n * 10n ** 17n, 5n * 10n ** 15n)?.mark).toBe('fail');
    expect(house(5n * E18, 9n * 10n ** 14n)?.mark).toBe('fail');
    expect(house(2n * E18, 5n * 10n ** 15n)?.mark).toBe('warn');
    expect(house(5n * E18, 2n * 10n ** 15n)?.mark).toBe('warn');
    expect(house(301n * E18, 5n * 10n ** 15n)?.detail).toContain('$300 house balance limit');
    expect(mark(facts({ house: { error: 'rpc unreachable' } }), 'house')).toMatchObject({
      mark: 'fail',
      detail: 'balances unreadable (rpc unreachable)',
    });
  });

  it('refuses a paused Venus market and warns when its state is unknown', () => {
    const paused = facts({ venus: { mintPaused: true, redeemPaused: true } });
    expect(mark(paused, 'venus')).toMatchObject({
      mark: 'fail',
      detail: 'mint and redeem paused on chain',
    });
    expect(mark(facts({ venus: { mintPaused: false, redeemPaused: true } }), 'venus')?.detail).toBe(
      'redeem paused on chain',
    );
    expect(mark(facts({ venus: undefined }), 'venus')?.mark).toBe('warn');
    expect(mark(facts({ venus: { error: 'no vToken' } }), 'venus')?.mark).toBe('warn');
  });

  it('refuses missing plans or an unlisted ticker, and warns on old or missing worker data', () => {
    const empty = facts({ safe: undefined, yield: undefined });
    expect(mark(empty, 'H-SAFE')?.mark).toBe('fail');
    expect(mark(empty, 'H-YIELD')?.mark).toBe('fail');
    expect(mark(empty, 'registry')?.detail).toContain('?:');
    expect(mark(facts({ registry: [] }), 'registry')?.mark).toBe('fail');
    const old = facts({
      registry: [{ ticker: 'NVDA', issuer: 'bstocks', verifiedAt: '2026-09-25T00:00:00.000Z' }],
    });
    expect(mark(old, 'registry')).toMatchObject({ mark: 'warn' });
    expect(mark(old, 'registry')?.detail).toContain('verified 85 h ago');
    const quiet = facts({ worker: {}, apiCodes: [] });
    expect(mark(quiet, 'worker')).toMatchObject({ mark: 'warn', detail: 'no tick recorded' });
    expect(mark(quiet, 'tape')).toMatchObject({ mark: 'warn', detail: 'no tape run recorded' });
    expect(mark(quiet, 'web3api')?.mark).toBe('warn');
    expect(liveChecks(quiet).go).toBe(true);
    const stale = facts({
      worker: {
        tick: { at: '2026-09-28T12:00:00.000Z', mode: 'simulate' },
        tapeSlotAt: '2026-09-28T12:00:00.000Z',
      },
    });
    expect(mark(stale, 'worker')?.detail).toBe('last tick 60 min ago, mode simulate');
    expect(mark(stale, 'tape')?.mark).toBe('warn');
  });

  it('warns when a live worker would buy on schedule, and without Telegram', () => {
    const { pausedReason: _reason, ...running } = SAFE;
    const scheduled = facts({
      safe: { ...running, status: 'active' },
      worker: { ...facts().worker, tick: { at: '2026-09-28T12:57:00.000Z', mode: 'live' } },
      config: { ...facts().config, telegram: false },
    });
    expect(mark(scheduled, 'H-SAFE')?.detail).toMatch(/^active, \$1 daily, .* buys on schedule$/);
    expect(mark(scheduled, 'alerts')?.mark).toBe('warn');
    expect(liveChecks(scheduled).go).toBe(true);
  });
});
