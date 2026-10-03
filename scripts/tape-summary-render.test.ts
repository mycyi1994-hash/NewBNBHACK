/** dx/tape-summary.md's layout (DX_PROTOCOL §3.4): every table, in reading order, and no prose. */
import { describe, expect, it } from 'vitest';
import { renderTapeSummary, type TapeSummaryInput } from './tape-summary-render.js';

const input = (over: Partial<TapeSummaryInput> = {}): TapeSummaryInput => ({
  generatedAt: new Date('2026-10-03T04:00:00Z'),
  since: new Date('2026-09-03T04:00:00Z'),
  method: 'every 10 minutes the worker quotes …',
  coverage: {
    runs: 1200,
    rows: 25200,
    tokens: 7,
    first: '2026-09-24T02:30:00Z',
    last: '2026-10-03T03:50:00Z',
    bySession: [
      { session: 'weekend', runs: 300 },
      { session: 'regular', runs: 400 },
      { session: 'overnight', runs: 500 },
    ],
  },
  quotes: [
    {
      session: 'overnight',
      sizeUsd: 5,
      issuer: 'bstocks',
      quotes: 10,
      quoteErrors: 1,
      avgImpactPct: '0.0512',
      avgGapPct: '0.4',
      gapSamples: 0,
    },
    {
      session: 'regular',
      sizeUsd: 500,
      issuer: 'bstocks',
      quotes: 10,
      quoteErrors: 0,
      avgImpactPct: '0.3100',
      avgGapPct: '0.1',
      gapSamples: 10,
    },
    {
      session: 'regular',
      sizeUsd: 5,
      issuer: 'ondo',
      quotes: 4,
      quoteErrors: 4,
      avgImpactPct: null,
      avgGapPct: null,
      gapSamples: 0,
    },
  ],
  gaps: [
    {
      issuer: 'bstocks',
      session: 'regular',
      samples: 10,
      medianGapPct: '0.0710',
      p90AbsGapPct: '0.2400',
    },
  ],
  codes: [
    {
      issuer: 'ondo',
      session: 'regular',
      code: '40375',
      count: 4,
      message: 'Minimum order | amount is 5 USD.',
    },
  ],
  statuses: [
    { issuer: 'bstocks', reasonCode: 'TRADING', reasonMsg: null, tokenRuns: 1200 },
    { issuer: 'ondo', reasonCode: 'MARKET_CLOSED', reasonMsg: 'earnings', tokenRuns: 3 },
  ],
  ...over,
});

describe('renderTapeSummary', () => {
  const md = renderTapeSummary(input());

  it('states where the numbers come from, and that the prose is people’s', () => {
    expect(md.startsWith('# Tape summary\n')).toBe(true);
    expect(md).toContain('by `pnpm tape:summary` from `tape_samples`');
    expect(md).toContain('2026-09-03T04:00:00.000Z');
    expect(md).toContain("the DX report's sentences are written by people");
    expect(md).toContain('Method: every 10 minutes the worker quotes ….');
  });

  it('has the coverage, sessions in clock order, and every section in reading order', () => {
    expect(md).toContain('| 1200 | 25200 | 7 | 2026-09-24T02:30:00Z | 2026-10-03T03:50:00Z |');
    const order = ['| regular | 400 |', '| overnight | 500 |', '| weekend | 300 |'].map((s) =>
      md.indexOf(s),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const sections = [
      '## Coverage',
      '## Quotes: refusals and price impact',
      '## Gap to the US price',
      '## Codes the quotes were refused with',
      '## Token status as the RWA list reported it',
    ].map((s) => md.indexOf(s));
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);
  });

  it('sorts quotes by issuer, session and size, and shows refusals and impact as percentages', () => {
    const regular = md.indexOf('| bstocks | regular | 500 | 10 | 0 | 0.0 % | 0.31 % |');
    const overnight = md.indexOf('| bstocks | overnight | 5 | 10 | 1 | 10.0 % | 0.05 % |');
    const ondo = md.indexOf('| ondo | regular | 5 | 4 | 4 | 100.0 % | — |');
    expect(regular).toBeGreaterThan(0);
    expect(overnight).toBeGreaterThan(regular);
    expect(ondo).toBeGreaterThan(overnight);
  });

  it('renders the gap, the codes (cells escaped) and the token statuses', () => {
    expect(md).toContain('| bstocks | regular | 10 | 0.07 % | 0.24 % |');
    expect(md).toContain('| ondo | regular | 40375 | 4 | Minimum order \\| amount is 5 USD. |');
    expect(md).toContain('| ondo | MARKET_CLOSED | earnings | 3 |');
    expect(md).toContain('| bstocks | TRADING | — | 1200 |');
  });

  it('says so when a table is empty, instead of drawing an empty one', () => {
    const empty = renderTapeSummary(
      input({
        coverage: { runs: 0, rows: 0, tokens: 0, first: null, last: null, bySession: [] },
        quotes: [],
        gaps: [],
        codes: [],
        statuses: [],
      }),
    );
    expect(empty.match(/_None in this window\._/g)).toHaveLength(5);
    expect(empty).toContain('| 0 | 0 | 0 | — | — |');
    expect(empty.endsWith('\n')).toBe(true);
    expect(empty).not.toMatch(/\n{3,}/);
  });
});
