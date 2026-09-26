import { describe, expect, it } from 'vitest';
import { VENUE_MIN_USD } from './venues.js';

describe('VENUE_MIN_USD', () => {
  it('is the measured minimum per venue (Q-03): Ondo above $5, bStocks none', () => {
    expect(VENUE_MIN_USD).toEqual({ bstocks: null, ondo: '5.01', xstocks: null });
  });
});
