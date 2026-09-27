/**
 * The decisions the operator scripts print and exit on, as pure functions (operator-rules.test.ts).
 * The scripts do the I/O.
 */

/** A worker_status row as readWorkerStatus returns it. */
export interface WorkerStatus {
  value: Record<string, unknown>;
  updatedAt: string;
}

/**
 * Why activating a plan lets money move (audit S7): the worker, not this shell, spends for an
 * active plan, so its mode counts as much as this shell's. Reads EXECUTION_MODE here and the mode
 * of the worker's last recorded tick (worker_status 'tick'); empty when neither is live.
 */
export function liveActivationReasons(
  executionMode: 'simulate' | 'live',
  tick: WorkerStatus | undefined,
): string[] {
  const reasons: string[] = [];
  if (executionMode === 'live') reasons.push('EXECUTION_MODE=live here');
  if (tick?.value.mode === 'live') {
    const at = typeof tick.value.at === 'string' ? tick.value.at : tick.updatedAt;
    reasons.push(`the worker's last tick at ${at} ran live`);
  }
  return reasons;
}
