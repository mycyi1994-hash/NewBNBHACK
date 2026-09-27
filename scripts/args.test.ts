import { describe, expect, it } from 'vitest';
import { parseFlags } from './args.js';

const CYCLE = { values: ['plan'], switches: ['live'], required: ['plan'] } as const;
const REDEEM = { values: ['plan', 'record'], switches: ['live'], required: ['plan'] } as const;
const STATUS = { values: ['plan', 'reason'], switches: ['activate', 'pause'] } as const;

describe('parseFlags', () => {
  it('reads values and switches', () => {
    expect(parseFlags(['--plan', 'H-SAFE', '--live'], CYCLE)).toEqual({
      ok: true,
      values: { plan: 'H-SAFE' },
      switches: { live: true },
    });
    expect(parseFlags(['--plan=H-SAFE'], CYCLE)).toEqual({
      ok: true,
      values: { plan: 'H-SAFE' },
      switches: { live: false },
    });
  });

  it('ignores the -- that pnpm passes through', () => {
    expect(parseFlags(['--', '--plan', 'H-SAFE', '--', '--live'], CYCLE)).toMatchObject({
      ok: true,
      values: { plan: 'H-SAFE' },
      switches: { live: true },
    });
  });

  it('never takes the first argument as the plan when --plan is missing (cycle:once)', () => {
    expect(parseFlags(['H-SAFE'], CYCLE)).toEqual({
      ok: false,
      error: expect.stringContaining("Unexpected argument 'H-SAFE'") as string,
    });
    expect(parseFlags(['--live'], CYCLE)).toEqual({ ok: false, error: '--plan is required' });
    expect(parseFlags([], CYCLE)).toEqual({ ok: false, error: '--plan is required' });
  });

  it('refuses a value flag without its value (yield:redeem --record)', () => {
    const missing = parseFlags(['--plan', 'H-YIELD', '--record'], REDEEM);
    expect(missing).toEqual({ ok: false, error: expect.stringContaining('--record') as string });
    const empty = parseFlags(['--plan', 'H-YIELD', '--record', ''], REDEEM);
    expect(empty).toEqual({ ok: false, error: "--record needs a value, not ''" });
  });

  it('never reads a following flag as a value (plan:status)', () => {
    const planThenFlag = parseFlags(['--plan', '--activate'], STATUS);
    expect(planThenFlag).toEqual({
      ok: false,
      error: expect.stringContaining("Option '--plan' argument is ambiguous") as string,
    });
    const reasonThenFlag = parseFlags(['--plan', 'H-SAFE', '--pause', '--reason', '--x'], STATUS);
    expect(reasonThenFlag.ok).toBe(false);
    // Spelled inline, a value still may not start with --.
    expect(parseFlags(['--plan=--activate'], STATUS)).toEqual({
      ok: false,
      error: "--plan needs a value, not '--activate'",
    });
  });

  it('refuses unknown flags, repeated flags and values on switches', () => {
    expect(parseFlags(['--plan', 'H-SAFE', '--lvie'], CYCLE)).toEqual({
      ok: false,
      error: "Unknown option '--lvie'",
    });
    expect(parseFlags(['--plan', 'H-SAFE', '--plan', 'H-YIELD'], CYCLE)).toEqual({
      ok: false,
      error: '--plan is given more than once',
    });
    expect(parseFlags(['--plan', 'H-SAFE', '--live', '--live'], CYCLE)).toEqual({
      ok: false,
      error: '--live is given more than once',
    });
    expect(parseFlags(['--plan', 'H-SAFE', '--live=yes'], CYCLE)).toEqual({
      ok: false,
      error: "Option '--live' does not take an argument",
    });
  });

  it('leaves optional values out when they are not given', () => {
    expect(parseFlags([], STATUS)).toEqual({
      ok: true,
      values: {},
      switches: { activate: false, pause: false },
    });
  });
});
