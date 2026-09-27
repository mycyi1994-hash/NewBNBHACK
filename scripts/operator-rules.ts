/**
 * The decisions the operator scripts print and exit on, as pure functions (operator-rules.test.ts).
 * The scripts do the I/O.
 */
import {
  maskHouse,
  type ChainPort,
  type CycleReport,
  type DepositResult,
  type SimulatedBuy,
} from '@yieldvest/agent';
import { BSC_USDT } from '@yieldvest/chain';
import { formatShares, fromUnits, toUnits, type Instrument } from '@yieldvest/core';

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

/**
 * Why a dry-run buy would not pass the live run's simulation gate (audit S11), or undefined. A
 * FAILED swap simulation after a simulated approval is expected (the approval is not on chain in
 * a simulation, Q-05); after an allowance that already covers the spend it is not, and neither is
 * a FAILED redeem. The live run would stop at the same simulation (after signing a yield plan's
 * redeem, for a swap), so nothing is gained by asking for `y`.
 */
export function buyProblem(buy: SimulatedBuy): string | undefined {
  if (buy.redeem && buy.redeem.status !== 'SUCCESS') {
    return `the redeem simulation is ${buy.redeem.status}`;
  }
  if (buy.approval === 'existing_allowance' && buy.swapSimulation.status !== 'SUCCESS') {
    return `the swap simulation is ${buy.swapSimulation.status} although the allowance already covers the spend`;
  }
  return undefined;
}

/**
 * cycle:once's exit code (audit S11). 0: the cycle ran as asked — bought, simulated a buy that can
 * pass, sent and waiting for its receipt (the worker completes it), or decided not to buy
 * (SKIPPED, DEFERRED). 1: it FAILED, needs review, did not start (outbox busy, locked, stopped)
 * or its dry run would not pass the simulation gate.
 */
export function cycleExitCode(report: CycleReport): 0 | 1 {
  switch (report.status) {
    case 'simulated':
      return buyProblem(report.buy) === undefined ? 0 : 1;
    case 'done':
      return report.outcome.kind === 'FAILED' ? 1 : 0;
    case 'awaiting_tx':
      return 0;
    default:
      return 1;
  }
}

/**
 * Why a deposit dry run failed (audit S11), or undefined. A build or calldata check that refused
 * (kind 'failed') fails it. A FAILED deposit simulation after a simulated approval is expected
 * (mint() cannot pull USDT the simulation never approved); after an allowance that already covers
 * the amount it is not — the live run refuses to sign it (SIM_DEPOSIT) and has no approval to send.
 */
export function depositProblem(dry: DepositResult): string | undefined {
  switch (dry.kind) {
    case 'failed':
      return `${dry.code}: ${dry.message}`;
    case 'simulated':
      return dry.approve === 'existing_allowance' && dry.deposit.status !== 'SUCCESS'
        ? `the deposit simulation is ${dry.deposit.status} although the allowance already covers the amount`
        : undefined;
    default:
      return `a dry run came back ${dry.kind}`;
  }
}

/**
 * Whether yield:deposit --record may book a transaction as this plan's deposit (audit S15): only a
 * deposit our outbox signed for this plan, as yield:redeem --record requires of a redeem
 * (recordOperatorRedeem). A mint to the house wallet alone proves nothing about whose it is.
 */
export function depositRecordRefusal(
  signed: { planId: string; kind: string } | undefined,
  planId: string,
  txHash: string,
): string | undefined {
  if (!signed) return `${txHash} is not a transaction our outbox signed`;
  if (signed.planId !== planId || signed.kind !== 'deposit') {
    return `${txHash} is ${signed.planId}'s ${signed.kind}, not a deposit of ${planId}`;
  }
  return undefined;
}

/**
 * What the operator does about a transaction a live deposit left unmined (audit S15). It may be
 * the approval (then nothing was deposited, and --record would refuse it) or the deposit itself.
 * `kind` is the outbox's; undefined when the outbox does not know the hash.
 */
export function pendingDepositHint(args: {
  planId: string;
  usd: string;
  txHash: string;
  kind: string | undefined;
}): string {
  const { planId, usd, txHash, kind } = args;
  const link = `https://bscscan.com/tx/${txHash}`;
  switch (kind) {
    case 'deposit':
      return (
        `pending: deposit ${txHash} (${link}) is not mined yet; once it is, record it: ` +
        `pnpm yield:deposit --plan ${planId} --record ${txHash}`
      );
    case 'approve':
      return (
        `pending: approve ${txHash} (${link}) is not mined yet and nothing was deposited; once it ` +
        `is, run the deposit again (pnpm yield:deposit --plan ${planId} --usd ${usd} --live): ` +
        'the allowance then covers it'
      );
    default:
      return `pending: ${txHash} (${link}) is not mined yet and the outbox does not know it; look at it on BscScan first`;
  }
}

/** What depositRefusal reads of a plan. */
export interface DepositPlan {
  id: string;
  ownerKind: string;
  mode: string;
  principalUsd: string;
}

/**
 * Why yield:deposit must not put house USDT into this plan, or undefined (audit L4). Only a house
 * or judge yield plan: a skill plan's position is its owner's own wallet (D-19), so the house key
 * never deposits for it. With `usd` (a new deposit, not a --record): no guardian hold on deposits,
 * and the plan's principal stays within the principal cap — for a judge plan also within the
 * sandbox cap, as the Judge Mode deposit is (apps/agent/src/deposit.ts).
 */
export function depositRefusal(args: {
  plan: DepositPlan;
  usd?: string;
  caps: { maxPrincipalUsd: number; sandboxMaxPerPlanUsd: number };
  guardian: readonly { rule: string; action: string }[];
}): string | undefined {
  const { plan, usd, caps } = args;
  if (plan.ownerKind === 'skill') {
    return `${plan.id} is a skill plan: its principal is in its owner's wallet, and the owner deposits it with the skill`;
  }
  if (plan.ownerKind !== 'house' && plan.ownerKind !== 'judge') {
    return `${plan.id} belongs to a ${plan.ownerKind}, not the house or a judge`;
  }
  if (plan.mode !== 'yield') return `${plan.id} is a ${plan.mode} plan, not yield`;
  if (usd === undefined) return undefined;
  const hold = args.guardian.find((a) =>
    ['stop_deposits', 'redeem_all', 'pause_buys'].includes(a.action),
  );
  if (hold) return `the guardian holds new deposits: ${hold.rule} (${hold.action})`;
  const judge = plan.ownerKind === 'judge';
  const cap = judge
    ? Math.min(caps.maxPrincipalUsd, caps.sandboxMaxPerPlanUsd)
    : caps.maxPrincipalUsd;
  const amount = toUnits(usd, 18);
  const after = toUnits(plan.principalUsd, 18) + amount;
  if (amount <= 0n || after > toUnits(String(cap), 18)) {
    return (
      `principal would be ${fromUnits(after, 18)} USD; the ${judge ? 'judge plan' : 'principal'} ` +
      `cap is ${cap}`
    );
  }
  return undefined;
}

/**
 * Runs `sign` only with the house outbox settled and the plan's lock held (audit S9), in the order
 * operatorRedeem uses: reconcile first (one signer for every plan: an earlier transaction must
 * settle before a new one is signed), then the lock (no cycle runs the plan meanwhile), released
 * whatever `sign` does.
 */
export async function whenSettledAndLocked<T>(
  steps: {
    reconcile: () => Promise<{ pending: string[] }>;
    lock: () => Promise<boolean>;
    release: () => Promise<void>;
  },
  sign: () => Promise<T>,
): Promise<
  { kind: 'outbox_busy'; pending: string[] } | { kind: 'locked' } | { kind: 'ran'; value: T }
> {
  const { pending } = await steps.reconcile();
  if (pending.length > 0) return { kind: 'outbox_busy', pending };
  if (!(await steps.lock())) return { kind: 'locked' };
  try {
    return { kind: 'ran', value: await sign() };
  } finally {
    await steps.release();
  }
}
