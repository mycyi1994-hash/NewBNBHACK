/**
 * pnpm yield:redeem --plan <id> [--live]           — takes a yield plan's whole Venus position back
 *                                                   to the house wallet (human yes 9/27, D-21)
 * pnpm yield:redeem --plan <id> --record <txHash>  — records that redeem when its receipt arrived
 *                                                   after the command stopped waiting
 *
 * Without --live the DeFi build, the calldata checks and the Transaction API simulation run for
 * real; nothing is signed and the plan does not change. --live needs EXECUTION_MODE=live, the
 * house key and a typed `y`; it signs only after the simulation passes, with the outbox settled
 * and the plan's lock held, and leaves the plan paused (operator_redeem). Skill plans are refused:
 * their position is in their owner's wallet (apps/agent/src/operator.ts).
 */
import {
  createRuntime,
  discoverVenusUsdt,
  executorDeps,
  maskHouse,
  operatorRedeem,
  previewOperatorRedeem,
  recordOperatorRedeem,
  type RedeemRefusal,
} from '@ijaro/agent';
import { loadConfig } from '@ijaro/config';
import { migrateDb } from '@ijaro/db';
import type { Hex } from 'viem';
import { parseFlags, TX_HASH } from './args.js';
import { confirmSpend } from './confirm.js';

const REFUSED: Record<RedeemRefusal['reason'], string> = {
  not_found: 'no such plan',
  users_wallet:
    "a skill plan's position is in its owner's wallet; the owner redeems it with the skill",
  not_yield: 'not a yield plan',
  nothing_to_redeem: 'no Venus position on record for this plan',
};

const flags = parseFlags(process.argv.slice(2), {
  values: ['plan', 'record'],
  switches: ['live'],
  required: ['plan'],
});
const json = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

if (!flags.ok || (flags.values.record !== undefined && !TX_HASH.test(flags.values.record))) {
  console.log(
    `${flags.ok ? '--record needs a transaction hash (0x and 64 hex digits)' : flags.error}\n` +
      'usage: pnpm yield:redeem --plan <id> [--live] | --record <txHash>',
  );
  process.exitCode = 2;
} else {
  const planId = flags.values.plan;
  const recordHash = flags.values.record;
  const { live } = flags.switches;
  const config = loadConfig();
  const rt = createRuntime(config);
  const show = (line: string) => console.log(maskHouse(line, rt.redact));
  try {
    await migrateDb(rt.database.db);
    const simulate = executorDeps(rt, 'simulate');
    const venus = await discoverVenusUsdt(simulate);
    show(
      `yield:redeem ${planId}: Venus USDT investment ${venus.investmentId}, vToken ${venus.vToken}`,
    );

    if (recordHash) {
      const done = await recordOperatorRedeem({ ...simulate, venus }, planId, recordHash as Hex);
      console.log(done === 'recorded' ? `recorded ${recordHash}` : 'already recorded');
    } else {
      const preview = await previewOperatorRedeem({ ...simulate, venus }, planId);
      if (preview.kind === 'refused') {
        console.log(`refused: ${planId} — ${REFUSED[preview.reason]}`);
        process.exitCode = 1;
      } else {
        show(json(preview));
        const passes =
          preview.result.kind === 'simulated' && preview.result.redeem.status === 'SUCCESS';
        if (!passes) console.log('the redeem does not pass its checks: nothing would be signed');
        if (live) {
          if (!passes) {
            process.exitCode = 1;
          } else if (config.executionMode !== 'live' || !config.houseWalletPrivateKey) {
            console.log('live: refused — needs EXECUTION_MODE=live and HOUSE_WALLET_PRIVATE_KEY');
            process.exitCode = 1;
          } else if (
            await confirmSpend(
              `LIVE: redeem ${planId}'s whole Venus position (about ${preview.amountUsd} USDT: ` +
                `principal ${preview.principalUsd} plus interest) back to [house]; the plan is paused.`,
            )
          ) {
            const result = await operatorRedeem({ ...executorDeps(rt, 'live'), venus }, planId);
            if (result.kind === 'redeemed') {
              show(`redeemed: https://bscscan.com/tx/${result.txHash} ${json(result.amounts)}`);
              console.log(`${planId} is ${result.plan.status} (${result.plan.pausedReason})`);
            } else if (result.kind === 'failed') {
              console.log(`not redeemed: ${planId} is paused (${result.pausedReason})`);
              for (const hash of result.pending) {
                console.log(
                  `pending: ${hash}; once mined run: pnpm yield:redeem --plan ${planId} --record ${hash}`,
                );
              }
              process.exitCode = 1;
            } else {
              console.log(
                `refused: ${result.reason}` +
                  ('pending' in result ? ` (${result.pending.join(', ')})` : ''),
              );
              process.exitCode = 1;
            }
          } else {
            console.log('live: not confirmed — nothing signed');
          }
        }
      }
    }
  } finally {
    await rt.close();
  }
}
