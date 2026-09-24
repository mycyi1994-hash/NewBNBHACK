import { describe, expect, it } from 'vitest';
import { usSession } from './session.js';

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
