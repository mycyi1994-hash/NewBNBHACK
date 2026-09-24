import { describe, expect, it } from 'vitest';
import {
  fromUnits,
  interestUnits,
  supplyApyFromRatePerBlock,
  toUnits,
  underlyingFromVTokens,
  utilizationBps,
  vTokensForUnderlying,
} from './amounts.js';

describe('toUnits / fromUnits', () => {
  it('round-trips decimal strings', () => {
    expect(toUnits('5', 18)).toBe(5_000_000_000_000_000_000n);
    expect(toUnits('0.000001', 6)).toBe(1n);
    expect(fromUnits(12_345_000_000_000_000_000n, 18)).toBe('12.345');
    expect(fromUnits(0n, 18)).toBe('0');
    expect(toUnits('7', 0)).toBe(7n);
    expect(fromUnits(-1n, 2)).toBe('-0.01');
  });

  it('rejects precision it cannot hold and non-numbers', () => {
    expect(() => toUnits('0.0000001', 6)).toThrow(/decimals/);
    expect(() => toUnits('-1', 18)).toThrow();
    expect(() => toUnits('1e3', 18)).toThrow();
  });
});

describe('Venus exchange rate maths', () => {
  // vUSDT: 8 decimals, USDT: 18 decimals → rate scaled by 1e(18 + 18 − 8) = 1e28.
  const rate = 220_512_345_678_901_234_567_890_123n;

  it('converts vTokens to underlying and back, rounding down', () => {
    const vTokens = vTokensForUnderlying(toUnits('100', 18), rate);
    const back = underlyingFromVTokens(vTokens, rate);
    expect(back <= toUnits('100', 18)).toBe(true);
    expect(toUnits('100', 18) - back < rate / 10n ** 18n + 1n).toBe(true);
  });

  it('matches a hand-computed value', () => {
    // 1 vToken unit (1e-8 vUSDT) at rate 2.2e26 → 2.2e26 / 1e18 = 2.2e8 underlying units.
    expect(underlyingFromVTokens(1n, 220_000_000_000_000_000_000_000_000n)).toBe(220_000_000n);
  });

  it('rejects a non-positive rate', () => {
    expect(() => vTokensForUnderlying(1n, 0n)).toThrow();
  });
});

describe('utilizationBps', () => {
  it('is borrows / (cash + borrows − reserves)', () => {
    expect(utilizationBps(600n, 400n, 0n)).toBe(4000);
    expect(utilizationBps(500n, 400n, 100n)).toBe(5000);
  });

  it('is 0 for an empty market', () => {
    expect(utilizationBps(0n, 0n, 0n)).toBe(0);
    expect(utilizationBps(100n, 0n, 0n)).toBe(0);
  });
});

describe('interestUnits', () => {
  it('is position − principal − harvested', () => {
    expect(interestUnits(toUnits('101.5', 18), toUnits('100', 18), toUnits('0.5', 18))).toBe(
      toUnits('1', 18),
    );
  });

  it('never goes negative', () => {
    expect(interestUnits(toUnits('99', 18), toUnits('100', 18), 0n)).toBe(0n);
  });
});

describe('supplyApyFromRatePerBlock', () => {
  it('compounds per block', () => {
    // 1e-9 per block over 1e7 blocks ≈ e^0.01 − 1.
    const apy = supplyApyFromRatePerBlock(1_000_000_000n, 10_000_000);
    expect(apy).toBeCloseTo(Math.expm1(0.01), 6);
  });
});
