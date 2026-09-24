import { describe, expect, it } from 'vitest';
import { uxCopyWhyTable } from '../test/ux-copy.js';
import {
  boughtOutcome,
  decideCycle,
  type CycleInput,
  type Decision,
  type ExecuteDecision,
  type InstrumentMarket,
  type QuoteObservation,
  type TokenStatus,
} from './decide.js';
import type { Instrument, Issuer, Plan } from './types.js';
import type { Why } from './why.js';

const REGULAR = new Date('2026-09-28T14:00:00Z'); // Mon 10:00 ET
const OVERNIGHT = new Date('2026-09-24T02:00:00Z'); // Wed 22:00 ET
const SATURDAY = new Date('2026-09-26T15:00:00Z');
const MIN = 60_000;

const TRADING: TokenStatus = {
  openState: true,
  reasonCode: 'TRADING',
  reasonMsg: null,
  nextOpenTime: null,
};

function instrument(ticker: string, issuer: Issuer, multiplier = '1'): Instrument {
  return {
    id: `${ticker}:${issuer}`,
    ticker,
    issuer,
    chainId: 56,
    address: `0x${'1'.repeat(40)}`,
    symbol: issuer === 'bstocks' ? `${ticker}B` : `${ticker}on`,
    decimals: 18,
    multiplier,
    verifiedAt: '2026-09-24T00:45:40.000Z',
  };
}

function market(
  ticker: string,
  issuer: Issuer,
  overrides: Partial<InstrumentMarket> = {},
): InstrumentMarket {
  return {
    instrument: instrument(ticker, issuer),
    status: TRADING,
    onchainSharePriceUsd: '225.10',
    independentSharePriceUsd: null,
    // Measured: Ondo rejects $5.00 and accepts $5.01 (DECISIONS Q-03).
    venueMinUsd: issuer === 'ondo' ? '5.01' : null,
    ...overrides,
  };
}

const H_SAFE: Plan = {
  id: 'H-SAFE',
  owner: { kind: 'house' },
  mode: 'safe',
  target: { type: 'ticker', ticker: 'NVDA' },
  issuerPreference: ['bstocks', 'ondo'],
  principalUsd: '0',
  contributionUsd: '5',
  cadence: 'daily',
  window: 'regular_session',
  limits: { maxPerBuyUsd: '5', maxDailyUsd: '5' },
  status: 'active',
  createdAt: '2026-09-24T00:00:00.000Z',
  nextDueAt: '2026-09-24T00:00:00.000Z',
};

const H_YIELD: Plan = {
  ...H_SAFE,
  id: 'H-YIELD',
  mode: 'yield',
  principalUsd: '1000',
  contributionUsd: '0',
  cadence: 'weekly',
  limits: { maxPerBuyUsd: '25', maxDailyUsd: '25' },
};

const ANYTIME: Plan = {
  ...H_SAFE,
  id: 'J-1',
  owner: { kind: 'judge', code: 'x' },
  window: 'anytime',
};

function input(overrides: Partial<CycleInput> = {}): CycleInput {
  return {
    now: REGULAR,
    plan: H_SAFE,
    caps: { minBuyUsd: '2', maxPerTxUsd: '25' },
    dailyRemainingUsd: '50',
    dailyLimitUsd: '50',
    markets: [market('NVDA', 'bstocks'), market('NVDA', 'ondo')],
    ...overrides,
  };
}

function quote(
  instrumentId: string,
  spendUsd: string,
  overrides: Partial<QuoteObservation> = {},
): QuoteObservation {
  return {
    instrumentId,
    spendUsd,
    receivedAt: new Date(REGULAR.getTime() - 1_000).toISOString(),
    quoteId: 'q-1',
    toTokenAmount: '22212154002358266',
    priceImpactPct: '0.0000000000',
    executionMode: 'SWAP',
    ...overrides,
  };
}

const COPY = uxCopyWhyTable();

/** The why must be a UX_COPY key with exactly its placeholders ({gap} may be missing, Q-06). */
function expectCopy(why: Why) {
  const placeholders = COPY.get(why.key);
  expect(placeholders, `${why.key} is not in UX_COPY §4`).toBeDefined();
  const given = new Set(Object.keys(why.params));
  for (const name of given) expect(placeholders?.has(name), `unknown {${name}}`).toBe(true);
  for (const name of placeholders ?? []) {
    if (name !== 'gap') expect(given.has(name), `${why.key} misses {${name}}`).toBe(true);
  }
}

function terminal(decision: Decision) {
  if (decision.kind !== 'done') throw new Error(`expected done, got ${decision.kind}`);
  expectCopy(decision.why);
  return decision;
}

function execute(decision: Decision): ExecuteDecision {
  if (decision.kind !== 'execute') throw new Error(`expected execute, got ${decision.kind}`);
  return decision;
}

describe('decideCycle — DUE', () => {
  it('waits until nextDueAt', () => {
    const plan = { ...H_SAFE, nextDueAt: '2026-09-28T14:05:00.000Z' };
    expect(decideCycle(input({ plan }))).toEqual({ kind: 'not_due' });
  });

  it('never runs paused or stopped plans', () => {
    expect(decideCycle(input({ plan: { ...H_SAFE, status: 'paused' } })).kind).toBe('not_due');
    expect(decideCycle(input({ plan: { ...H_SAFE, status: 'stopped' } })).kind).toBe('not_due');
  });

  it('stops running an expired judge plan', () => {
    const plan = { ...ANYTIME, expiresAt: '2026-09-28T13:59:59.000Z' };
    expect(decideCycle(input({ plan })).kind).toBe('not_due');
  });

  it('refuses sector targets instead of guessing', () => {
    const plan: Plan = { ...H_SAFE, target: { type: 'sector', sector: 'ai_chips' } };
    expect(() => decideCycle(input({ plan }))).toThrow(/sector targets are not implemented/);
  });
});

describe('decideCycle — GUARDIAN', () => {
  it('skips with the rule that fired', () => {
    const d = terminal(
      decideCycle(input({ guardian: { blocked: true, rule: 'utilization>95%' } })),
    );
    expect(d.outcome).toEqual({ kind: 'SKIPPED', reason: 'guardian', detail: 'utilization>95%' });
    expect(d.why).toEqual({ key: 'why.skipped.guardian', params: { rule: 'utilization>95%' } });
  });
});

describe('decideCycle — WINDOW', () => {
  it('defers a regular-session plan overnight to two minutes after the next open', () => {
    const d = terminal(decideCycle(input({ now: OVERNIGHT })));
    expect(d.outcome).toEqual({
      kind: 'DEFERRED',
      reason: 'market_closed',
      retryAt: '2026-09-24T13:32:00.000Z',
    });
    expect(d.why.params).toEqual({ open: '2026-09-24T13:32:00.000Z' });
  });

  it('defers over the weekend to Monday', () => {
    const d = terminal(decideCycle(input({ now: SATURDAY })));
    expect(d.outcome).toMatchObject({
      reason: 'market_closed',
      retryAt: '2026-09-28T13:32:00.000Z',
    });
  });

  it('lets an anytime plan buy off-hours at half the per-buy limit', () => {
    const d = decideCycle(input({ now: OVERNIGHT, plan: ANYTIME }));
    expect(d).toEqual({ kind: 'quote', instrumentId: 'NVDA:bstocks', spendUsd: '2.5' });
  });

  it('treats a halved limit below the minimum as a configuration error', () => {
    const plan = { ...ANYTIME, limits: { maxPerBuyUsd: '3', maxDailyUsd: '3' } };
    expect(() => decideCycle(input({ now: OVERNIGHT, plan }))).toThrow(/below the minimum buy/);
  });
});

describe('decideCycle — BUDGET', () => {
  it('spends the contribution in safe mode', () => {
    expect(decideCycle(input())).toEqual({
      kind: 'quote',
      instrumentId: 'NVDA:bstocks',
      spendUsd: '5',
    });
  });

  it('caps a spend at the per-transaction cap from config', () => {
    const plan = {
      ...H_SAFE,
      contributionUsd: '30',
      limits: { maxPerBuyUsd: '25', maxDailyUsd: '50' },
    };
    const d = decideCycle(input({ plan, caps: { minBuyUsd: '2', maxPerTxUsd: '5' } }));
    expect(d).toMatchObject({ kind: 'quote', spendUsd: '5' });
  });

  it('accumulates interest below the minimum and says how much', () => {
    const position = { underlyingUsd: '1000.30', harvestedUnspentUsd: '0' };
    const d = terminal(decideCycle(input({ plan: H_YIELD, position })));
    expect(d.outcome).toEqual({ kind: 'SKIPPED', reason: 'below_min', detail: 'budget 0.3' });
    expect(d.why).toEqual({ key: 'why.skipped.below_min', params: { acc: '0.30', min: '2.00' } });
  });

  it('never counts a position below principal as negative interest', () => {
    const position = { underlyingUsd: '999.99', harvestedUnspentUsd: '0' };
    const d = terminal(decideCycle(input({ plan: H_YIELD, position })));
    expect(d.why.params).toEqual({ acc: '0.00', min: '2.00' });
  });

  it('adds interest already redeemed but unspent to the interest in the position', () => {
    const position = { underlyingUsd: '1002.60', harvestedUnspentUsd: '0.40' };
    expect(decideCycle(input({ plan: H_YIELD, position }))).toMatchObject({
      kind: 'quote',
      spendUsd: '3',
    });
  });

  it('requires a position for yield plans', () => {
    expect(() => decideCycle(input({ plan: H_YIELD }))).toThrow(/without a position/);
  });

  it('skips when the daily cap is used up', () => {
    const d = terminal(decideCycle(input({ dailyRemainingUsd: '0', dailyLimitUsd: '50' })));
    expect(d.outcome).toEqual({ kind: 'SKIPPED', reason: 'daily_cap' });
    expect(d.why).toEqual({ key: 'why.skipped.daily_cap', params: { daily: '50.00' } });
  });

  it('skips when what is left today is below the minimum buy', () => {
    const d = terminal(decideCycle(input({ dailyRemainingUsd: '1.99' })));
    expect(d.outcome).toMatchObject({ reason: 'daily_cap' });
  });

  it('spends only what is left of the daily cap', () => {
    expect(decideCycle(input({ dailyRemainingUsd: '3' }))).toMatchObject({ spendUsd: '3' });
  });
});

describe('decideCycle — ASSET', () => {
  const bigSafe = {
    ...H_SAFE,
    contributionUsd: '6',
    limits: { maxPerBuyUsd: '25', maxDailyUsd: '25' },
  };

  it('buys from the preferred issuer when it trades', () => {
    expect(decideCycle(input())).toMatchObject({ instrumentId: 'NVDA:bstocks' });
  });

  it('falls back to the next issuer when the preferred one is not listed', () => {
    const plan = { ...bigSafe, target: { type: 'ticker' as const, ticker: 'AAPL' } };
    const d = decideCycle(input({ plan, markets: [market('AAPL', 'ondo')] }));
    expect(d).toEqual({ kind: 'quote', instrumentId: 'AAPL:ondo', spendUsd: '6' });
  });

  it('respects the venue minimum: $5 cannot buy an Ondo-only stock', () => {
    const plan = { ...H_SAFE, target: { type: 'ticker' as const, ticker: 'AAPL' } };
    const d = terminal(decideCycle(input({ plan, markets: [market('AAPL', 'ondo')] })));
    expect(d.outcome).toEqual({ kind: 'SKIPPED', reason: 'below_min', detail: 'venue_minimum' });
    expect(d.why.params).toEqual({ acc: '5.00', min: '5.01' });
  });

  it('skips for earnings without switching issuer', () => {
    const limited = { ...TRADING, reasonCode: 'ASSET_LIMITED', reasonMsg: 'earnings' };
    const d = terminal(
      decideCycle(
        input({
          markets: [market('NVDA', 'bstocks', { status: limited }), market('NVDA', 'ondo')],
        }),
      ),
    );
    expect(d.outcome).toEqual({
      kind: 'SKIPPED',
      reason: 'corporate_action',
      detail: 'ASSET_LIMITED:earnings',
    });
    expect(d.why).toEqual({
      key: 'why.skipped.corporate_action.earnings',
      params: { ticker: 'NVDA' },
    });
  });

  it('uses the dividend line for cash and stock dividends', () => {
    for (const reasonMsg of ['cash_dividend', 'stock_dividend']) {
      const paused = {
        openState: false,
        reasonCode: 'ASSET_PAUSED',
        reasonMsg,
        nextOpenTime: null,
      };
      const d = terminal(
        decideCycle(input({ markets: [market('NVDA', 'bstocks', { status: paused })] })),
      );
      expect(d.why.key).toBe('why.skipped.corporate_action.cash_dividend');
    }
  });

  it('uses the split line for a stock split', () => {
    const paused = {
      openState: false,
      reasonCode: 'ASSET_PAUSED',
      reasonMsg: 'stock_split',
      nextOpenTime: null,
    };
    const d = terminal(
      decideCycle(input({ markets: [market('NVDA', 'bstocks', { status: paused })] })),
    );
    expect(d.why.key).toBe('why.skipped.corporate_action.stock_split');
  });

  it('keeps the real reason for corporate actions that have no copy yet', () => {
    const paused = {
      openState: false,
      reasonCode: 'ASSET_PAUSED',
      reasonMsg: 'merger',
      nextOpenTime: null,
    };
    const d = terminal(
      decideCycle(input({ markets: [market('NVDA', 'bstocks', { status: paused })] })),
    );
    expect(d.outcome).toMatchObject({ reason: 'corporate_action', detail: 'ASSET_PAUSED:merger' });
    expect(d.why.key).toBe('why.skipped.no_liquidity');
  });

  it('defers to the API next open when a session transition pauses trading', () => {
    const next = REGULAR.getTime() + 10 * MIN;
    const paused = {
      openState: false,
      reasonCode: 'MARKET_PAUSED',
      reasonMsg: 'Paused for session transition',
      nextOpenTime: next,
    };
    const d = terminal(
      decideCycle(input({ markets: [market('NVDA', 'bstocks', { status: paused })] })),
    );
    expect(d.outcome).toEqual({
      kind: 'DEFERRED',
      reason: 'market_closed',
      retryAt: new Date(next + 2 * MIN).toISOString(),
      detail: 'MARKET_PAUSED',
    });
  });

  it('retries in 30 minutes when a pause gives no usable next open', () => {
    const paused = {
      openState: false,
      reasonCode: 'MARKET_MAINTENANCE',
      reasonMsg: null,
      nextOpenTime: null,
    };
    const d = terminal(
      decideCycle(input({ markets: [market('NVDA', 'bstocks', { status: paused })] })),
    );
    expect(d.outcome).toMatchObject({
      retryAt: new Date(REGULAR.getTime() + 30 * MIN).toISOString(),
    });
  });

  it('switches issuer when the preferred token is unsupported this session', () => {
    const unsupported = {
      openState: false,
      reasonCode: 'UNSUPPORTED',
      reasonMsg: null,
      nextOpenTime: null,
    };
    const d = decideCycle(
      input({
        markets: [
          market('NVDA', 'bstocks', { status: unsupported }),
          market('NVDA', 'ondo', { venueMinUsd: null }),
        ],
      }),
    );
    expect(d).toMatchObject({ kind: 'quote', instrumentId: 'NVDA:ondo' });
  });

  it('reports every reason when nothing can be bought', () => {
    const unsupported = {
      openState: false,
      reasonCode: 'UNSUPPORTED',
      reasonMsg: null,
      nextOpenTime: null,
    };
    const d = terminal(
      decideCycle(
        input({
          markets: [
            market('NVDA', 'bstocks', { status: unsupported }),
            market('NVDA', 'ondo', { status: unsupported }),
          ],
        }),
      ),
    );
    expect(d.outcome).toEqual({
      kind: 'SKIPPED',
      reason: 'no_instrument',
      detail: 'NVDA:bstocks:UNSUPPORTED, NVDA:ondo:UNSUPPORTED',
    });
    expect(d.why).toEqual({ key: 'why.skipped.no_liquidity', params: { ticker: 'NVDA' } });
  });

  it('says so when the registry has no instrument for the ticker', () => {
    const d = terminal(decideCycle(input({ markets: [] })));
    expect(d.outcome).toMatchObject({
      reason: 'no_instrument',
      detail: 'no registered instrument',
    });
  });
});

describe('decideCycle — PRICE', () => {
  const withPrices = (onchain: string, independent: string | null) => [
    market('NVDA', 'bstocks', {
      onchainSharePriceUsd: onchain,
      independentSharePriceUsd: independent,
    }),
  ];

  it('checks nothing without an independent stock price', () => {
    const d = execute(
      decideCycle(
        input({ markets: withPrices('240', null), quotes: [quote('NVDA:bstocks', '5')] }),
      ),
    );
    expect(d.refGapPct).toBeNull();
  });

  it('defers a regular-session buy at more than a 2% premium', () => {
    const d = terminal(decideCycle(input({ markets: withPrices('229.60', '225.00') })));
    expect(d.outcome).toEqual({
      kind: 'DEFERRED',
      reason: 'price_gap',
      retryAt: new Date(REGULAR.getTime() + 30 * MIN).toISOString(),
    });
    expect(d.why).toEqual({ key: 'why.deferred.price_gap', params: { gap: '2.04' } });
  });

  it('buys below the independent price and records the gap', () => {
    const d = execute(
      decideCycle(
        input({ markets: withPrices('220.00', '225.00'), quotes: [quote('NVDA:bstocks', '5')] }),
      ),
    );
    expect(d.refGapPct).toBe('-2.22');
  });

  it('does not apply the premium rule off-hours (anytime plans disclose it instead)', () => {
    const quotes = [
      quote('NVDA:bstocks', '2.5', {
        receivedAt: new Date(OVERNIGHT.getTime() - 1_000).toISOString(),
      }),
    ];
    const d = execute(
      decideCycle(
        input({ now: OVERNIGHT, plan: ANYTIME, markets: withPrices('240', '225'), quotes }),
      ),
    );
    expect(d).toMatchObject({ offHours: true, refGapPct: '6.67' });
  });
});

describe('decideCycle — QUOTE', () => {
  const bigSafe = {
    ...H_SAFE,
    contributionUsd: '6',
    limits: { maxPerBuyUsd: '25', maxDailyUsd: '25' },
  };

  it('asks for a quote first', () => {
    expect(decideCycle(input())).toEqual({
      kind: 'quote',
      instrumentId: 'NVDA:bstocks',
      spendUsd: '5',
    });
  });

  it('tries the next issuer after a no-liquidity quote', () => {
    const quotes = [quote('NVDA:bstocks', '6', { errorCode: '40374', errorMsg: 'no liquidity' })];
    expect(decideCycle(input({ plan: bigSafe, quotes }))).toEqual({
      kind: 'quote',
      instrumentId: 'NVDA:ondo',
      spendUsd: '6',
    });
  });

  it('does not execute RFQ routes until a human enables them (Q-15)', () => {
    const rfq = (id: string) => quote(id, '6', { executionMode: 'RFQ' });
    expect(decideCycle(input({ plan: bigSafe, quotes: [rfq('NVDA:bstocks')] }))).toMatchObject({
      kind: 'quote',
      instrumentId: 'NVDA:ondo',
    });
    const d = terminal(
      decideCycle(input({ plan: bigSafe, quotes: [rfq('NVDA:bstocks'), rfq('NVDA:ondo')] })),
    );
    expect(d.outcome).toMatchObject({
      reason: 'no_instrument',
      detail: 'NVDA:bstocks:rfq_not_enabled, NVDA:ondo:rfq_not_enabled',
    });
  });

  it('rules out an issuer whose minimum turned out higher than recorded', () => {
    const plan = { ...bigSafe, target: { type: 'ticker' as const, ticker: 'AAPL' } };
    const quotes = [
      quote('AAPL:ondo', '6', { errorCode: '40375', errorMsg: 'Minimum order amount is 20 USD.' }),
    ];
    const d = terminal(decideCycle(input({ plan, markets: [market('AAPL', 'ondo')], quotes })));
    expect(d.outcome).toMatchObject({ reason: 'no_instrument', detail: 'AAPL:ondo:venue_minimum' });
  });

  it('defers when the venue rejects the quote as off-hours', () => {
    const quotes = [quote('NVDA:bstocks', '5', { errorCode: '40369', errorMsg: 'closed' })];
    const regular = terminal(decideCycle(input({ quotes })));
    expect(regular.outcome).toEqual({
      kind: 'DEFERRED',
      reason: 'market_closed',
      retryAt: new Date(REGULAR.getTime() + 30 * MIN).toISOString(),
      detail: '40369',
    });
    const offHours = terminal(decideCycle(input({ now: OVERNIGHT, plan: ANYTIME, quotes })));
    expect(offHours.outcome).toMatchObject({ retryAt: '2026-09-24T13:32:00.000Z' });
  });

  it('fails the cycle with the code for any other quote error, no funds moved', () => {
    const quotes = [
      quote('NVDA:bstocks', '5', { errorCode: '40001', errorMsg: 'Parameter error' }),
    ];
    const d = terminal(decideCycle(input({ quotes })));
    expect(d.outcome).toEqual({
      kind: 'FAILED',
      code: '40001',
      message: 'Parameter error',
      fundsMoved: 'none',
    });
    expect(d.why).toEqual({ key: 'why.failed.simulation', params: { code: '40001' } });
  });

  it('fails on a quote without an id or amount', () => {
    const quotes = [quote('NVDA:bstocks', '5', { quoteId: undefined })];
    const d = terminal(decideCycle(input({ quotes })));
    expect(d.outcome).toMatchObject({
      kind: 'FAILED',
      code: 'QUOTE_INCOMPLETE',
      fundsMoved: 'none',
    });
  });

  it('halves the spend when price impact is above 1%', () => {
    const quotes = [quote('NVDA:bstocks', '5', { priceImpactPct: '1.5' })];
    expect(decideCycle(input({ quotes }))).toEqual({
      kind: 'quote',
      instrumentId: 'NVDA:bstocks',
      spendUsd: '2.5',
    });
  });

  it('defers when halving would go below the minimum buy', () => {
    const quotes = [
      quote('NVDA:bstocks', '5', { priceImpactPct: '1.5' }),
      quote('NVDA:bstocks', '2.5', { priceImpactPct: '1.2' }),
    ];
    const d = terminal(decideCycle(input({ quotes })));
    expect(d.outcome).toMatchObject({ kind: 'DEFERRED', reason: 'quote_impact' });
    expect(d.why).toEqual({ key: 'why.deferred.quote_impact', params: { impact: '1.20' } });
  });

  it('re-quotes at most twice', () => {
    const plan = {
      ...H_SAFE,
      contributionUsd: '20',
      limits: { maxPerBuyUsd: '25', maxDailyUsd: '25' },
    };
    const quotes = [
      quote('NVDA:bstocks', '20', { priceImpactPct: '3' }),
      quote('NVDA:bstocks', '10', { priceImpactPct: '2' }),
    ];
    expect(decideCycle(input({ plan, quotes }))).toMatchObject({ kind: 'quote', spendUsd: '5' });
    const third = [...quotes, quote('NVDA:bstocks', '5', { priceImpactPct: '1.5' })];
    const d = terminal(decideCycle(input({ plan, quotes: third })));
    expect(d.outcome).toMatchObject({ reason: 'quote_impact' });
  });

  it('re-quotes a quote older than 25 s (the id lives 30 s)', () => {
    const stale = quote('NVDA:bstocks', '5', {
      receivedAt: new Date(REGULAR.getTime() - 26_000).toISOString(),
    });
    expect(decideCycle(input({ quotes: [stale] }))).toEqual({
      kind: 'quote',
      instrumentId: 'NVDA:bstocks',
      spendUsd: '5',
    });
  });

  it('executes a fresh, low-impact quote', () => {
    const q = quote('NVDA:bstocks', '5');
    expect(decideCycle(input({ quotes: [q] }))).toEqual({
      kind: 'execute',
      instrumentId: 'NVDA:bstocks',
      spendUsd: '5',
      quote: q,
      redeemUsd: '0',
      interestUsd: null,
      offHours: false,
      refGapPct: null,
    });
  });

  it('pays a yield buy from unspent redeemed interest first, then redeems the rest', () => {
    const position = { underlyingUsd: '1002.60', harvestedUnspentUsd: '0.40' };
    const d = execute(
      decideCycle(input({ plan: H_YIELD, position, quotes: [quote('NVDA:bstocks', '3')] })),
    );
    expect(d).toMatchObject({ spendUsd: '3', interestUsd: '3', redeemUsd: '2.6' });
  });
});

describe('boughtOutcome', () => {
  const nvdab = instrument('NVDA', 'bstocks', '1.000778223752807865');
  const base: ExecuteDecision = {
    kind: 'execute',
    instrumentId: nvdab.id,
    spendUsd: '5',
    quote: quote(nvdab.id, '5'),
    redeemUsd: '0',
    interestUsd: null,
    offHours: false,
    refGapPct: null,
  };

  it('reports shares, not tokens, for a regular-session buy', () => {
    const { outcome, why } = boughtOutcome(base, nvdab, '22212154002358266');
    expect(outcome).toEqual({
      kind: 'BOUGHT',
      spendUsd: '5',
      tokens: '22212154002358266',
      shares: '0.022229440028203927',
      interestUsd: null,
      refGapPct: null,
    });
    expect(why).toEqual({
      key: 'why.bought.regular',
      params: { ticker: 'NVDA', shares: '0.022229', usd: '5.00' },
    });
    expectCopy(why);
  });

  it('adds the gap when an independent price was available', () => {
    const { why } = boughtOutcome({ ...base, refGapPct: '0.44' }, nvdab, '22212154002358266');
    expect(why.params.gap).toBe('0.44');
    expectCopy(why);
  });

  it('uses the off-hours line for an anytime buy outside the session', () => {
    const { why } = boughtOutcome({ ...base, offHours: true }, nvdab, '22212154002358266');
    expect(why.key).toBe('why.bought.anytime');
  });

  it('uses the interest line only when interest paid for the whole buy', () => {
    const interestOnly = { ...base, spendUsd: '3', interestUsd: '3', redeemUsd: '2.6' };
    const paid = boughtOutcome(interestOnly, nvdab, '13327292401414960');
    expect(paid.why).toEqual({
      key: 'why.bought.interest',
      params: { interest: '3.00', ticker: 'NVDA', shares: '0.013337' },
    });
    expectCopy(paid.why);
    const topped = boughtOutcome({ ...interestOnly, interestUsd: '1' }, nvdab, '13327292401414960');
    expect(topped.why.key).toBe('why.bought.regular');
  });
});

describe('decideCycle — edge cases', () => {
  const ondoOnly = (ticker: string) => ({
    ...H_SAFE,
    target: { type: 'ticker' as const, ticker },
    limits: { maxPerBuyUsd: '25', maxDailyUsd: '25' },
  });

  it('keeps a corporate action without a named reason', () => {
    const paused = {
      openState: false,
      reasonCode: 'ASSET_PAUSED',
      reasonMsg: null,
      nextOpenTime: null,
    };
    const d = terminal(
      decideCycle(input({ markets: [market('NVDA', 'bstocks', { status: paused })] })),
    );
    expect(d.outcome).toMatchObject({ reason: 'corporate_action', detail: 'ASSET_PAUSED:' });
    expect(d.why.key).toBe('why.skipped.no_liquidity');
  });

  it('treats a closed token without a reason code as not tradable', () => {
    const closed = { openState: false, reasonCode: null, reasonMsg: null, nextOpenTime: null };
    const d = terminal(
      decideCycle(input({ markets: [market('NVDA', 'bstocks', { status: closed })] })),
    );
    expect(d.outcome).toMatchObject({ reason: 'no_instrument', detail: 'NVDA:bstocks:UNKNOWN' });
  });

  it('names the smallest venue minimum when every issuer needs more', () => {
    const d = terminal(
      decideCycle(
        input({
          markets: [market('NVDA', 'bstocks', { venueMinUsd: '6' }), market('NVDA', 'ondo')],
        }),
      ),
    );
    expect(d.why.params).toEqual({ acc: '5.00', min: '5.01' });
  });

  it('fails with a generic message when the quote error has none', () => {
    const quotes = [quote('NVDA:bstocks', '5', { errorCode: '40370' })];
    const d = terminal(decideCycle(input({ quotes })));
    expect(d.outcome).toMatchObject({ code: '40370', message: 'quote failed' });
  });

  it('treats a quote without a price impact as no impact', () => {
    const quotes = [quote('NVDA:bstocks', '5', { priceImpactPct: undefined })];
    expect(decideCycle(input({ quotes })).kind).toBe('execute');
  });

  it('halves only while the half still meets the venue minimum', () => {
    const plan = { ...ondoOnly('AAPL'), contributionUsd: '12' };
    const markets = [market('AAPL', 'ondo')];
    const high = (spend: string) => [quote('AAPL:ondo', spend, { priceImpactPct: '1.5' })];
    expect(decideCycle(input({ plan, markets, quotes: high('12') }))).toMatchObject({
      kind: 'quote',
      spendUsd: '6',
    });
    const d = terminal(decideCycle(input({ plan, markets, quotes: high('10') })));
    expect(d.outcome).toMatchObject({ reason: 'quote_impact' });
  });
});
