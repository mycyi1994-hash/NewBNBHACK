import { describe, expect, it } from 'vitest';
import { uxCopyWhyTable } from '../test/ux-copy.js';
import { WHY_KEYS, formatPct, formatShares, formatUsd } from './why.js';

describe('WHY_KEYS', () => {
  it('is exactly the key list of UX_COPY §4', () => {
    expect([...WHY_KEYS].sort()).toEqual([...uxCopyWhyTable().keys()].sort());
  });
});

describe('formatters', () => {
  const e18 = 10n ** 18n;

  it('shows USD with two decimals, never rounding up', () => {
    expect(formatUsd(5n * e18)).toBe('5.00');
    expect(formatUsd(259_999n * 10n ** 12n)).toBe('0.25');
    expect(formatUsd(0n)).toBe('0.00');
    expect(formatUsd(-3n * 10n ** 16n)).toBe('-0.03');
  });

  it('shows shares with at most six decimals but keeps tiny amounts visible', () => {
    expect(formatShares(22_212_154_002_358_266n)).toBe('0.022212');
    expect(formatShares(2n * e18)).toBe('2');
    expect(formatShares(123n)).toBe('0.000000000000000123');
  });

  it('shows percentages with two decimals', () => {
    expect(formatPct(2.3456)).toBe('2.35');
    expect(formatPct(-0.35)).toBe('-0.35');
  });
});
