import { describe, expect, it } from 'vitest';
import { newYorkTimeOn, nextRegularOpen, usSession } from './session.js';

const at = (iso: string) => usSession(new Date(iso));

describe('usSession', () => {
  it('tags EDT sessions (UTC−4)', () => {
    expect(at('2026-09-24T13:29:00Z')).toBe('pre');
    expect(at('2026-09-24T13:30:00Z')).toBe('regular');
    expect(at('2026-09-24T19:59:00Z')).toBe('regular');
    expect(at('2026-09-24T20:00:00Z')).toBe('post');
    expect(at('2026-09-25T00:00:00Z')).toBe('overnight');
    expect(at('2026-09-24T08:00:00Z')).toBe('pre');
  });

  it('follows the DST switch (EST, UTC−5, from 1 Nov 2026)', () => {
    expect(at('2026-11-02T14:29:00Z')).toBe('pre');
    expect(at('2026-11-02T14:30:00Z')).toBe('regular');
  });

  it('tags weekends and NYSE holidays', () => {
    expect(at('2026-09-26T15:00:00Z')).toBe('weekend');
    expect(at('2026-11-26T15:00:00Z')).toBe('holiday');
  });

  it('closes at 13:00 ET on early-close days', () => {
    expect(at('2026-11-27T17:59:00Z')).toBe('regular');
    expect(at('2026-11-27T18:00:00Z')).toBe('post');
  });
});

describe('nextRegularOpen', () => {
  const next = (iso: string) => nextRegularOpen(new Date(iso)).toISOString();

  it('opens later the same day before the bell', () => {
    expect(next('2026-09-28T13:00:00Z')).toBe('2026-09-28T13:30:00.000Z');
  });

  it('moves to the next weekday during and after the session', () => {
    expect(next('2026-09-28T13:30:00Z')).toBe('2026-09-29T13:30:00.000Z');
    expect(next('2026-09-24T02:00:00Z')).toBe('2026-09-24T13:30:00.000Z');
    expect(next('2026-09-24T20:30:00Z')).toBe('2026-09-25T13:30:00.000Z');
  });

  it('skips weekends and full-day holidays', () => {
    expect(next('2026-09-25T21:00:00Z')).toBe('2026-09-28T13:30:00.000Z');
    expect(next('2026-11-25T21:00:00Z')).toBe('2026-11-27T14:30:00.000Z');
  });

  it('follows the switch to EST on 1 Nov 2026', () => {
    expect(next('2026-10-30T21:00:00Z')).toBe('2026-11-02T14:30:00.000Z');
  });
});

describe('newYorkTimeOn', () => {
  it('maps a New York wall time to UTC in both offsets', () => {
    expect(newYorkTimeOn('2026-09-24', 570).toISOString()).toBe('2026-09-24T13:30:00.000Z');
    expect(newYorkTimeOn('2026-12-01', 570).toISOString()).toBe('2026-12-01T14:30:00.000Z');
  });

  it('rejects a wall time that does not exist', () => {
    // 02:30 on 8 Mar 2026 is skipped by the switch to EDT.
    expect(() => newYorkTimeOn('2026-03-08', 150)).toThrow(/no New York wall time/);
  });
});

describe('nextRegularOpen — search limit', () => {
  it('throws instead of looping when no session exists within the window', () => {
    expect(() => nextRegularOpen(new Date('2026-09-26T15:00:00Z'), 1)).toThrow(
      /no NYSE session within 1 days/,
    );
  });
});
