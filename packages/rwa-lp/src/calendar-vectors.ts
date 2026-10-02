/**
 * Differential vectors for the on-chain NYSE calendar (contracts/NyseMarketCalendar.sol). The
 * expected sessions come from the agent's own calendar, packages/core/src/session.ts, so the hook
 * charges the session fee for exactly the session the agent would trade in. `pnpm --filter
 * @yieldvest/rwa-lp vectors` rewrites the file; a vitest test fails while it is out of date, and
 * `forge test` replays every vector against the contract.
 */
import { fileURLToPath } from 'node:url';
import {
  addNewYorkDays,
  newYorkParts,
  newYorkTimeOn,
  usSession,
  type UsSession,
} from '@yieldvest/core';

/** Session codes in the order of `IMarketCalendar.Session`. */
export const SESSION_CODES = [
  'regular',
  'pre',
  'post',
  'overnight',
  'weekend',
  'holiday',
] as const satisfies readonly UsSession[];

export const VECTORS_PATH = fileURLToPath(
  new URL('../vectors/nyse-sessions.json', import.meta.url),
);

export interface NyseVectors {
  generatedFrom: string;
  sessionCodes: readonly UsSession[];
  /** Unix seconds. */
  timestamps: number[];
  /** Index into `sessionCodes`. */
  sessions: number[];
  /** Unix second of 09:30 New York on that day for regular-session vectors, else 0. */
  openedAt: number[];
}

/** New York minutes on both sides of every session boundary, plus midnight and 23:59. */
const BOUNDARY_MINUTES = [0, 239, 240, 569, 570, 779, 780, 959, 960, 1199, 1200, 1439];
/** The last second of the minute before a boundary: seconds are dropped, never rounded up. */
const LAST_SECOND_MINUTES = [569, 779, 959, 1199];
/** Daylight-saving switches (UTC) and the second before each. */
const DST_SWITCHES = [
  '2026-03-08T07:00:00Z',
  '2026-11-01T06:00:00Z',
  '2027-03-14T07:00:00Z',
  '2027-11-07T06:00:00Z',
];
/** Both sides of the years the tables cover, so "a year without a table is closed" is checked. */
const FIRST_DAY = '2025-12-24';
const LAST_DAY = '2028-01-08';
const RANDOM_COUNT = 1000;
const RANDOM_SEED = 0x59564c50;

const REGULAR_OPEN_MINUTE = 9 * 60 + 30;

const unix = (date: Date) => date.getTime() / 1000;

export function buildNyseVectors(): NyseVectors {
  const instants = new Set<number>();
  for (let day = FIRST_DAY; day <= LAST_DAY; day = addNewYorkDays(day, 1)) {
    for (const minute of BOUNDARY_MINUTES) instants.add(unix(newYorkTimeOn(day, minute)));
    for (const minute of LAST_SECOND_MINUTES) instants.add(unix(newYorkTimeOn(day, minute)) + 59);
  }
  for (const iso of DST_SWITCHES) {
    const at = Date.parse(iso) / 1000;
    instants.add(at - 1);
    instants.add(at);
  }
  // A fixed linear congruential sequence: the same "random" instants on every run.
  const from = Date.parse(`${FIRST_DAY}T00:00:00Z`) / 1000;
  const span = Date.parse(`${LAST_DAY}T00:00:00Z`) / 1000 - from;
  let state = RANDOM_SEED;
  for (let i = 0; i < RANDOM_COUNT; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    instants.add(from + (state % span));
  }

  const timestamps = [...instants].sort((a, b) => a - b);
  const sessions = timestamps.map((t) => SESSION_CODES.indexOf(usSession(new Date(t * 1000))));
  const openedAt = timestamps.map((t, i) =>
    sessions[i] === 0
      ? unix(newYorkTimeOn(newYorkParts(new Date(t * 1000)).date, REGULAR_OPEN_MINUTE))
      : 0,
  );
  return {
    generatedFrom: 'packages/core/src/session.ts',
    sessionCodes: SESSION_CODES,
    timestamps,
    sessions,
    openedAt,
  };
}

/** The file content `pnpm vectors` writes: one line, no formatting (the file is prettier-ignored). */
export function serializeVectors(vectors: NyseVectors): string {
  return `${JSON.stringify(vectors)}\n`;
}
