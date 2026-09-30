import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildNyseVectors,
  serializeVectors,
  SESSION_CODES,
  VECTORS_PATH,
  type NyseVectors,
} from './calendar-vectors.js';

describe('NYSE calendar vectors', () => {
  const built = buildNyseVectors();

  it('are up to date with packages/core/src/session.ts (run `pnpm --filter @yieldvest/rwa-lp vectors`)', () => {
    expect(readFileSync(VECTORS_PATH, 'utf8')).toBe(serializeVectors(built));
  });

  it('cover every session, both covered years and the uncovered years around them', () => {
    const counts = SESSION_CODES.map((_, code) => built.sessions.filter((s) => s === code).length);
    for (const count of counts) expect(count).toBeGreaterThan(100);
    const years = new Set(built.timestamps.map((t) => new Date(t * 1000).getUTCFullYear()));
    expect([...years].sort()).toEqual([2025, 2026, 2027, 2028]);
  });

  it('pair every regular-session instant with that morning’s 09:30 New York open', () => {
    const { timestamps, sessions, openedAt }: NyseVectors = built;
    sessions.forEach((session, i) => {
      const t = timestamps[i] ?? 0;
      const open = openedAt[i] ?? 0;
      if (session === 0) {
        expect(open).toBeLessThanOrEqual(t);
        expect(t - open).toBeLessThan(6.5 * 3600);
      } else {
        expect(open).toBe(0);
      }
    });
  });
});
