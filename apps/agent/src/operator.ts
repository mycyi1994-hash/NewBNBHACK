/**
 * The operator's redeem (`pnpm yield:redeem`, human yes 9/27 — DECISIONS D-21): takes one house or
 * judge yield plan's whole Venus position back to the house wallet. It is how the $1 live test
 * ends and how principal comes home. A preview runs the same build, calldata checks and
 * simulation and changes nothing. The live run needs live mode, a settled outbox and the plan's
 * lock, signs only after the redeem simulation passes (redeemFromVenus), and leaves the plan
 * paused (a stopped plan stays stopped). A skill plan's position is in its owner's wallet and is
 * never redeemed here (D-19).
 */
import { BSC_USDT, transferredFrom, transferredTo } from '@yieldvest/chain';
import {
  acquirePlanLock,
  applyPositionRedeem,
  getPlan,
  listReceipts,
  outboxByHash,
  releasePlanLock,
  unsettledOutbox,
  usdText,
  type PlanRow,
} from '@yieldvest/db';
import type { Hex } from 'viem';
import type { CycleDeps } from './cycle.js';
import { LOCK_TTL_MS } from './plan-lock.js';
import { settleOutbox } from './settlement.js';
import { redeemFromVenus, type RedeemResult, type VenusMarket } from './executor/venus.js';
import { redeemPlanPosition, wholePositionUsd } from './guardian.js';

export const OPERATOR_REDEEM = 'operator_redeem';

export type RedeemRefusal = {
  kind: 'refused';
  reason: 'not_found' | 'users_wallet' | 'not_yield' | 'nothing_to_redeem';
};

function refusalOf(row: PlanRow | undefined): RedeemRefusal | undefined {
  if (!row) return { kind: 'refused', reason: 'not_found' };
  if (row.ownerKind === 'skill') return { kind: 'refused', reason: 'users_wallet' };
  if (row.mode !== 'yield') return { kind: 'refused', reason: 'not_yield' };
  // One vToken is the dust a whole-position redeem leaves behind.
  if (BigInt(row.vtokenUnits) <= 1n) return { kind: 'refused', reason: 'nothing_to_redeem' };
  return undefined;
}

function venusOf(deps: CycleDeps): VenusMarket {
  if (!deps.venus) throw new Error('Venus USDT is not known (run discoverVenusUsdt first)');
  return deps.venus;
}

export type RedeemPreview =
  | RedeemRefusal
  | {
      kind: 'preview';
      amountUsd: string;
      planVTokens: string;
      principalUsd: string;
      /** `simulated` with the simulation's verdict, or the check that refused the build. */
      result: RedeemResult;
    };

/** Everything up to the signature with simulate deps: build, calldata checks, simulation. */
export async function previewOperatorRedeem(
  deps: CycleDeps,
  planId: string,
): Promise<RedeemPreview> {
  if (deps.mode !== 'simulate') throw new Error('a redeem preview runs with simulate deps');
  const row = await getPlan(deps.db, planId);
  const refused = refusalOf(row);
  if (refused || !row) return refused ?? { kind: 'refused', reason: 'not_found' };
  const market = venusOf(deps);
  const planVTokens = BigInt(row.vtokenUnits);
  const amountUsd = await wholePositionUsd(deps, market, planVTokens);
  const result = await redeemFromVenus(deps, {
    planId,
    cycleId: null,
    market,
    amountUsd,
    planVTokens,
  });
  return {
    kind: 'preview',
    amountUsd,
    planVTokens: row.vtokenUnits,
    principalUsd: usdText(row.principalUsd),
    result,
  };
}

export type RedeemOutcome =
  | RedeemRefusal
  | { kind: 'refused'; reason: 'not_live' | 'locked' }
  | { kind: 'refused'; reason: 'outbox_busy'; pending: string[] }
  | { kind: 'redeemed'; txHash: string; amounts: unknown; plan: PlanRow }
  | { kind: 'failed'; pausedReason: string | null; pending: string[] };

/** Signs and broadcasts the redeem (live deps only); the caller has asked a human first. */
export async function operatorRedeem(deps: CycleDeps, planId: string): Promise<RedeemOutcome> {
  if (deps.mode !== 'live') return { kind: 'refused', reason: 'not_live' };
  const first = refusalOf(await getPlan(deps.db, planId));
  if (first) return first;
  venusOf(deps);
  // One signer for every plan: earlier transactions settle, and their effects are written down,
  // before this one may sign.
  const outbox = await settleOutbox(deps);
  if (outbox.pending.length > 0) {
    return { kind: 'refused', reason: 'outbox_busy', pending: outbox.pending };
  }
  const locked = await acquirePlanLock(deps.db, planId, deps.now(), LOCK_TTL_MS);
  if (!locked) return { kind: 'refused', reason: 'locked' };
  try {
    // Read again under the lock: a cycle may have redeemed interest in between.
    const row = await getPlan(deps.db, planId);
    const refused = refusalOf(row);
    if (refused || !row) return refused ?? { kind: 'refused', reason: 'not_found' };
    const done = await redeemPlanPosition(
      deps,
      row,
      { status: row.status === 'stopped' ? 'stopped' : 'paused', reason: OPERATOR_REDEEM },
      { lockHeld: true },
    );
    const after = await getPlan(deps.db, planId);
    if (done !== 'redeemed' || !after) {
      // A broadcast that was not mined in time stays in the outbox; --record applies it later.
      const pending = (await unsettledOutbox(deps.db))
        .filter((tx) => tx.planId === planId && tx.kind === 'redeem')
        .map((tx) => tx.txHash);
      return { kind: 'failed', pausedReason: after?.pausedReason ?? null, pending };
    }
    const [receipt] = await listReceipts(deps.db, { planIds: [planId], limit: 1 });
    if (!receipt) throw new Error(`redeemed ${planId} but its receipt is missing`);
    return { kind: 'redeemed', txHash: receipt.txHash, amounts: receipt.amounts, plan: after };
  } finally {
    await releasePlanLock(deps.db, planId, locked.lockUntil);
  }
}

/**
 * Records a redeem of this plan that was mined after the live run stopped waiting: only a
 * transaction our outbox signed as this plan's redeem, read from its receipt on chain, once.
 */
export async function recordOperatorRedeem(
  deps: CycleDeps,
  planId: string,
  txHash: Hex,
): Promise<'recorded' | 'already_recorded'> {
  const market = venusOf(deps);
  const signed = await outboxByHash(deps.db, txHash);
  // Only a whole-position redeem sent outside a cycle: a cycle's interest redeem is not one.
  if (!signed || signed.planId !== planId || signed.kind !== 'redeem' || signed.cycleId !== null) {
    throw new Error(`${txHash} is not a position redeem our outbox signed for ${planId}`);
  }
  const receipt = await deps.chain.receipt(txHash);
  if (!receipt || receipt.status !== 'success') {
    throw new Error(`${txHash} is not a successful mined transaction`);
  }
  const vTokensBurned = transferredFrom(receipt.logs, market.vToken, deps.house);
  const usdtReceived = transferredTo(receipt.logs, BSC_USDT, deps.house);
  if (vTokensBurned === 0n) throw new Error(`${txHash} burned no vTokens of [house]`);
  const fresh = await applyPositionRedeem(
    deps.db,
    planId,
    {
      kind: 'redeem',
      txHash,
      broadcastVia: signed.broadcastVia ?? 'unknown',
      blockNumber: receipt.blockNumber,
      status: 'success',
      simulatedAt: null,
      amounts: {
        usdtReceived: usdtReceived.toString(),
        vTokensBurned: vTokensBurned.toString(),
        reason: OPERATOR_REDEEM,
      },
    },
    { usdtReceived, vTokensBurned },
    { pausedReason: OPERATOR_REDEEM },
  );
  return fresh ? 'recorded' : 'already_recorded';
}
