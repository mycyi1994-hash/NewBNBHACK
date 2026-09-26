/** Row → domain mapping (no database): exact money text, strict unions, ISO timestamps. */
import { describe, expect, it } from 'vitest';
import {
  cycleOutcomeFromJson,
  instrumentFromRow,
  isoTime,
  planFromRow,
  usdText,
  type InstrumentRow,
  type PlanRow,
} from './index.js';

const planRow: PlanRow = {
  id: 'J-1',
  ownerKind: 'judge',
  ownerRef: 'c0ffee',
  walletAddress: null,
  mode: 'safe',
  ticker: 'NVDA',
  issuerPreference: ['bstocks', 'ondo'],
  principalUsd: '0.000000000000000000',
  contributionUsd: '5.000000000000000000',
  harvestedUnspentUsd: '0.000000000000000000',
  cadence: 'once',
  window: 'anytime',
  maxPerBuyUsd: '5.000000000000000000',
  maxDailyUsd: '5.000000000000000000',
  status: 'active',
  pausedReason: null,
  createdAt: '2026-09-28 13:00:00.123+00',
  nextDueAt: '2026-09-28 13:32:00+00',
  expiresAt: '2026-10-05 13:00:00+00',
  lockUntil: null,
};

const instrumentRow: InstrumentRow = {
  id: 'NVDA:bstocks',
  ticker: 'NVDA',
  issuer: 'bstocks',
  platformId: 'bstock',
  chainId: 56,
  address: '0x00000000000000000000000000000000000000b1',
  symbol: 'NVDAB',
  decimals: 18,
  assetType: 1,
  multiplier: '1',
  multiplierSource: 'onchain',
  apiShareRatio: '1',
  verifiedAt: '2026-09-24 01:00:00+00',
};

describe('usdText', () => {
  it('trims numeric(38,18) padding without rounding', () => {
    expect(usdText('5.000000000000000000')).toBe('5');
    expect(usdText('0.250000000000000000')).toBe('0.25');
    expect(usdText('0.000000000000000001')).toBe('0.000000000000000001');
    expect(usdText('0')).toBe('0');
  });
});

describe('isoTime', () => {
  it('turns Postgres timestamptz text into ISO 8601', () => {
    expect(isoTime('2026-09-28 13:32:00+00')).toBe('2026-09-28T13:32:00.000Z');
    expect(isoTime('2026-09-28 22:32:00+09')).toBe('2026-09-28T13:32:00.000Z');
    expect(() => isoTime('soon')).toThrow(/not a timestamp/);
  });
});

describe('planFromRow', () => {
  it('maps a row to the SPEC §4 Plan', () => {
    expect(planFromRow(planRow)).toEqual({
      id: 'J-1',
      owner: { kind: 'judge', code: 'c0ffee' },
      mode: 'safe',
      target: { type: 'ticker', ticker: 'NVDA' },
      issuerPreference: ['bstocks', 'ondo'],
      principalUsd: '0',
      contributionUsd: '5',
      cadence: 'once',
      window: 'anytime',
      limits: { maxPerBuyUsd: '5', maxDailyUsd: '5' },
      status: 'active',
      createdAt: '2026-09-28T13:00:00.123Z',
      nextDueAt: '2026-09-28T13:32:00.000Z',
      expiresAt: '2026-10-05T13:00:00.000Z',
    });
    expect(planFromRow({ ...planRow, ownerKind: 'house', ownerRef: null }).owner).toEqual({
      kind: 'house',
    });
    expect(planFromRow({ ...planRow, ownerKind: 'skill', ownerRef: 'sk_1' }).owner).toEqual({
      kind: 'skill',
      token: 'sk_1',
    });
    expect(
      planFromRow({ ...planRow, status: 'paused', pausedReason: 'awaiting_funding' }),
    ).toMatchObject({
      status: 'paused',
      pausedReason: 'awaiting_funding',
    });
  });

  it('refuses values outside the domain instead of guessing', () => {
    expect(() => planFromRow({ ...planRow, mode: 'margin' })).toThrow(/plans.mode/);
    expect(() => planFromRow({ ...planRow, issuerPreference: ['bstocks', 'robinhood'] })).toThrow(
      /plans.issuer_preference/,
    );
    expect(() => planFromRow({ ...planRow, ownerRef: null })).toThrow(/owner_ref/);
    expect(() => planFromRow({ ...planRow, ownerKind: 'friend' })).toThrow(/owner_kind/);
    expect(() => planFromRow({ ...planRow, cadence: 'hourly' })).toThrow(/plans.cadence/);
    expect(() => planFromRow({ ...planRow, window: 'always' })).toThrow(/plans.window/);
    expect(() => planFromRow({ ...planRow, status: 'deleted' })).toThrow(/plans.status/);
  });
});

describe('instrumentFromRow', () => {
  it('maps a verified BSC registry row', () => {
    expect(instrumentFromRow(instrumentRow)).toEqual({
      id: 'NVDA:bstocks',
      ticker: 'NVDA',
      issuer: 'bstocks',
      chainId: 56,
      address: '0x00000000000000000000000000000000000000b1',
      symbol: 'NVDAB',
      decimals: 18,
      multiplier: '1',
      verifiedAt: '2026-09-24T01:00:00.000Z',
    });
  });

  it('refuses another chain, a malformed address or an unknown issuer', () => {
    expect(() => instrumentFromRow({ ...instrumentRow, chainId: 1 })).toThrow(/chain_id/);
    expect(() => instrumentFromRow({ ...instrumentRow, address: '0x1234' })).toThrow(/address/);
    expect(() => instrumentFromRow({ ...instrumentRow, issuer: 'acme' })).toThrow(/issuer/);
  });
});

describe('cycleOutcomeFromJson', () => {
  it('accepts a stored outcome and rejects anything without a known kind', () => {
    const skipped = { kind: 'SKIPPED', reason: 'daily_cap' };
    expect(cycleOutcomeFromJson(skipped)).toBe(skipped);
    expect(() => cycleOutcomeFromJson(null)).toThrow(/missing kind/);
    expect(() => cycleOutcomeFromJson({ kind: 'MAYBE' })).toThrow(/cycles.outcome.kind/);
  });
});
