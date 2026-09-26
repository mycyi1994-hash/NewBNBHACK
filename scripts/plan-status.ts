/**
 * pnpm plan:status                                   — list plans
 * pnpm plan:status --plan <id> --activate            — let the scheduler run it
 * pnpm plan:status --plan <id> --pause [--reason r]  — stop the scheduler from running it
 *
 * Activating a plan while EXECUTION_MODE=live lets the worker spend for it on its own schedule
 * (within the caps), so it asks for a typed `y` first. A yield plan cannot be activated without
 * principal on record (the database refuses it). A due time in the past moves to the next regular
 * open + 2 minutes.
 */
import { loadConfig } from '@ijaro/config';
import { nextRegularOpen, OPEN_SETTLE_MS } from '@ijaro/core';
import { createDb, getPlan, listPlans, migrateDb, planFromRow, updatePlan } from '@ijaro/db';
import { confirmSpend } from './confirm.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const valueOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const planId = valueOf('--plan');
const config = loadConfig();

if (!config.databaseUrl) {
  console.log('UNAVAILABLE: no DATABASE_URL');
  process.exitCode = 3;
} else {
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
      if (args.includes('--activate')) {
        const now = new Date();
        const nextDueAt =
          Date.parse(plan.nextDueAt) < now.getTime()
            ? new Date(nextRegularOpen(now).getTime() + OPEN_SETTLE_MS).toISOString()
            : plan.nextDueAt;
        const summary =
          `${plan.id}: ${plan.mode} ${plan.target.type === 'ticker' ? plan.target.ticker : ''}, ` +
          `$${plan.contributionUsd} ${plan.cadence}, per buy ≤ $${plan.limits.maxPerBuyUsd}, per day ≤ $${plan.limits.maxDailyUsd}, ` +
          `principal $${plan.principalUsd}; first due ${nextDueAt}`;
        const ok =
          config.executionMode !== 'live' ||
          (await confirmSpend(
            `ACTIVATE with EXECUTION_MODE=live — the worker will spend on schedule: ${summary}.`,
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
      } else if (args.includes('--pause')) {
        await updatePlan(db, plan.id, {
          status: 'paused',
          pausedReason: valueOf('--reason') ?? 'paused_by_operator',
        });
        console.log(`paused ${plan.id}`);
      } else {
        console.log('usage: pnpm plan:status [--plan <id> --activate | --pause [--reason text]]');
        process.exitCode = 2;
      }
    }
  } finally {
    await close();
  }
}
