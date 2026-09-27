/**
 * Rows → core domain types (SPEC §4). numeric(38,18) columns read back as "5.000000000000000000";
 * the domain sees "5". A value outside a domain union is a data error and throws, never a guess.
 */
import {
  fromUnits,
  toUnits,
  type Cadence,
  type CycleOutcome,
  type Holding,
  type Instrument,
  type Issuer,
  type Plan,
  type PlanMode,
  type PlanOwner,
  type PlanStatus,
  type PlanWindow,
} from '@yieldvest/core';
import type { InstrumentRow } from './index.js';
import type { HoldingRow, PlanRow } from './plans.js';

const ISSUERS: readonly Issuer[] = ['bstocks', 'ondo', 'xstocks'];
const MODES: readonly PlanMode[] = ['safe', 'yield'];
const CADENCES: readonly Cadence[] = ['weekly', 'daily', 'once'];
const WINDOWS: readonly PlanWindow[] = ['regular_session', 'anytime'];
const STATUSES: readonly PlanStatus[] = ['active', 'paused', 'stopped'];
const OUTCOME_KINDS: readonly CycleOutcome['kind'][] = ['BOUGHT', 'DEFERRED', 'SKIPPED', 'FAILED'];

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${field}: unexpected value ${JSON.stringify(value)}`);
}

/** Exact decimal text of a numeric(38,18) value: "5.000000000000000000" → "5". */
export function usdText(value: string): string {
  return fromUnits(toUnits(value, 18), 18);
}

/** Postgres timestamptz text ("2026-09-28 13:32:00+00") → ISO 8601. */
export function isoTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`not a timestamp: ${value}`);
  return time.toISOString();
}

function owner(row: PlanRow): PlanOwner {
  const kind = oneOf(row.ownerKind, ['house', 'judge', 'skill'] as const, 'plans.owner_kind');
  if (kind === 'house') return { kind };
  if (row.ownerRef === null) throw new Error(`plans.owner_ref: ${row.id} (${kind}) has none`);
  return kind === 'judge' ? { kind, code: row.ownerRef } : { kind, token: row.ownerRef };
}

export function planFromRow(row: PlanRow): Plan {
  return {
    id: row.id,
    owner: owner(row),
    mode: oneOf(row.mode, MODES, 'plans.mode'),
    target: { type: 'ticker', ticker: row.ticker },
    issuerPreference: row.issuerPreference.map((i) => oneOf(i, ISSUERS, 'plans.issuer_preference')),
    principalUsd: usdText(row.principalUsd),
    contributionUsd: usdText(row.contributionUsd),
    cadence: oneOf(row.cadence, CADENCES, 'plans.cadence'),
    window: oneOf(row.window, WINDOWS, 'plans.window'),
    limits: { maxPerBuyUsd: usdText(row.maxPerBuyUsd), maxDailyUsd: usdText(row.maxDailyUsd) },
    status: oneOf(row.status, STATUSES, 'plans.status'),
    ...(row.pausedReason === null ? {} : { pausedReason: row.pausedReason }),
    createdAt: isoTime(row.createdAt),
    nextDueAt: isoTime(row.nextDueAt),
    ...(row.expiresAt === null ? {} : { expiresAt: isoTime(row.expiresAt) }),
  };
}

export function instrumentFromRow(row: InstrumentRow): Instrument {
  if (row.chainId !== 56) throw new Error(`instruments.chain_id: ${row.id} is on ${row.chainId}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(row.address)) {
    throw new Error(`instruments.address: ${row.id} is not an address`);
  }
  return {
    id: row.id,
    ticker: row.ticker,
    issuer: oneOf(row.issuer, ISSUERS, 'instruments.issuer'),
    chainId: 56,
    address: row.address as `0x${string}`,
    symbol: row.symbol,
    decimals: row.decimals,
    multiplier: row.multiplier,
    verifiedAt: isoTime(row.verifiedAt),
  };
}

export function holdingFromRow(row: HoldingRow): Holding {
  return {
    planId: row.planId,
    instrumentId: row.instrumentId,
    tokens: row.tokens,
    multiplierAtLastUpdate: row.multiplierAtLastUpdate,
    shares: row.shares,
    costUsd: usdText(row.costUsd),
    updatedAt: isoTime(row.updatedAt),
  };
}

/** A stored `cycles.outcome`, checked for its kind (the worker wrote it from a CycleOutcome). */
export function cycleOutcomeFromJson(value: unknown): CycleOutcome {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (typeof kind !== 'string') throw new Error('cycles.outcome: missing kind');
  oneOf(kind, OUTCOME_KINDS, 'cycles.outcome.kind');
  return value as CycleOutcome;
}
