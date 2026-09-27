import { describe, expect, it } from 'vitest';
import { nextDue } from './schedule.js';

const MON_0932 = new Date('2026-09-28T13:32:00Z'); // Mon 09:32 ET (EDT)

describe('nextDue', () => {
  it('waits for a deferred cycle’s own retry time', () => {
    expect(nextDue('daily', MON_0932, '2026-09-29T13:32:00.000Z')).toEqual({
      kind: 'due',
      nextDueAt: '2026-09-29T13:32:00.000Z',
    });
    expect(nextDue('once', MON_0932, '2026-09-29T13:32:00.000Z')).toMatchObject({ kind: 'due' });
  });

  it('moves a daily plan to the next regular open + 2 min', () => {
    expect(nextDue('daily', MON_0932)).toEqual({
      kind: 'due',
      nextDueAt: '2026-09-29T13:32:00.000Z',
    });
    // Friday → Monday.
    expect(nextDue('daily', new Date('2026-10-02T13:32:00Z'))).toEqual({
      kind: 'due',
      nextDueAt: '2026-10-05T13:32:00.000Z',
    });
  });

  it('moves a weekly plan about a week on, skipping a holiday', () => {
    expect(nextDue('weekly', MON_0932)).toEqual({
      kind: 'due',
      nextDueAt: '2026-10-05T13:32:00.000Z',
    });
    // Thanksgiving (Thu 26 Nov 2026) is closed: the next slot is Friday.
    expect(nextDue('weekly', new Date('2026-11-19T14:32:00Z'))).toEqual({
      kind: 'due',
      nextDueAt: '2026-11-27T14:32:00.000Z',
    });
  });

  it('counts New York calendar days, so a DST switch keeps the weekday and the slot', () => {
    // Fri 30 Oct 09:32 EDT → Fri 6 Nov 09:32 EST (not Thu 5 Nov after adding 6 × 24 h).
    expect(nextDue('weekly', new Date('2026-10-30T13:32:00Z'))).toEqual({
      kind: 'due',
      nextDueAt: '2026-11-06T14:32:00.000Z',
    });
  });

  it('never makes a daily plan due again on the day it bought before the open', () => {
    // An anytime plan that bought Mon 08:00 ET is next due Tuesday, not Monday 09:32.
    expect(nextDue('daily', new Date('2026-09-28T12:00:00Z'))).toEqual({
      kind: 'due',
      nextDueAt: '2026-09-29T13:32:00.000Z',
    });
  });

  it('stops a once plan after anything but a deferral', () => {
    expect(nextDue('once', MON_0932)).toEqual({ kind: 'stop' });
  });
});
