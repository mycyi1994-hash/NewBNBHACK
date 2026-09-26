/**
 * The worker tick (SPEC §5, TASKS M1-06): every five minutes, in this order —
 *   1. live: settle the house outbox (a transaction left PENDING blocks new signing);
 *   2. finish cycles that were waiting for such a transaction;
 *   3. the guardian (PLAN §7);
 *   4. jobs the web queued (preview, run, stop — the web never signs, SPEC §5 v2);
 *   5. every active plan that is due, one at a time (one signer, one nonce sequence).
 * A failure in one plan is logged and alerted; the tick goes on with the next.
 */
import { BSC_USDT } from '@ijaro/chain';
import { nextDue } from '@ijaro/core';
import {
  claimJob,
  duePlans,
  finishJob,
  getPlan,
  planFromRow,
  updatePlan,
  usdText,
  writeWorkerStatus,
  type JobRow,
} from '@ijaro/db';
import { completeAwaitingCycles } from './awaiting.js';
import { runCycle, type CycleDeps, type CycleReport } from './cycle.js';
import { startYieldPlan } from './deposit.js';
import { reconcileOutbox, type Reconciliation } from './executor/send.js';
import { guardianTick, redeemPlanPosition, type GuardianReport } from './guardian.js';

export const TICK_MS = 5 * 60_000;
/**
 * Web jobs are also polled between ticks, so a judge's preview or run starts within seconds
 * (the 3-minute Judge Mode path), always under the tick's one-at-a-time lock (main.ts).
 */
export const JOB_POLL_MS = 3_000;
const MAX_JOBS_PER_TICK = 20;

export interface TickReport {
  at: string;
  reconciled?: Reconciliation;
  completed: string[];
  guardian?: GuardianReport;
  jobs: { id: string; kind: string; status: 'done' | 'failed' }[];
  cycles: CycleReport[];
  errors: string[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** JSON-safe copy of a report (bigints become strings). */
function plain(value: unknown): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Record<string, unknown>;
}

/** One job from the web. `preview` never signs, whatever the worker's mode. */
export async function processJob(
  deps: CycleDeps,
  simulate: CycleDeps,
  job: JobRow,
): Promise<Record<string, unknown>> {
  switch (job.kind) {
    case 'preview':
      return plain(await runCycle(simulate, job.planId, { manual: true }));
    case 'run': {
      const plan = await getPlan(deps.db, job.planId);
      if (!plan) throw new Error(`plan ${job.planId} not found`);
      // A yield plan starts with its principal (Judge Mode "이자로 사기").
      if (plan.mode === 'yield' && usdText(plan.principalUsd) === '0') {
        const depositUsd = (job.payload as { depositUsd?: unknown }).depositUsd;
        if (typeof depositUsd !== 'string')
          throw new Error('a yield plan starts with payload.depositUsd');
        return startYieldPlan(deps, plan, depositUsd);
      }
      const report = await runCycle(deps, job.planId, { manual: true });
      // A judge's first run starts the plan: it keeps running on its own until it expires (7 days)
      // or the code's cap is used up. A deferred first run starts at the time it was deferred to.
      if (
        deps.mode === 'live' &&
        plan.status === 'paused' &&
        plan.pausedReason === 'awaiting_run'
      ) {
        const retryAt =
          report.status === 'done' && report.outcome.kind === 'DEFERRED'
            ? report.outcome.retryAt
            : undefined;
        const next = nextDue(planFromRow(plan).cadence, deps.now(), retryAt);
        await updatePlan(
          deps.db,
          plan.id,
          next.kind === 'stop'
            ? { status: 'stopped', pausedReason: 'done' }
            : { status: 'active', pausedReason: null, nextDueAt: next.nextDueAt },
        );
      }
      return plain(report);
    }
    case 'stop': {
      const plan = await getPlan(deps.db, job.planId);
      if (!plan) throw new Error(`plan ${job.planId} not found`);
      const redeemed = await redeemPlanPosition(deps, plan, {
        status: 'stopped',
        reason: 'stopped_by_owner',
      });
      return { status: 'stopped', redeemed };
    }
    default:
      throw new Error(`unknown job kind ${job.kind}`);
  }
}

/** Every queued web job, oldest first (at most MAX_JOBS_PER_TICK); a failed job never stops the rest. */
export async function processJobs(
  deps: CycleDeps,
  simulate: CycleDeps,
): Promise<Pick<TickReport, 'jobs' | 'errors'>> {
  const done: Pick<TickReport, 'jobs' | 'errors'> = { jobs: [], errors: [] };
  for (let n = 0; n < MAX_JOBS_PER_TICK; n++) {
    const job = await claimJob(deps.db);
    if (!job) break;
    try {
      await finishJob(deps.db, job.id, {
        status: 'done',
        result: await processJob(deps, simulate, job),
      });
      done.jobs.push({ id: job.id, kind: job.kind, status: 'done' });
    } catch (error) {
      await finishJob(deps.db, job.id, { status: 'failed', error: message(error) });
      done.jobs.push({ id: job.id, kind: job.kind, status: 'failed' });
      done.errors.push(`job ${job.id}: ${message(error)}`);
    }
  }
  return done;
}

export async function schedulerTick(deps: CycleDeps, simulate: CycleDeps): Promise<TickReport> {
  const report: TickReport = {
    at: deps.now().toISOString(),
    completed: [],
    jobs: [],
    cycles: [],
    errors: [],
  };
  const guard = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      report.errors.push(`${what}: ${message(error)}`);
      deps.log(`tick: ${what} FAILED — ${message(error)}`);
      await deps.alerter?.send({
        key: `tick:${what}`,
        text: `[ijaro] worker ${what} failed: ${message(error)}`,
      });
    }
  };

  if (deps.mode === 'live') {
    await guard('reconcile', async () => {
      report.reconciled = await reconcileOutbox(deps, { from: deps.house, waitMs: 5_000 });
    });
  }
  await guard('awaiting', async () => {
    report.completed = await completeAwaitingCycles(deps);
  });
  await guard('guardian', async () => {
    report.guardian = await guardianTick(deps);
  });
  const jobs = await processJobs(deps, simulate);
  report.jobs.push(...jobs.jobs);
  report.errors.push(...jobs.errors);
  for (const plan of await duePlans(deps.db, deps.now())) {
    if (plan.ownerKind === 'skill') continue; // decided by /next, signed by the owner
    await guard(`cycle ${plan.id}`, async () => {
      report.cycles.push(await runCycle(deps, plan.id));
    });
  }
  await guard('house balance', async () => {
    const [usdt, bnb] = await Promise.all([
      deps.chain.balanceOf(BSC_USDT, deps.house),
      deps.chain.nativeBalance(deps.house),
    ]);
    await writeWorkerStatus(deps.db, 'house', {
      usdtUnits: usdt.toString(),
      bnbWei: bnb.toString(),
      at: deps.now().toISOString(),
    });
  });
  await writeWorkerStatus(deps.db, 'tick', {
    at: report.at,
    mode: deps.mode,
    cycles: report.cycles.map((c) => ({ planId: c.planId, status: c.status })),
    jobs: report.jobs.length,
    completed: report.completed.length,
    guardianOpen: report.guardian?.actions.map((a) => a.rule) ?? [],
    errors: report.errors,
  });
  return report;
}
