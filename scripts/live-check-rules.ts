/**
 * The GO / NO-GO rules of `pnpm live:check` (docs/LIVE_TEST.md): what must hold before a person
 * types `y` for the small live test. Pure, so every rule has a test; the script gathers the facts.
 */
import { toUnits, type Plan } from '@ijaro/core';

export type Mark = 'ok' | 'warn' | 'fail';
export interface Check {
  name: string;
  mark: Mark;
  detail: string;
}

/** Codes the Binance Web3 API uses for region and compliance blocks (DECISIONS V-11). */
const REGION_CODES = new Set(['40301', '40302', '40303', '40304']);
const MINUTE = 60_000;

export interface LiveCheckFacts {
  now: Date;
  /** The test's size in USD: H-SAFE buys this much once, H-YIELD deposits this much. */
  testUsd: string;
  config: {
    executionMode: 'simulate' | 'live';
    minBuyUsd: string;
    apiCredentials: boolean;
    houseKey: boolean;
    telegram: boolean;
  };
  safe: Plan | undefined;
  yield: Plan | undefined;
  /** Hashes the house signed that are not settled yet. */
  unsettled: string[];
  worker: {
    tick?: { at: string; mode: string };
    tapeSlotAt?: string;
    venusVerifiedAt?: string;
  };
  /** House balances in base units (18 decimals), read on chain; an error when the RPC failed. */
  house: { usdtUnits: bigint; bnbWei: bigint } | { error: string } | undefined;
  venus: { mintPaused: boolean; redeemPaused: boolean } | { error: string } | undefined;
  guardian: { rule: string; action: string }[];
  registry: { ticker: string; issuer: string; verifiedAt: string }[];
  /** api_calls of the last hour: codes as the API returned them. */
  apiCodes: (string | null)[];
}

const usd = (value: string) => toUnits(value, 18);
const minutesAgo = (iso: string, now: Date) =>
  Math.round((now.getTime() - Date.parse(iso)) / MINUTE);
const planText = (p: Plan) =>
  `${p.status}${p.pausedReason ? ` (${p.pausedReason})` : ''}, $${p.contributionUsd} ${p.cadence}, ` +
  `per buy ≤ $${p.limits.maxPerBuyUsd}, per day ≤ $${p.limits.maxDailyUsd}, ${p.window}, next ${p.nextDueAt}`;

export function liveChecks(f: LiveCheckFacts): { checks: Check[]; go: boolean } {
  const checks: Check[] = [];
  const add = (name: string, mark: Mark, detail: string) => checks.push({ name, mark, detail });
  const test = usd(f.testUsd);

  const missing = [
    f.config.apiCredentials ? null : 'Binance Web3 API key/secret',
    f.config.houseKey ? null : 'house key',
  ].filter((m): m is string => m !== null);
  add(
    'config',
    missing.length > 0 ? 'fail' : usd(f.config.minBuyUsd) > test ? 'fail' : 'ok',
    missing.length > 0
      ? `missing here: ${missing.join(', ')} — run the live steps on the worker machine`
      : `mode ${f.config.executionMode} (live steps set EXECUTION_MODE=live for one command), ` +
          `minimum buy $${f.config.minBuyUsd}${usd(f.config.minBuyUsd) > test ? ` is above the $${f.testUsd} test` : ''}`,
  );
  if (!f.config.telegram) add('alerts', 'warn', 'no Telegram: alerts go to the log only');

  if (!f.safe) {
    add('H-SAFE', 'fail', 'missing — pnpm db:seed');
  } else {
    const tooBig =
      usd(f.safe.contributionUsd) > test ||
      usd(f.safe.limits.maxPerBuyUsd) > test ||
      usd(f.safe.limits.maxDailyUsd) > test;
    const scheduled = f.safe.status === 'active' && f.worker.tick?.mode === 'live';
    add(
      'H-SAFE',
      tooBig ? 'fail' : scheduled ? 'warn' : 'ok',
      planText(f.safe) +
        (tooBig
          ? ` — set $${f.testUsd} first: pnpm plan:set --plan H-SAFE --contribution ${f.testUsd} --per-buy ${f.testUsd} --daily ${f.testUsd}`
          : scheduled
            ? ' — active under a live worker: it buys on schedule'
            : ''),
    );
  }
  if (!f.yield) {
    add('H-YIELD', 'fail', 'missing — pnpm db:seed');
  } else {
    add('H-YIELD', 'ok', `${planText(f.yield)}, principal $${f.yield.principalUsd} on record`);
  }

  add(
    'outbox',
    f.unsettled.length > 0 ? 'fail' : 'ok',
    f.unsettled.length > 0
      ? `unsettled: ${f.unsettled.join(', ')} — nothing new signs until these settle`
      : 'settled',
  );

  if (!f.house) {
    add('house', 'fail', 'no house key: balances unknown');
  } else if ('error' in f.house) {
    add('house', 'fail', `balances unreadable (${f.house.error})`);
  } else {
    const needUsdt = test * 2n;
    const wantUsdt = (test * 5n) / 2n;
    const usdt = f.house.usdtUnits;
    const bnb = f.house.bnbWei;
    const text = `USDT ${fmt(usdt)}, BNB ${fmt(bnb)}`;
    if (usdt < needUsdt || bnb < 10n ** 15n) {
      add(
        'house',
        'fail',
        `${text} — need USDT ≥ ${fmt(needUsdt)} (buy + deposit) and BNB ≥ 0.001`,
      );
    } else if (usdt > usd('300')) {
      add('house', 'warn', `${text} — above the $300 house balance limit (SPEC §14)`);
    } else if (usdt < wantUsdt || bnb < 3n * 10n ** 15n) {
      add('house', 'warn', `${text} — thin: USDT ≥ ${fmt(wantUsdt)} and BNB ≥ 0.003 leave room`);
    } else {
      add('house', 'ok', text);
    }
  }

  if (!f.venus) {
    add('venus', 'warn', 'market unknown until the worker has verified it once');
  } else if ('error' in f.venus) {
    add('venus', 'warn', `state unreadable (${f.venus.error})`);
  } else {
    const paused = [f.venus.mintPaused ? 'mint' : null, f.venus.redeemPaused ? 'redeem' : null]
      .filter(Boolean)
      .join(' and ');
    add(
      'venus',
      paused ? 'fail' : 'ok',
      paused ? `${paused} paused on chain` : 'mint and redeem open',
    );
  }

  const blocking = f.guardian.filter((g) =>
    ['pause_buys', 'redeem_all', 'stop_deposits'].includes(g.action),
  );
  add(
    'guardian',
    blocking.length > 0 ? 'fail' : 'ok',
    blocking.length > 0
      ? `open: ${blocking.map((g) => `${g.rule} (${g.action})`).join(', ')}`
      : 'no open rule',
  );

  const ticker = f.safe?.target.type === 'ticker' ? f.safe.target.ticker : undefined;
  const listed = f.registry.filter((i) => i.ticker === ticker);
  if (ticker && listed.length === 0) {
    add('registry', 'fail', `${ticker} is not in the registry (pnpm registry)`);
  } else {
    const oldest = listed.reduce<number>((m, i) => Math.max(m, minutesAgo(i.verifiedAt, f.now)), 0);
    add(
      'registry',
      oldest > 48 * 60 ? 'warn' : 'ok',
      `${f.registry.length} instruments; ${ticker ?? '?'}: ${listed.map((i) => i.issuer).join(', ')}` +
        (oldest > 48 * 60 ? `, verified ${Math.round(oldest / 60)} h ago` : ''),
    );
  }

  const tick = f.worker.tick;
  add(
    'worker',
    !tick || minutesAgo(tick.at, f.now) > 15 ? 'warn' : 'ok',
    tick
      ? `last tick ${minutesAgo(tick.at, f.now)} min ago, mode ${tick.mode}`
      : 'no tick recorded',
  );
  add(
    'tape',
    !f.worker.tapeSlotAt || minutesAgo(f.worker.tapeSlotAt, f.now) > 30 ? 'warn' : 'ok',
    f.worker.tapeSlotAt
      ? `last slot ${minutesAgo(f.worker.tapeSlotAt, f.now)} min ago`
      : 'no tape run recorded',
  );

  const blocked = f.apiCodes.filter((c) => c !== null && REGION_CODES.has(c));
  const ok = f.apiCodes.filter((c) => c === '0').length;
  add(
    'web3api',
    blocked.length > 0 ? 'fail' : f.apiCodes.length === 0 ? 'warn' : 'ok',
    blocked.length > 0
      ? `region/compliance codes in the last hour: ${[...new Set(blocked)].join(', ')} — stop`
      : `${ok}/${f.apiCodes.length} calls with code 0 in the last hour`,
  );

  return { checks, go: checks.every((c) => c.mark !== 'fail') };
}

/** Base units (18 decimals) → "1.2345", four places, rounded down. */
function fmt(units: bigint): string {
  const whole = units / 10n ** 18n;
  const frac = ((units % 10n ** 18n) / 10n ** 14n).toString().padStart(4, '0');
  return `${whole}.${frac}`;
}
