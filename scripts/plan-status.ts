/**
 * pnpm plan:status                                     — list plans
 * pnpm plan:status --plan <id> --activate              — let the scheduler run it
 * pnpm plan:status --plan <id> --pause [--reason <r>]  — stop the scheduler from running it
 *
 * Activating a plan lets a live worker spend for it on its own schedule (within the caps), so it
 * asks for a typed `y` first when EXECUTION_MODE=live here or when the worker's last recorded tick
 * ran live (worker_status 'tick': the worker's mode, not this shell's, decides what it signs). A
 * yield plan cannot be activated without principal on record (the database refuses it). A due time
 * in the past moves to the next regular open + 2 minutes. Any other mix of flags prints the usage
 * line (exit 2).
 */
import { loadConfig } from '@ijaro/config';
import { nextRegularOpen, OPEN_SETTLE_MS } from '@ijaro/core';
import {
  createDb,
  getPlan,
  listPlans,
  migrateDb,
  planFromRow,
  readWorkerStatus,
  updatePlan,
} from '@ijaro/db';
import { parseFlags, type Flags } from './args.js';
import { confirmSpend } from './confirm.js';
import { liveActivationReasons } from './operator-rules.js';

/** A list, an activation or a pause; any other mix of flags is a usage error. */
function misuse({ values, switches }: Flags<'plan' | 'reason', 'activate' | 'pause', never>) {
  if (values.plan === undefined) {
    return switches.activate || switches.pause || values.reason !== undefined
      ? '--activate, --pause and --reason need --plan <id>'
      : undefined;
  }
  if (switches.activate === switches.pause) return '--plan <id> takes --activate or --pause';
  if (values.reason !== undefined && !switches.pause) return '--reason goes with --pause';
  return undefined;
}

const flags = parseFlags(process.argv.slice(2), {
  values: ['plan', 'reason'],
  switches: ['activate', 'pause'],
});
const problem = flags.ok ? misuse(flags) : flags.error;
const config = loadConfig();

if (!flags.ok || problem !== undefined) {
  console.log(
    `${problem}\nusage: pnpm plan:status [--plan <id> --activate | --plan <id> --pause [--reason <text>]]`,
  );
  process.exitCode = 2;
} else if (!config.databaseUrl) {
  console.log('UNAVAILABLE: no DATABASE_URL');
  process.exitCode = 3;
} else {
  const { plan: planId, reason } = flags.values;
  const { db, close } = createDb(config.databaseUrl);
  try {
    await migrateDb(db);
    if (!planId) {
      for (const row of await listPlans(db)) {
        const p = planFromRow(row);
        console.log(
          `${p.id}  ${p.owner.kind} ${p.mode} ${p.target.type === 'ticker' ? p.target.ticker : ''} ` +
            `$${p.contributionUsd} ${p.cadence}  ${p.status}${p.pausedReason ? ` (${p.pausedReason})` : ''}  next ${p.nextDueAt}`,
        );
      }
    } else {
      const row = await getPlan(db, planId);
      if (!row) throw new Error(`plan ${planId} not found`);
      const plan = planFromRow(row);
      if (flags.switches.activate) {
        const now = new Date();
        const nextDueAt =
          Date.parse(plan.nextDueAt) < now.getTime()
            ? new Date(nextRegularOpen(now).getTime() + OPEN_SETTLE_MS).toISOString()
            : plan.nextDueAt;
        const summary =
          `${plan.id}: ${plan.mode} ${plan.target.type === 'ticker' ? plan.target.ticker : ''}, ` +
          `$${plan.contributionUsd} ${plan.cadence}, per buy ≤ $${plan.limits.maxPerBuyUsd}, per day ≤ $${plan.limits.maxDailyUsd}, ` +
          `principal $${plan.principalUsd}; first due ${nextDueAt}`;
        const live = liveActivationReasons(
          config.executionMode,
          await readWorkerStatus(db, 'tick'),
        );
        const ok =
          live.length === 0 ||
          (await confirmSpend(
            `ACTIVATE (${live.join('; ')}) — a live worker spends on schedule: ${summary}.`,
          ));
        if (!ok) {
          console.log('not activated');
        } else {
          try {
            await updatePlan(db, plan.id, { status: 'active', pausedReason: null, nextDueAt });
            console.log(`activated ${summary}`);
          } catch (error) {
            const cause = (error as { cause?: { constraint_name?: string } }).cause;
            if (cause?.constraint_name !== 'plans_yield_principal_ck') throw error;
            console.log(
              `refused: ${plan.id} has no principal on record — deposit it first (pnpm yield:deposit)`,
            );
            process.exitCode = 1;
          }
        }
      } else {
        await updatePlan(db, plan.id, {
          status: 'paused',
          pausedReason: reason ?? 'paused_by_operator',
        });
        console.log(`paused ${plan.id}`);
      }
    }
  } finally {
    await close();
  }
}
