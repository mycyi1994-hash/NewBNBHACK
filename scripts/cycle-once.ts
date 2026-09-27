/**
 * pnpm cycle:once --plan <id> [--live] — one cycle of a plan now (TASKS M1-03/M1-04, SPEC §12).
 *
 * Without --live: EXECUTION_MODE does not matter; every API call up to the simulations is real,
 * nothing is signed, and the cycle is recorded with execution_mode 'simulate'.
 * With --live: a simulate pass runs first and prints the amounts, the addresses (the token from the
 * registry, the USDT it pays with, the spender the exact approval names) and the simulation
 * results; then the run needs EXECUTION_MODE=live, the house key, and a typed `y`. The plan's
 * schedule is left alone either way (a manual run); caps and the spend ledger apply as always.
 * A dry run whose simulation fails for a reason the live run would share asks for no `y`.
 * Exit: 0 the cycle ran (bought, simulated, sent and awaiting its receipt, or chose not to buy) ·
 * 1 FAILED, needs review, not started (outbox busy, locked, stopped) or refused · 2 usage.
 */
import { createRuntime, discoverVenusUsdt, executorDeps, runCycle } from '@ijaro/agent';
import { loadConfig } from '@ijaro/config';
import { getPlan, instrumentFromRow, listInstruments, migrateDb, planFromRow } from '@ijaro/db';
import { parseFlags } from './args.js';
import { confirmSpend } from './confirm.js';
import {
  buyProblem,
  cycleExitCode,
  cycleReportText,
  watchAllowances,
  type CycleContext,
} from './operator-rules.js';

const flags = parseFlags(process.argv.slice(2), {
  values: ['plan'],
  switches: ['live'],
  required: ['plan'],
});

if (!flags.ok) {
  console.log(`${flags.error}\nusage: pnpm cycle:once --plan <id> [--live]`);
  process.exitCode = 2;
} else {
  const planId = flags.values.plan;
  const { live } = flags.switches;
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
    const watched = watchAllowances(simulate.chain);
    simulate.chain = watched.chain;
    if (plan.mode === 'yield') simulate.venus = await discoverVenusUsdt(simulate);
    const dry = await runCycle(simulate, plan.id, { manual: true });
    const chosen =
      dry.status === 'simulated'
        ? (await listInstruments(rt.database.db)).find((i) => i.id === dry.buy.instrumentId)
        : undefined;
    const context: CycleContext = {
      instrument: chosen ? instrumentFromRow(chosen) : undefined,
      spenders: watched.spenders,
      vToken: simulate.venus?.vToken,
      redact: rt.redact,
    };
    console.log(cycleReportText(dry, context));
    const problem = dry.status === 'simulated' ? buyProblem(dry.buy) : undefined;
    if (problem) console.log(`dry run: ${problem}; a live run would stop at the same simulation`);
    process.exitCode = cycleExitCode(dry);

    if (live) {
      if (dry.status !== 'simulated') {
        console.log('live: nothing to execute (the simulation did not reach a buy)');
      } else if (problem) {
        console.log(
          'live: refused — the dry run does not pass the simulation gate; nothing signed',
        );
      } else if (config.executionMode !== 'live' || !config.houseWalletPrivateKey) {
        console.log('live: refused — needs EXECUTION_MODE=live and HOUSE_WALLET_PRIVATE_KEY');
        process.exitCode = 1;
      } else if (
        await confirmSpend(
          `LIVE: ${plan.id} buys ${dry.buy.instrumentId} (${context.instrument?.address ?? '?'}) ` +
            `for $${dry.buy.spendUsd} from [house] (exact approval to ${watched.spenders.join(', ') || '?'}, ` +
            `fresh quote, simulation must pass).`,
        )
      ) {
        const deps = executorDeps(rt, 'live');
        if (plan.mode === 'yield') deps.venus = simulate.venus;
        const report = await runCycle(deps, plan.id, { manual: true });
        console.log(cycleReportText(report, context));
        process.exitCode = cycleExitCode(report);
      } else {
        console.log('live: not confirmed — nothing signed');
      }
    }
  } finally {
    await rt.close();
  }
}
