import { describe, expect, it } from 'vitest';
import { liveActivationReasons } from './operator-rules.js';

describe('liveActivationReasons (plan:status --activate)', () => {
  const tick = (value: Record<string, unknown>) => ({
    value,
    updatedAt: '2026-09-28T13:00:05.000Z',
  });

  it('asks for nothing when neither this shell nor the worker is live', () => {
    expect(liveActivationReasons('simulate', undefined)).toEqual([]);
    expect(liveActivationReasons('simulate', tick({ mode: 'simulate', at: 'x' }))).toEqual([]);
  });

  it('asks when this shell is live', () => {
    expect(liveActivationReasons('live', tick({ mode: 'simulate' }))).toEqual([
      'EXECUTION_MODE=live here',
    ]);
  });

  it('asks when the worker last ticked live, even from a simulate shell', () => {
    expect(
      liveActivationReasons('simulate', tick({ mode: 'live', at: '2026-09-28T13:00:00.000Z' })),
    ).toEqual(["the worker's last tick at 2026-09-28T13:00:00.000Z ran live"]);
    // Without its own `at`, the row's update time says when.
    expect(liveActivationReasons('live', tick({ mode: 'live' }))).toEqual([
      'EXECUTION_MODE=live here',
      "the worker's last tick at 2026-09-28T13:00:05.000Z ran live",
    ]);
  });

  it('does not read an unrecognised mode as live', () => {
    expect(liveActivationReasons('simulate', tick({ mode: 'LIVE' }))).toEqual([]);
    expect(liveActivationReasons('simulate', tick({}))).toEqual([]);
  });
});
