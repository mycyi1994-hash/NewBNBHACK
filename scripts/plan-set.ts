/**
 * pnpm plan:set --plan <id> [--contribution <usd>] [--per-buy <usd>] [--daily <usd>]
 *               [--cadence daily|weekly|once] [--window regular_session|anytime]
 *
 * Changes a house plan's amounts or schedule inside the caps. The caps are env values and do not
 * change here (CLAUDE.md rule 5). Checked (packages/core `changePlanSettings`): minimum buy ≤ per
 * buy ≤ the house per-transaction cap, per buy ≤ per day ≤ the daily cap, and a safe plan's
 * contribution at least the minimum buy; the database CHECK repeats per buy ≤ per day. Judge and
 * skill plans belong to their owners and are refused. An active plan asks for a typed `y` first:
 * the worker spends the new amounts at its next due time.
 */
import { loadConfig } from '@yieldvest/config';
import { changePlanSettings, planSettings, type PlanSettingsChange } from '@yieldvest/core';
import { createDb, getPlan, migrateDb, planFromRow, updatePlan } from '@yieldvest/db';
import { parseFlags } from './args.js';
import { confirmSpend } from './confirm.js';

const FLAGS = {
  contribution: 'contributionUsd',
  'per-buy': 'maxPerBuyUsd',
  daily: 'maxDailyUsd',
  cadence: 'cadence',
  window: 'window',
} as const;
const USAGE =
  'usage: pnpm plan:set --plan <id> [--contribution usd] [--per-buy usd] [--daily usd] ' +
  '[--cadence daily|weekly|once] [--window regular_session|anytime]';

// Strict like every operator script (audit S20): a misspelt or repeated flag is a usage error,
// never a change silently left out.
const flags = parseFlags(process.argv.slice(2), {
  values: ['plan', ...(Object.keys(FLAGS) as (keyof typeof FLAGS)[])],
  required: ['plan'],
});
const change: PlanSettingsChange = {};
if (flags.ok) {
  for (const [flag, key] of Object.entries(FLAGS) as [
    keyof typeof FLAGS,
    (typeof FLAGS)[keyof typeof FLAGS],
  ][]) {
    const value = flags.values[flag];
    if (value !== undefined) change[key] = value;
  }
}
const config = loadConfig();

if (!flags.ok || Object.keys(change).length === 0) {
  console.log(`${flags.ok ? 'nothing to change' : flags.error}\n${USAGE}`);
  process.exitCode = 2;
} else if (!config.databaseUrl) {
  console.log('UNAVAILABLE: no DATABASE_URL');
  process.exitCode = 3;
} else {
  const { db, close } = createDb(config.databaseUrl);
  try {
    await migrateDb(db);
    const planId = flags.values.plan;
    const row = await getPlan(db, planId);
    if (!row) throw new Error(`plan ${planId} not found`);
    const plan = planFromRow(row);
    if (plan.owner.kind !== 'house') {
      console.log(`refused: ${plan.id} is a ${plan.owner.kind} plan; plan:set changes house plans`);
      process.exitCode = 1;
    } else {
      const { settings, problems } = changePlanSettings(plan, change, {
        minBuyUsd: String(config.caps.minBuyUsd),
        maxPerTxUsd: String(config.caps.houseMaxPerTxUsd),
        dailyCapUsd: String(config.caps.dailySpendCapUsd),
      });
      const text = (s: typeof settings) =>
        `$${s.contributionUsd} ${s.cadence}, per buy ≤ $${s.maxPerBuyUsd}, per day ≤ $${s.maxDailyUsd}, ${s.window}`;
      const summary = `${plan.id} (${plan.mode}, ${plan.status}): ${text(planSettings(plan))} → ${text(settings)}`;
      if (problems.length > 0) {
        console.log(`refused: ${summary}`);
        for (const problem of problems) console.log(`  - ${problem}`);
        process.exitCode = 1;
      } else {
        const ok =
          plan.status !== 'active' ||
          (await confirmSpend(
            `CHANGE an active plan — the worker spends the new amounts at its next due time: ${summary}.`,
          ));
        if (!ok) {
          console.log('not changed');
          process.exitCode = 1;
        } else {
          await updatePlan(db, plan.id, settings);
          console.log(`changed ${summary}`);
        }
      }
    }
  } finally {
    await close();
  }
}
