/**
 * Smallest order each venue accepts, USD. Ondo rejects exactly $5.00 and accepts $5.01 (measured,
 * DECISIONS Q-03); bStocks quoted $0.10 without complaint. A larger minimum seen later in a 40375
 * message rules the venue out for that cycle (decideCycle).
 */
import type { Issuer } from './types.js';

export const VENUE_MIN_USD: Readonly<Record<Issuer, string | null>> = {
  bstocks: null,
  ondo: '5.01',
  xstocks: null,
};
