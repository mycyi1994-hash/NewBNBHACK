/**
 * The Wallet Skill's contract with the Binance Agentic Wallet CLI: every `baw` command /next
 * returns, and every `baw` line in skills/yieldvest, uses only commands and flags that `baw` has,
 * as recorded from the real CLI by `pnpm baw:help` (fixtures/baw/<version>/). A flag `baw` does not
 * know fails here, not in the user's wallet. No database, no network.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instrument, Plan } from '@yieldvest/core';
import type { TapeSampleRow } from '@yieldvest/db';
import { describe, expect, it } from 'vitest';
import { nextFor, type NextAnswer, type NextContext } from '../lib/server/next';

const BAW_VERSION = '1.10.0';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const helpDir = path.join(root, 'fixtures', 'baw', BAW_VERSION);

/** The options of one command's `--help`: name → whether it takes a value. */
function optionsOf(help: string): Map<string, boolean> {
  const options = new Map<string, boolean>();
  for (const line of help.split('\n')) {
    // `  -h, --help` or `  --amount <amount>`; wrapped descriptions are indented further.
    const match = /^ {2}(?:-\w, )?--([A-Za-z][\w-]*)( <[^>]+>)?/.exec(line);
    if (match?.[1]) options.set(match[1], match[2] !== undefined);
  }
  return options;
}

const commands = new Map<string, Map<string, boolean>>(
  readdirSync(helpDir).map((file) => [
    file.replace(/\.txt$/, ''),
    optionsOf(readFileSync(path.join(helpDir, file), 'utf8')),
  ]),
);
const globals = commands.get('root') ?? new Map<string, boolean>();

/** Problems with one `baw` argv: an unknown command or flag, a flag without its value, a stray word. */
function check(argv: readonly string[]): string[] {
  const [bin, ...rest] = argv;
  if (bin !== 'baw') return [`not a baw command: ${argv.join(' ')}`];
  // The command ends at its first flag (or at an ellipsis standing for the flags).
  const flagAt = rest.findIndex((word) => word.startsWith('--') || word === '…');
  const words = flagAt === -1 ? rest : rest.slice(0, flagAt);
  const key = words.join('-');
  const options = commands.get(key);
  if (!options) return [`baw ${words.join(' ')}: no such command in baw ${BAW_VERSION}`];
  const problems: string[] = [];
  const flags = flagAt === -1 ? [] : rest.slice(flagAt);
  for (let i = 0; i < flags.length; i++) {
    const word = flags[i] ?? '';
    // An ellipsis stands for the flags the step gives (documentation shorthand).
    if (word === '…') continue;
    if (!word.startsWith('--')) {
      problems.push(`baw ${words.join(' ')}: stray '${word}'`);
      continue;
    }
    const name = word.slice(2);
    const takesValue = options.get(name) ?? globals.get(name);
    if (takesValue === undefined) {
      problems.push(`baw ${words.join(' ')}: no --${name} in baw ${BAW_VERSION}`);
      // Its value, if it has one, is not a second problem.
      if (flags[i + 1] !== undefined && !flags[i + 1]?.startsWith('--')) i++;
    } else if (takesValue) {
      const value = flags[i + 1];
      if (value === undefined || value.startsWith('--')) {
        problems.push(`baw ${words.join(' ')}: --${name} needs a value`);
      }
      i++;
    }
  }
  return problems;
}

const MONDAY_10_ET = new Date('2026-09-28T14:00:00.000Z');
const instrument: Instrument = {
  id: 'NVDA:bstocks',
  ticker: 'NVDA',
  issuer: 'bstocks',
  chainId: 56,
  address: '0xA9ee28C80f960B889dFbd1902055218cba016F75',
  symbol: 'NVDAB',
  decimals: 18,
  multiplier: '1.000778223752807865',
  verifiedAt: '2026-09-24T00:45:40.000Z',
};
const plan = (overrides: Partial<Plan> = {}): Plan => ({
  id: 'S-contract',
  owner: { kind: 'skill', token: 'token-id' },
  mode: 'safe',
  target: { type: 'ticker', ticker: 'NVDA' },
  issuerPreference: ['bstocks', 'ondo'],
  principalUsd: '0',
  contributionUsd: '5',
  cadence: 'weekly',
  window: 'regular_session',
  limits: { maxPerBuyUsd: '5', maxDailyUsd: '10' },
  status: 'active',
  createdAt: '2026-09-28T13:00:00.000Z',
  nextDueAt: '2026-09-28T13:32:00.000Z',
  ...overrides,
});
const sampledAt = '2026-09-28T13:55:00.000Z';
const rows = [5, 50, 500].map((sizeUsd, i): TapeSampleRow => ({
  id: i + 1,
  sampledAt,
  slotAt: sampledAt,
  instrumentId: instrument.id,
  session: 'regular',
  openState: true,
  marketStatus: null,
  reasonCode: 'TRADING',
  reasonMsg: null,
  nextOpenTime: null,
  tokenPrice: '225.175',
  referencePrice: '225.1',
  stockPrice: '225',
  stockPriceError: null,
  priceUpdatedAt: sampledAt,
  sizeUsd,
  expectedOut: (4_442_430_800_471_653n * BigInt(sizeUsd)).toString(),
  priceImpactPct: '0.05',
  vendor: 'test',
  executionMode: 'SWAP',
  route: null,
  errorCode: null,
  errorMsg: null,
  latencyMs: 120,
}));
const context = (overrides: Partial<NextContext> = {}): NextContext => ({
  plan: plan(),
  instruments: [instrument],
  tape: { state: 'LIVE', sampledAt, slotAt: sampledAt, ageSeconds: 300, rows },
  caps: { minBuyUsd: '0.25', maxPerTxUsd: '5' },
  dailyRemainingUsd: '10',
  dailyLimitUsd: '10',
  guardian: { blocked: false },
  now: MONDAY_10_ET,
  ...overrides,
});

function argvOf(answer: NextAnswer): string[][] {
  if (answer.decision !== 'buy') throw new Error(`expected a buy, got ${answer.decision}`);
  return answer.steps.flatMap((step) =>
    [step.preview, step.run, step.confirm].filter((argv): argv is string[] => argv !== undefined),
  );
}

describe(`baw ${BAW_VERSION} contract`, () => {
  it('reads the recorded help of every command the skill uses', () => {
    expect([...commands.keys()].sort()).toEqual(
      [
        'approvals-list',
        'approvals-revoke',
        'cli-check',
        'defi-deposit',
        'defi-investment-list',
        'defi-preview',
        'defi-redeem',
        'market-order-list',
        'market-order-quote',
        'market-order-swap',
        'root',
        'wallet-address',
        'wallet-balance',
        'wallet-left-quota',
        'wallet-settings',
        'wallet-status',
        'wallet-tx-lock',
      ].sort(),
    );
    expect(globals.get('json')).toBe(false);
    expect(commands.get('market-order-quote')?.get('fromTokenQty')).toBe(true);
    // The checker itself: an unknown flag, a missing value and an unknown command are caught.
    expect(check(['baw', 'market-order', 'quote', '--amount', '5'])).toEqual([
      `baw market-order quote: no --amount in baw ${BAW_VERSION}`,
    ]);
    expect(check(['baw', 'market-order', 'swap', '--fromTokenQty', '--json'])).toEqual([
      'baw market-order swap: --fromTokenQty needs a value',
    ]);
    expect(check(['baw', 'market-order', 'buy'])).toEqual([
      `baw market-order buy: no such command in baw ${BAW_VERSION}`,
    ]);
  });

  it('/next returns only commands and flags baw has — safe and yield buys', () => {
    const safe = nextFor(context());
    const yieldBuy = nextFor(
      context({
        plan: plan({ mode: 'yield', principalUsd: '100', contributionUsd: '0' }),
        position: { underlyingUsd: '103', harvestedUnspentUsd: '0' },
        venus: { investmentId: 'venus-1' },
      }),
    );
    expect(yieldBuy.decision === 'buy' && yieldBuy.steps.map((s) => s.id)).toEqual([
      'redeem',
      'quote',
      'swap',
    ]);
    const all = [...argvOf(safe), ...argvOf(yieldBuy)];
    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(all.flatMap(check)).toEqual([]);
  });

  it('every baw line in the Wallet Skill uses only commands and flags baw has', () => {
    const skillDir = path.join(root, 'skills', 'yieldvest');
    const files = [
      'SKILL.md',
      ...readdirSync(path.join(skillDir, 'references')).map((f) => `references/${f}`),
    ];
    const lines: string[] = [];
    for (const file of files) {
      const text = readFileSync(path.join(skillDir, file), 'utf8');
      // Inline code spans and code-block lines that start with `baw `.
      for (const match of text.matchAll(/`(baw [^`]+)`/g)) lines.push(match[1] ?? '');
      for (const line of text.split('\n')) if (/^baw /.test(line)) lines.push(line);
    }
    expect(lines.length).toBeGreaterThanOrEqual(10);
    const problems = lines.flatMap((line) => check(line.trim().split(/\s+/)));
    expect(problems).toEqual([]);
  });
});
