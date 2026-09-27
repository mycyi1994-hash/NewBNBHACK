import { describe, expect, it } from 'vitest';
import { evaluateGuardian, guardianVerdict, unevaluatedRules } from './guardian.js';

const now = new Date('2026-09-28T14:00:00Z');
const calm = {
  now,
  venus: { mintPaused: false, redeemPaused: false, utilizationBps: 7_278 },
  tvl: { nowUsd: 1_353_914_642, dayAgoUsd: 1_350_000_000 },
  usdt: { priceUsd: 1.0001, belowPegSince: null },
};

describe('evaluateGuardian', () => {
  it('stays quiet on a normal day (G1 measurements)', () => {
    expect(evaluateGuardian(calm)).toEqual([]);
    expect(evaluateGuardian({ now })).toEqual([]);
  });

  it('redeems everything when Venus pauses minting, and stops buying when it pauses redemptions', () => {
    expect(evaluateGuardian({ ...calm, venus: { ...calm.venus, mintPaused: true } })).toEqual([
      {
        rule: 'protocol_paused',
        action: 'redeem_all',
        detail: { mintPaused: 'true', redeemPaused: 'false' },
      },
    ]);
    expect(
      evaluateGuardian({ ...calm, venus: { ...calm.venus, redeemPaused: true } })[0],
    ).toMatchObject({ rule: 'protocol_paused', action: 'pause_buys' });
  });

  it('redeems everything after a 30 % TVL drop in 24 h, not before', () => {
    expect(evaluateGuardian({ ...calm, tvl: { nowUsd: 700, dayAgoUsd: 1_000 } })).toEqual([
      {
        rule: 'tvl_drop',
        action: 'redeem_all',
        detail: { changePct: '-30.0', nowUsd: '700', dayAgoUsd: '1000' },
      },
    ]);
    expect(evaluateGuardian({ ...calm, tvl: { nowUsd: 701, dayAgoUsd: 1_000 } })).toEqual([]);
    expect(evaluateGuardian({ ...calm, tvl: { nowUsd: 1, dayAgoUsd: null } })).toEqual([]);
    expect(evaluateGuardian({ ...calm, tvl: { nowUsd: 1, dayAgoUsd: 0 } })).toEqual([]);
  });

  it('never reads a bad sample as a crash: TVL 0 or NaN and a zero USDT price count as missing', () => {
    // One bad TVL read of 0 used to look like a −100 % drop and redeem every yield plan.
    expect(evaluateGuardian({ ...calm, tvl: { nowUsd: 0, dayAgoUsd: 1_350_000_000 } })).toEqual([]);
    expect(evaluateGuardian({ ...calm, tvl: { nowUsd: NaN, dayAgoUsd: 1_000 } })).toEqual([]);
    const zero = { priceUsd: 0, belowPegSince: '2026-09-28T13:00:00.000Z' };
    expect(evaluateGuardian({ ...calm, usdt: zero })).toEqual([]);
    expect(unevaluatedRules({ ...calm, tvl: { nowUsd: 0, dayAgoUsd: 1_000 }, usdt: zero })).toEqual(
      ['tvl_drop', 'usdt_depeg'],
    );
  });

  it('names the rules it could not evaluate, so their open events stay open', () => {
    expect(unevaluatedRules(calm)).toEqual([]);
    expect(unevaluatedRules({ now })).toEqual([
      'protocol_paused',
      'utilization_high',
      'tvl_drop',
      'usdt_depeg',
    ]);
    // No sample from a day ago yet: the drop cannot be measured.
    expect(unevaluatedRules({ ...calm, tvl: { nowUsd: 1, dayAgoUsd: null } })).toEqual([
      'tvl_drop',
    ]);
  });

  it('stops new deposits above 95 % utilisation', () => {
    expect(evaluateGuardian({ ...calm, venus: { ...calm.venus, utilizationBps: 9_501 } })).toEqual([
      { rule: 'utilization_high', action: 'stop_deposits', detail: { utilizationPct: '95.01' } },
    ]);
    expect(evaluateGuardian({ ...calm, venus: { ...calm.venus, utilizationBps: 9_500 } })).toEqual(
      [],
    );
  });

  it('pauses buys when USDT stays under 0.99 for 30 minutes', () => {
    const since = (minutesAgo: number) =>
      new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    expect(
      evaluateGuardian({ ...calm, usdt: { priceUsd: 0.985, belowPegSince: since(30) } }),
    ).toEqual([
      { rule: 'usdt_depeg', action: 'pause_buys', detail: { priceUsd: '0.985', since: since(30) } },
    ]);
    expect(
      evaluateGuardian({ ...calm, usdt: { priceUsd: 0.985, belowPegSince: since(29) } }),
    ).toEqual([]);
    expect(evaluateGuardian({ ...calm, usdt: { priceUsd: 0.985, belowPegSince: null } })).toEqual(
      [],
    );
    expect(
      evaluateGuardian({ ...calm, usdt: { priceUsd: 0.99, belowPegSince: since(60) } }),
    ).toEqual([]);
  });
});

describe('guardianVerdict', () => {
  it('blocks buying for pause_buys and redeem_all only', () => {
    expect(guardianVerdict([])).toEqual({ blocked: false });
    expect(guardianVerdict([{ rule: 'utilization_high', action: 'stop_deposits' }])).toEqual({
      blocked: false,
    });
    expect(
      guardianVerdict([
        { rule: 'utilization_high', action: 'stop_deposits' },
        { rule: 'usdt_depeg', action: 'pause_buys' },
      ]),
    ).toEqual({ blocked: true, rule: 'usdt_depeg' });
    expect(guardianVerdict([{ rule: 'tvl_drop', action: 'redeem_all' }])).toEqual({
      blocked: true,
      rule: 'tvl_drop',
    });
  });
});
