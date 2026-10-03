/**
 * dx/tape-summary.md (DX_PROTOCOL §3.4): the tape's numbers for the DX report's "tokenized-stock
 * specifics" section, rendered from the @yieldvest/db queries. Tables only — the report's sentences
 * are written by people (CLAUDE.md rule 3). Pure, so the layout is a unit test
 * (tape-summary-render.test.ts); tape-summary.ts reads the database.
 */
import type {
  TapeCodeRow,
  TapeCoverage,
  TapeGapRow,
  TapeStatusRow,
  TapeSummaryRow,
} from '@yieldvest/db';

export interface TapeSummaryInput {
  generatedAt: Date;
  since: Date;
  /** How the tape is recorded (TAPE_METHOD). */
  method: string;
  coverage: TapeCoverage;
  quotes: TapeSummaryRow[];
  gaps: TapeGapRow[];
  codes: TapeCodeRow[];
  statuses: TapeStatusRow[];
}

/** Our clock's sessions in the order a reader expects them. */
const SESSIONS = ['regular', 'pre', 'post', 'overnight', 'weekend', 'holiday'];
const sessionRank = (session: string) => {
  const i = SESSIONS.indexOf(session);
  return i === -1 ? SESSIONS.length : i;
};

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ').trim();

function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) return '_None in this window._\n';
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return `${[line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n')}\n`;
}

/** A percentage the database returned as text, to two decimals; — when there is none. */
const pct = (value: string | null) => (value === null ? '—' : `${Number(value).toFixed(2)} %`);

const byIssuerSession = <T extends { issuer: string; session: string }>(a: T, b: T) =>
  a.issuer.localeCompare(b.issuer) || sessionRank(a.session) - sessionRank(b.session);

export function renderTapeSummary(input: TapeSummaryInput): string {
  const { coverage } = input;
  const quotes = [...input.quotes].sort((a, b) => byIssuerSession(a, b) || a.sizeUsd - b.sizeUsd);
  const gaps = [...input.gaps].sort(byIssuerSession);
  const sessions = [...coverage.bySession].sort(
    (a, b) => sessionRank(a.session) - sessionRank(b.session),
  );
  const parts = [
    '# Tape summary',
    '',
    `Generated ${input.generatedAt.toISOString()} by \`pnpm tape:summary\` from \`tape_samples\`, for the window from ${input.since.toISOString()}. Numbers only: the DX report's sentences are written by people.`,
    '',
    `Method: ${input.method}.`,
    '',
    '## Coverage',
    '',
    table(
      ['Runs', 'Rows (token × size)', 'Tokens', 'First run', 'Last run'],
      [
        [
          String(coverage.runs),
          String(coverage.rows),
          String(coverage.tokens),
          coverage.first ?? '—',
          coverage.last ?? '—',
        ],
      ],
    ),
    'Runs per session (our US-equities clock, ET):',
    '',
    table(
      ['Session', 'Runs'],
      sessions.map((s) => [s.session, String(s.runs)]),
    ),
    '## Quotes: refusals and price impact',
    '',
    'Each run quotes every registered token at each size; nothing is executed. Average price impact is over the quotes that were not refused.',
    '',
    table(
      ['Issuer', 'Session', 'Size (USD)', 'Quotes', 'Refused', 'Refused %', 'Avg price impact'],
      quotes.map((q) => [
        q.issuer,
        q.session,
        String(q.sizeUsd),
        String(q.quotes),
        String(q.quoteErrors),
        q.quotes > 0 ? `${((q.quoteErrors / q.quotes) * 100).toFixed(1)} %` : '—',
        pct(q.avgImpactPct),
      ]),
    ),
    '## Gap to the US price',
    '',
    'Per token-run where an independent US price existed (sizes share one price, so a run counts once). Median of the signed gap; 90th percentile of its absolute value.',
    '',
    table(
      ['Issuer', 'Session', 'Token-runs', 'Median gap', 'p90 |gap|'],
      gaps.map((g) => [
        g.issuer,
        g.session,
        String(g.samples),
        pct(g.medianGapPct),
        pct(g.p90AbsGapPct),
      ]),
    ),
    '## Codes the quotes were refused with',
    '',
    table(
      ['Issuer', 'Session', 'Code', 'Quotes', 'Message (as recorded)'],
      input.codes.map((c) => [
        c.issuer,
        c.session,
        c.code,
        String(c.count),
        (c.message ?? '—').slice(0, 160),
      ]),
    ),
    '## Token status as the RWA list reported it',
    '',
    'statusInfo.reasonCode and reasonMsg per token-run: trading, closed, corporate actions.',
    '',
    table(
      ['Issuer', 'Reason code', 'Reason message', 'Token-runs'],
      input.statuses.map((s) => [
        s.issuer,
        s.reasonCode ?? '—',
        s.reasonMsg ?? '—',
        String(s.tokenRuns),
      ]),
    ),
  ];
  return `${parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
