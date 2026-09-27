/**
 * pnpm yield:deposit --plan <id> --usd <amount> [--live]   — puts a yield plan's principal into
 *                                                           Venus USDT (TASKS M1-05, SPEC §5.3)
 * pnpm yield:deposit --plan <id> --record <txHash>          — records a deposit whose receipt
 *                                                           arrived after the command gave up:
 *                                                           only a deposit our outbox signed for
 *                                                           this plan
 *
 * House and judge yield plans only: a skill plan's principal is its owner's own wallet, never the
 * house's to deposit. The principal cap (config; for a judge plan also the sandbox cap) bounds the
 * plan's total principal, and the guardian can hold new deposits. Without --live everything up to
 * the simulations is real and nothing is signed. --live needs EXECUTION_MODE=live, the house key
 * and a typed `y`, and a dry run that did not fail (a FAILED mint simulation after a simulated
 * approval is expected and does not count). The plan's principal and vTokens are written from the
 * confirmed receipt only, once per transaction hash. Exit: 0 done · 1 failed or refused · 2 usage.
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
import { fromUnits } from '@ijaro/core';
import {
  applyDeposit,
  getPlan,
  migrateDb,
  openGuardianActions,
  outboxByHash,
  planFromRow,
  type PlanRow,
} from '@ijaro/db';
import type { Hex } from 'viem';
import { parseFlags, TX_HASH, type Flags } from './args.js';
import { confirmSpend } from './confirm.js';
import {
  depositProblem,
  depositRecordRefusal,
  depositRefusal,
  pendingDepositHint,
} from './operator-rules.js';

/** A deposit (--usd, maybe --live) or a record (--record); any other mix is a usage error. */
function misuse({ values }: Flags<'plan' | 'usd' | 'record', 'live', 'plan'>) {
  if ((values.usd === undefined) === (values.record === undefined)) {
    return 'give --usd <amount> or --record <txHash>';
  }
  if (values.usd !== undefined && !/^\d+(\.\d{1,18})?$/.test(values.usd)) {
    return '--usd needs an amount in dollars, e.g. 1 or 2.50';
  }
  if (values.record !== undefined && !TX_HASH.test(values.record)) {
    return '--record needs a transaction hash (0x and 64 hex digits)';
  }
  return undefined;
}

const flags = parseFlags(process.argv.slice(2), {
  values: ['plan', 'usd', 'record'],
  switches: ['live'],
  required: ['plan'],
});
const problem = flags.ok ? misuse(flags) : flags.error;

/** SentTx → the facts the receipts table keeps. */
const factsOf = (sent: SentTx) => ({
  kind: sent.kind,
  txHash: sent.txHash,
  broadcastVia: sent.broadcastVia,
  blockNumber: sent.receipt.blockNumber,
  status: 'success' as const,
  simulatedAt: sent.simulatedAt,
  amounts: sent.amounts,
});

if (!flags.ok || problem !== undefined) {
  console.log(
    `${problem}\nusage: pnpm yield:deposit --plan <id> --usd <amount> [--live] | --record <txHash>`,
  );
  process.exitCode = 2;
} else {
  const { plan: planId, usd } = flags.values;
  const recordHash = flags.values.record as Hex | undefined;
  const { live } = flags.switches;
  const config = loadConfig();
  const rt = createRuntime(config);
  try {
    await migrateDb(rt.database.db);
    /** Why this plan takes no deposit (or, without `amountUsd`, no --record); see depositRefusal. */
    const refusalFor = async (row: PlanRow, amountUsd: string | undefined) => {
      const plan = planFromRow(row);
      return depositRefusal({
        plan: {
          id: plan.id,
          ownerKind: plan.owner.kind,
          mode: plan.mode,
          principalUsd: plan.principalUsd,
        },
        ...(amountUsd === undefined ? {} : { usd: amountUsd }),
        caps: config.caps,
        guardian: amountUsd === undefined ? [] : await openGuardianActions(rt.database.db, planId),
      });
    };
    const row = await getPlan(rt.database.db, planId);
    if (!row) throw new Error(`plan ${planId} not found`);
    const refused = await refusalFor(row, usd);
    const simulate = executorDeps(rt, 'simulate');
    const venus = async (): Promise<VenusMarket> => {
      const market = await discoverVenusUsdt(simulate);
      console.log(
        `yield:deposit ${planId}: Venus USDT investment ${market.investmentId}, vToken ${market.vToken}`,
      );
      return market;
    };

    if (refused) {
      console.log(`refused: ${refused}`);
      process.exitCode = 1;
    } else if (recordHash) {
      const signed = await outboxByHash(rt.database.db, recordHash);
      const refusal = depositRecordRefusal(signed, planId, recordHash);
      if (refusal || !signed) {
        console.log(`refused: ${refusal}; --record books only a deposit it signed for ${planId}`);
        process.exitCode = 1;
      } else {
        const market = await venus();
        const receipt = await simulate.chain.receipt(recordHash);
        if (!receipt || receipt.status !== 'success')
          throw new Error(`${recordHash} is not a successful mined transaction`);
        const vTokens = transferredTo(receipt.logs, market.vToken, simulate.house);
        const usdt = transferredFrom(receipt.logs, BSC_USDT, simulate.house);
        if (vTokens === 0n)
          throw new Error(`${recordHash} minted no vTokens to [house]: not a deposit`);
        const fresh = await applyDeposit(
          rt.database.db,
          planId,
          {
            kind: 'deposit',
            txHash: recordHash,
            broadcastVia: signed.broadcastVia ?? 'unknown',
            blockNumber: receipt.blockNumber,
            status: 'success',
            simulatedAt: null,
            amounts: { vTokensMinted: vTokens.toString(), usdtSpent: usdt.toString() },
          },
          { vTokens, usdtSpent: usdt },
        );
        console.log(
          fresh
            ? `recorded: +${fromUnits(usdt, 18)} USDT principal, +${vTokens} vTokens`
            : 'already recorded',
        );
      }
    } else if (usd) {
      const market = await venus();
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
      const failure = depositProblem(dry);
      if (failure) {
        console.log(maskHouse(`dry run failed: ${failure}`, rt.redact));
        process.exitCode = 1;
      }
      if (live) {
        if (failure) {
          console.log('live: refused — the dry run failed; nothing signed');
        } else if (config.executionMode !== 'live' || !config.houseWalletPrivateKey) {
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
              const deposit = sent.kind === 'deposit';
              await applyDeposit(rt.database.db, planId, factsOf(sent), {
                vTokens: deposit ? result.vTokensMinted : 0n,
                usdtSpent: deposit ? result.usdtSpent : 0n,
              });
              console.log(`  ${sent.kind}: https://bscscan.com/tx/${sent.txHash}`);
            }
            console.log(
              `deposited ${fromUnits(result.usdtSpent, 18)} USDT → ${result.vTokensMinted} vTokens`,
            );
          } else if (result.kind === 'pending') {
            for (const sent of result.sent) {
              await applyDeposit(rt.database.db, planId, factsOf(sent), {
                vTokens: 0n,
                usdtSpent: 0n,
              });
            }
            const pending = await outboxByHash(rt.database.db, result.txHash);
            console.log(
              pendingDepositHint({ planId, usd, txHash: result.txHash, kind: pending?.kind }),
            );
          } else {
            console.log(maskHouse(`not deposited: ${JSON.stringify(result)}`, rt.redact));
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
