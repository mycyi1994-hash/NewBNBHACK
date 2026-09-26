/**
 * The worker tick (SPEC §5, TASKS M1-06): every five minutes, in this order —
 *   1. live: settle the house outbox (a transaction left PENDING blocks new signing);
 *   2. finish cycles that were waiting for such a transaction;
 *   3. the guardian (PLAN §7);
 *   4. jobs the web queued (preview, run, stop — the web never signs, SPEC §5 v2);
 *   5. every active plan that is due, one at a time (one signer, one nonce sequence).
 * A failure in one plan is logged and alerted; the tick goes on with the next.
 */
import { claimJob, duePlans, finishJob, getPlan, type JobRow } from '@ijaro/db';
import { completeAwaitingCycles } from './awaiting.js';
import { runCycle, type CycleDeps, type CycleReport } from './cycle.js';
import { reconcileOutbox, type Reconciliation } from './executor/send.js';
import { guardianTick, redeemPlanPosition, type GuardianReport } from './guardian.js';

export const TICK_MS = 5 * 60_000;
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
    case 'run':
      return plain(await runCycle(deps, job.planId, { manual: true }));
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
  for (let n = 0; n < MAX_JOBS_PER_TICK; n++) {
    const job = await claimJob(deps.db);
    if (!job) break;
    try {
      await finishJob(deps.db, job.id, {
        status: 'done',
        result: await processJob(deps, simulate, job),
      });
      report.jobs.push({ id: job.id, kind: job.kind, status: 'done' });
    } catch (error) {
      await finishJob(deps.db, job.id, { status: 'failed', error: message(error) });
      report.jobs.push({ id: job.id, kind: job.kind, status: 'failed' });
      report.errors.push(`job ${job.id}: ${message(error)}`);
    }
  }
  for (const plan of await duePlans(deps.db, deps.now())) {
    if (plan.ownerKind === 'skill') continue; // decided by /next, signed by the owner
    await guard(`cycle ${plan.id}`, async () => {
      report.cycles.push(await runCycle(deps, plan.id));
    });
  }
  return report;
}
