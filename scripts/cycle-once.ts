/**
 * pnpm cycle:once --plan <id> [--live] — one cycle of a plan now (TASKS M1-03/M1-04, SPEC §12).
 *
 * Without --live: EXECUTION_MODE does not matter; every API call up to the simulations is real,
 * nothing is signed, and the cycle is recorded with execution_mode 'simulate'.
 * With --live: a simulate pass runs first and prints the amount, the addresses and the simulation
 * results; then the run needs EXECUTION_MODE=live, the house key, and a typed `y`. The plan's
 * schedule is left alone either way (a manual run); caps and the spend ledger apply as always.
 */
import {
  discoverVenusUsdt,
  executorDeps,
  runCycle,
  type CycleReport,
  createRuntime,
  maskHouse,
} from '@ijaro/agent';
import { loadConfig } from '@ijaro/config';
import { formatShares, toUnits } from '@ijaro/core';
import { getPlan, migrateDb, planFromRow } from '@ijaro/db';
import { confirmSpend } from './confirm.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const planId = args[args.indexOf('--plan') + 1];
const live = args.includes('--live');

function show(report: CycleReport, redact: readonly string[]): string {
  const text = (value: unknown) => maskHouse(JSON.stringify(value), redact);
  switch (report.status) {
    case 'simulated': {
      const b = report.buy;
      const shares = b.expectedShares ? formatShares(toUnits(b.expectedShares, 18)) : '-';
      return [
        `cycle #${report.cycleId} (simulate): would buy ${b.instrumentId} for $${b.spendUsd}`,
        `  quote: ${b.expectedTokens ?? '-'} token units ≈ ${shares} shares; slippage floor ${b.minReceive ?? '-'}`,
        `  approval: ${b.approval === 'existing_allowance' ? 'allowance already covers it' : 'exact approve simulated: SUCCESS'}`,
        `  swap simulation: ${b.swapSimulation.status}${b.swapSimulation.failReason ? ` — ${b.swapSimulation.failReason}` : ''}`,
        b.swapSimulation.status === 'FAILED' && b.approval === 'simulated'
          ? '  (expected: the approval is not on chain in a simulation, so the swap cannot pull USDT yet; the Transaction API simulates one transaction at a time, Q-05)'
          : '',
        b.redeem ? `  redeem simulation: ${b.redeem.status} ${b.redeem.failReason}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'done':
      return [
        `cycle #${report.cycleId}: ${report.outcome.kind} — ${report.why.key} ${text(report.why.params)}`,
        `  outcome: ${text(report.outcome)}`,
        ...report.txHashes.map((hash) => `  tx https://bscscan.com/tx/${hash}`),
      ].join('\n');
    case 'awaiting_tx':
      return `cycle #${report.cycleId}: waiting for ${report.txHash} (https://bscscan.com/tx/${report.txHash}); the worker reconciles it`;
    case 'review':
      return `cycle #${report.cycleId}: NEEDS REVIEW — ${report.message}; the plan is paused`;
    case 'outbox_busy':
      return `not started: earlier transactions are still pending (${report.pending.join(', ')})`;
    default:
      return `not started: ${report.status}`;
  }
}

if (!planId) {
  console.log('usage: pnpm cycle:once --plan <id> [--live]');
  process.exitCode = 2;
} else {
  const config = loadConfig();
  const rt = createRuntime(config);
  try {
    await migrateDb(rt.database.db);
    const row = await getPlan(rt.database.db, planId);
    if (!row) throw new Error(`plan ${planId} not found`);
    const plan = planFromRow(row);
    console.log(
      `cycle:once ${plan.id} — ${plan.mode} ${plan.target.type === 'ticker' ? plan.target.ticker : ''}, ` +
        `$${plan.contributionUsd} ${plan.cadence}, ${plan.window}, status ${plan.status}, ` +
        `caps: per tx $${config.caps.houseMaxPerTxUsd}, day $${config.caps.dailySpendCapUsd}`,
    );
    const simulate = executorDeps(rt, 'simulate');
    if (plan.mode === 'yield') simulate.venus = await discoverVenusUsdt(simulate);
    const dry = await runCycle(simulate, plan.id, { manual: true });
    console.log(show(dry, rt.redact));

    if (live) {
      if (dry.status !== 'simulated') {
        console.log('live: nothing to execute (the simulation did not reach a buy)');
      } else if (config.executionMode !== 'live' || !config.houseWalletPrivateKey) {
        console.log('live: refused — needs EXECUTION_MODE=live and HOUSE_WALLET_PRIVATE_KEY');
        process.exitCode = 1;
      } else if (
        await confirmSpend(
          `LIVE: ${plan.id} buys ${dry.buy.instrumentId} for $${dry.buy.spendUsd} from [house] ` +
            `(exact approval, fresh quote, simulation must pass).`,
        )
      ) {
        const deps = executorDeps(rt, 'live');
        if (plan.mode === 'yield') deps.venus = simulate.venus;
        console.log(show(await runCycle(deps, plan.id, { manual: true }), rt.redact));
      } else {
        console.log('live: not confirmed — nothing signed');
      }
    }
  } finally {
    await rt.close();
  }
}
