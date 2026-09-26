/**
 * pnpm yield:deposit --plan <id> --usd <amount> [--live]   — puts a yield plan's principal into
 *                                                           Venus USDT (TASKS M1-05, SPEC §5.3)
 * pnpm yield:deposit --plan <id> --record <txHash>          — records a deposit whose receipt
 *                                                           arrived after the command gave up
 *
 * The principal cap (config) bounds the plan's total principal. Without --live everything up to
 * the simulations is real and nothing is signed. --live needs EXECUTION_MODE=live, the house key
 * and a typed `y`. The plan's principal and vTokens are written from the confirmed receipt only,
 * once per transaction hash.
 */
import {
  createRuntime,
  depositPrincipal,
  discoverVenusUsdt,
  executorDeps,
  maskHouse,
  type SentTx,
  type VenusMarket,
} from '@ijaro/agent';
import { BSC_USDT, transferredFrom, transferredTo } from '@ijaro/chain';
import { loadConfig } from '@ijaro/config';
import { fromUnits, toUnits } from '@ijaro/core';
import {
  getPlan,
  insertReceipt,
  migrateDb,
  openGuardianActions,
  planFromRow,
  updatePlan,
  usdText,
  type Db,
} from '@ijaro/db';
import type { Hex } from 'viem';
import { confirmSpend } from './confirm.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const valueOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const planId = valueOf('--plan');
const usd = valueOf('--usd');
const recordHash = valueOf('--record') as Hex | undefined;
const live = args.includes('--live');

/** Adds a confirmed deposit to the plan, once per transaction hash. */
async function applyDeposit(db: Db, planId: string, sent: SentTx, vTokens: bigint, usdt: bigint) {
  const fresh = await insertReceipt(db, {
    cycleId: null,
    planId,
    kind: sent.kind,
    txHash: sent.txHash,
    explorerUrl: `https://bscscan.com/tx/${sent.txHash}`,
    chainId: 56,
    amounts: sent.amounts,
    broadcastVia: sent.broadcastVia,
    simulatedAt: sent.simulatedAt,
    blockNumber: sent.receipt.blockNumber.toString(),
    status: 'success',
  });
  if (!fresh || sent.kind !== 'deposit') return fresh;
  const row = await getPlan(db, planId);
  if (!row) throw new Error(`plan ${planId} vanished`);
  await updatePlan(db, planId, {
    principalUsd: fromUnits(toUnits(usdText(row.principalUsd), 18) + usdt, 18),
    vtokenUnits: (BigInt(row.vtokenUnits) + vTokens).toString(),
  });
  return true;
}

if (!planId || (!usd && !recordHash)) {
  console.log('usage: pnpm yield:deposit --plan <id> --usd <amount> [--live] | --record <txHash>');
  process.exitCode = 2;
} else {
  const config = loadConfig();
  const rt = createRuntime(config);
  try {
    await migrateDb(rt.database.db);
    const row = await getPlan(rt.database.db, planId);
    if (!row) throw new Error(`plan ${planId} not found`);
    const plan = planFromRow(row);
    if (plan.mode !== 'yield') throw new Error(`${planId} is a ${plan.mode} plan, not yield`);
    const simulate = executorDeps(rt, 'simulate');
    const market: VenusMarket = await discoverVenusUsdt(simulate);
    console.log(
      `yield:deposit ${planId}: Venus USDT investment ${market.investmentId}, vToken ${market.vToken}`,
    );

    if (recordHash) {
      const receipt = await simulate.chain.receipt(recordHash);
      if (!receipt || receipt.status !== 'success')
        throw new Error(`${recordHash} is not a successful mined transaction`);
      const vTokens = transferredTo(receipt.logs, market.vToken, simulate.house);
      const usdt = transferredFrom(receipt.logs, BSC_USDT, simulate.house);
      if (vTokens === 0n)
        throw new Error(`${recordHash} minted no vTokens to [house]: not a deposit`);
      const sent: SentTx = {
        kind: 'deposit',
        txHash: recordHash,
        broadcastVia: 'unknown',
        receipt,
        simulatedAt: new Date().toISOString(),
        amounts: { vTokensMinted: vTokens.toString(), usdtSpent: usdt.toString() },
      };
      const fresh = await applyDeposit(rt.database.db, planId, sent, vTokens, usdt);
      console.log(
        fresh
          ? `recorded: +${fromUnits(usdt, 18)} USDT principal, +${vTokens} vTokens`
          : 'already recorded',
      );
    } else if (usd) {
      const blocking = (await openGuardianActions(rt.database.db, planId)).find((a) =>
        ['stop_deposits', 'redeem_all', 'pause_buys'].includes(a.action),
      );
      if (blocking)
        throw new Error(`the guardian holds new deposits: ${blocking.rule} (${blocking.action})`);
      const amount = toUnits(usd, 18);
      const cap = toUnits(String(config.caps.maxPrincipalUsd), 18);
      const after = toUnits(plan.principalUsd, 18) + amount;
      if (amount <= 0n || after > cap) {
        throw new Error(
          `principal would be ${fromUnits(after, 18)} USD; the principal cap is ${config.caps.maxPrincipalUsd}`,
        );
      }
      const dry = await depositPrincipal(simulate, { planId, market, amountUsd: usd });
      console.log(
        maskHouse(
          JSON.stringify(dry, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
          rt.redact,
        ),
      );
      if (
        dry.kind === 'simulated' &&
        dry.approve !== 'existing_allowance' &&
        dry.deposit.status === 'FAILED'
      ) {
        console.log(
          '(expected: the exact approval is not on chain in a simulation, so mint() cannot pull USDT yet)',
        );
      }
      if (live) {
        if (config.executionMode !== 'live' || !config.houseWalletPrivateKey) {
          console.log('live: refused — needs EXECUTION_MODE=live and HOUSE_WALLET_PRIVATE_KEY');
          process.exitCode = 1;
        } else if (
          await confirmSpend(
            `LIVE: deposit ${usd} USDT of ${planId}'s principal into Venus from [house] (exact approval).`,
          )
        ) {
          const result = await depositPrincipal(executorDeps(rt, 'live'), {
            planId,
            market,
            amountUsd: usd,
          });
          if (result.kind === 'deposited') {
            for (const sent of result.sent) {
              await applyDeposit(
                rt.database.db,
                planId,
                sent,
                result.vTokensMinted,
                result.usdtSpent,
              );
              console.log(`  ${sent.kind}: https://bscscan.com/tx/${sent.txHash}`);
            }
            console.log(
              `deposited ${fromUnits(result.usdtSpent, 18)} USDT → ${result.vTokensMinted} vTokens`,
            );
          } else if (result.kind === 'pending') {
            for (const sent of result.sent)
              await applyDeposit(rt.database.db, planId, sent, 0n, 0n);
            console.log(
              `pending: ${result.txHash}; once mined run: pnpm yield:deposit --plan ${planId} --record ${result.txHash}`,
            );
          } else {
            console.log(`not deposited: ${JSON.stringify(result)}`);
            process.exitCode = 1;
          }
        } else {
          console.log('live: not confirmed — nothing signed');
        }
      }
    }
  } finally {
    await rt.close();
  }
}
