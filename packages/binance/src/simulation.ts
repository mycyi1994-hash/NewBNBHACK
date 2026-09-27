/**
 * Transaction API simulation results (DECISIONS Q-14). The API answers HTTP 200 with code 0 even
 * when the transaction would revert; the verdict is `data.status`. Anything but SUCCESS stops the
 * cycle before signing (SPEC §5.8 v2).
 */

export interface AllowanceChange {
  tokenAddress: string;
  owner: string;
  spender: string;
  preAmount: string;
  postAmount: string;
}

export interface SimulationResult {
  status: 'SUCCESS' | 'FAILED';
  /** Revert reason, '' on success. */
  failReason: string;
  balanceChanges: unknown[];
  allowanceChanges: AllowanceChange[];
}

/** A simulation that did not succeed; nothing was signed or sent. */
export class SimulationFailedError extends Error {
  constructor(readonly result: SimulationResult) {
    super(`simulation ${result.status}: ${result.failReason || 'no reason given'}`);
    this.name = 'SimulationFailedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Amounts arrive as strings; lossless JSON may hand a large number over as a bigint. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  return '';
}

/** Validates the documented shape; an unexpected shape is an error, never a success. */
export function parseSimulation(data: unknown): SimulationResult {
  if (!isRecord(data)) throw new Error('simulation response has no data object');
  const { status, failReason, balanceChanges, allowanceChanges } = data;
  if (status !== 'SUCCESS' && status !== 'FAILED') {
    throw new Error(`simulation status ${JSON.stringify(status)} is neither SUCCESS nor FAILED`);
  }
  const allowances = Array.isArray(allowanceChanges) ? allowanceChanges : [];
  return {
    status,
    failReason: typeof failReason === 'string' ? failReason : '',
    balanceChanges: Array.isArray(balanceChanges) ? balanceChanges : [],
    allowanceChanges: allowances.filter(isRecord).map((a) => ({
      tokenAddress: text(a.tokenAddress),
      owner: text(a.owner),
      spender: text(a.spender),
      preAmount: text(a.preAmount),
      postAmount: text(a.postAmount),
    })),
  };
}

/** The parsed result when the simulation succeeded; throws SimulationFailedError otherwise. */
export function requireSimulationSuccess(data: unknown): SimulationResult {
  const result = parseSimulation(data);
  if (result.status !== 'SUCCESS') throw new SimulationFailedError(result);
  return result;
}
