/**
 * The decisions the operator scripts print and exit on, as pure functions (operator-rules.test.ts).
 * The scripts do the I/O.
 */
import { maskHouse, type ChainPort, type CycleReport } from '@ijaro/agent';
import { BSC_USDT } from '@ijaro/chain';
import { formatShares, toUnits, type Instrument } from '@ijaro/core';

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

/**
 * The same chain port, remembering each spender whose USDT allowance was read (audit S10). The buy
 * path reads it for exactly the spender it checked in the approve calldata (ensureApproval), so a
 * dry run can name the spender the live approval would go to. Every call passes through unchanged.
 */
export function watchAllowances(chain: ChainPort): { chain: ChainPort; spenders: string[] } {
  const spenders: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return {
    chain: {
      ...chain,
      allowance: (token, owner, spender) => {
        if (same(token, BSC_USDT) && !spenders.some((s) => same(s, spender)))
          spenders.push(spender);
        return chain.allowance(token, owner, spender);
      },
    },
    spenders,
  };
}

/** What cycle:once shows with a report, beyond the report itself. */
export interface CycleContext {
  /** The registry entry of the instrument the cycle chose. */
  instrument?: Pick<Instrument, 'address' | 'symbol'> | undefined;
  /** Approve spenders the dry run checked (watchAllowances). */
  spenders: readonly string[];
  /** The Venus vToken a yield plan redeems from. */
  vToken?: string | undefined;
  /** The house address in all spellings: shown as [house]. */
  redact: readonly string[];
}

/**
 * A cycle report for the terminal (SPEC §12: before the live `y`, the simulate pass shows the
 * amounts, the addresses and the simulation results — audit S10). The house wallet shows as
 * [house].
 */
export function cycleReportText(report: CycleReport, context: CycleContext): string {
  const text = (value: unknown) => JSON.stringify(value);
  let lines: string[];
  switch (report.status) {
    case 'simulated': {
      const b = report.buy;
      const shares = b.expectedShares ? formatShares(toUnits(b.expectedShares, 18)) : '-';
      const units = toUnits(b.spendUsd, 18).toString();
      const spender =
        context.spenders.length > 0 ? context.spenders.join(', ') : '(not seen in the dry run)';
      const token = context.instrument
        ? `${context.instrument.symbol} ${context.instrument.address}`
        : '(not in the registry)';
      lines = [
        `cycle #${report.cycleId} (simulate): would buy ${b.instrumentId} for $${b.spendUsd} from [house]`,
        `  buys:  ${token}`,
        `  pays:  ${units} units of USDT ${BSC_USDT}`,
        `  quote: ${b.expectedTokens ?? '-'} token units ≈ ${shares} shares; slippage floor ${b.minReceive ?? '-'}`,
        b.approval === 'existing_allowance'
          ? `  approval: the allowance of spender ${spender} already covers it`
          : `  approval: exact approve of ${units} USDT units to spender ${spender}, simulated: SUCCESS`,
        `  swap simulation: ${b.swapSimulation.status}${b.swapSimulation.failReason ? ` — ${b.swapSimulation.failReason}` : ''}`,
        b.swapSimulation.status === 'FAILED' && b.approval === 'simulated'
          ? '  (expected: the approval is not on chain in a simulation, so the swap cannot pull USDT yet; the Transaction API simulates one transaction at a time, Q-05)'
          : '',
        b.redeem
          ? `  redeem simulation (${b.redeem.vTokens} vTokens of ${context.vToken ?? '?'}): ${b.redeem.status}${b.redeem.failReason ? ` — ${b.redeem.failReason}` : ''}`
          : '',
      ];
      break;
    }
    case 'done':
      lines = [
        `cycle #${report.cycleId}: ${report.outcome.kind} — ${report.why.key} ${text(report.why.params)}`,
        `  outcome: ${text(report.outcome)}`,
        ...report.txHashes.map((hash) => `  tx https://bscscan.com/tx/${hash}`),
      ];
      break;
    case 'awaiting_tx':
      lines = [
        `cycle #${report.cycleId}: waiting for ${report.txHash} (https://bscscan.com/tx/${report.txHash}); the worker reconciles it`,
      ];
      break;
    case 'review':
      lines = [`cycle #${report.cycleId}: NEEDS REVIEW — ${report.message}; the plan is paused`];
      break;
    case 'outbox_busy':
      lines = [
        `not started: earlier transactions are still pending (${report.pending.join(', ')})`,
      ];
      break;
    default:
      lines = [`not started: ${report.status}`];
  }
  return maskHouse(lines.filter(Boolean).join('\n'), context.redact);
}
