import { describe, expect, it } from 'vitest';
import {
  revalueHolding,
  sameMultiplier,
  sharesFromTokens,
  upcomingMultiplierChange,
} from './holdings.js';

describe('sharesFromTokens', () => {
  it('multiplies base units by the multiplier exactly, rounding down', () => {
    // 0.022212154002358266 NVDAB at the measured uiMultiplier 1.000778223752807865 (Q-13).
    expect(sharesFromTokens(22_212_154_002_358_266n, 18, '1.000778223752807865')).toBe(
      '0.022229440028203927', // exact product 0.022229440028203927488… rounded down
    );
    expect(sharesFromTokens(10n ** 18n, 18, '10')).toBe('10');
    expect(sharesFromTokens(1_500_000n, 6, '1')).toBe('1.5');
  });
});

describe('sameMultiplier', () => {
  it('compares numerically', () => {
    expect(sameMultiplier('1', '1.000')).toBe(true);
    expect(sameMultiplier('1.0017152487959898', '1.00171524879599')).toBe(false);
  });
});

describe('revalueHolding', () => {
  const holding = {
    tokens: (2n * 10n ** 18n).toString(),
    decimals: 18,
    multiplierAtLastUpdate: '1',
  };

  it('keeps shares when the multiplier is unchanged', () => {
    expect(revalueHolding(holding, '1.0')).toEqual({ shares: '2', multiplierChanged: false });
  });

  it('recomputes shares after a split moves the multiplier (balanceOf unchanged)', () => {
    expect(revalueHolding(holding, '10')).toEqual({ shares: '20', multiplierChanged: true });
  });
});

describe('upcomingMultiplierChange', () => {
  const now = new Date('2026-09-24T00:00:00Z');
  const future = Date.parse('2026-10-01T00:00:00Z') / 1000;

  it('reports a scheduled change', () => {
    expect(upcomingMultiplierChange('1', '1.25', future, now)).toEqual({
      from: '1',
      to: '1.25',
      effectiveAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('ignores none scheduled, already effective, or no change', () => {
    expect(upcomingMultiplierChange('1', '1.25', 0, now)).toBeNull();
    expect(upcomingMultiplierChange('1', '1.25', now.getTime() / 1000, now)).toBeNull();
    expect(upcomingMultiplierChange('1', '1.0', future, now)).toBeNull();
  });
});
