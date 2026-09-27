/** Simulation verdicts: only an explicit SUCCESS lets a transaction be signed (Q-14). */
import { describe, expect, it } from 'vitest';
import { parseSimulation, requireSimulationSuccess, SimulationFailedError } from './simulation.js';

describe('parseSimulation', () => {
  it('keeps the documented fields and fills missing lists', () => {
    expect(parseSimulation({ status: 'SUCCESS' })).toEqual({
      status: 'SUCCESS',
      failReason: '',
      balanceChanges: [],
      allowanceChanges: [],
    });
  });

  it('refuses a shape it does not know instead of guessing success', () => {
    expect(() => parseSimulation(null)).toThrow(/no data object/);
    expect(() => parseSimulation([])).toThrow(/no data object/);
    expect(() => parseSimulation({ status: 'PENDING' })).toThrow(/neither SUCCESS nor FAILED/);
    expect(() => parseSimulation({ success: true })).toThrow(/neither SUCCESS nor FAILED/);
  });
});

describe('requireSimulationSuccess', () => {
  it('throws with the revert reason on FAILED', () => {
    const failed = { status: 'FAILED', failReason: 'execution reverted: math error' };
    expect(() => requireSimulationSuccess(failed)).toThrow(SimulationFailedError);
    try {
      requireSimulationSuccess(failed);
    } catch (error) {
      expect((error as SimulationFailedError).result.failReason).toBe(
        'execution reverted: math error',
      );
    }
    expect(() => requireSimulationSuccess({ status: 'FAILED' })).toThrow('no reason given');
  });
});
