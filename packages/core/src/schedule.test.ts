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

  it('stops a once plan after anything but a deferral', () => {
    expect(nextDue('once', MON_0932)).toEqual({ kind: 'stop' });
  });
});
