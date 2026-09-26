/**
 * The public view of a plan (plan detail page, SPEC §8.1): no owner references, the wallet
 * shortened, amounts as decimal strings, times as ISO. Receipts carry their BscScan links.
 */
import {
  cycleOutcomeFromJson,
  holdingFromRow,
  isoTime,
  listCycles,
  listGuardianEvents,
  listHoldings,
  listReceipts,
  planFromRow,
  remainingSpend,
  usdText,
  utcDay,
  type Db,
  type PlanRow,
} from '@ijaro/db';
import type { Config } from '@ijaro/config';

export const shortAddress = (address: string | null) =>
  address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;

export async function planView(db: Db, config: Config, row: PlanRow, now: Date) {
  const plan = planFromRow(row);
  const [cycles, receipts, holdings, events] = await Promise.all([
    listCycles(db, { planIds: [row.id], limit: 100 }),
    listReceipts(db, { planIds: [row.id], limit: 100 }),
    listHoldings(db, row.id),
    listGuardianEvents(db, { planId: row.id, limit: 50 }),
  ]);
  const judge = plan.owner.kind === 'judge';
  const planDaily = plan.limits.maxDailyUsd;
  const remainingToday = await remainingSpend(db, {
    planId: row.id,
    ownerKind: row.ownerKind,
    ownerRef: row.ownerRef,
    day: utcDay(now),
    caps: {
      globalDailyUsd: String(config.caps.dailySpendCapUsd),
      planDailyUsd: planDaily,
      ...(judge ? { judgeTotalUsd: String(config.caps.sandboxMaxPerPlanUsd) } : {}),
    },
  });
  return {
    plan: {
      id: plan.id,
      owner: plan.owner.kind,
      mode: plan.mode,
      ticker: plan.target.type === 'ticker' ? plan.target.ticker : null,
      window: plan.window,
      cadence: plan.cadence,
      contributionUsd: plan.contributionUsd,
      principalUsd: plan.principalUsd,
      harvestedUnspentUsd: usdText(row.harvestedUnspentUsd),
      limits: plan.limits,
      status: plan.status,
      pausedReason: plan.pausedReason ?? null,
      nextDueAt: plan.nextDueAt,
      expiresAt: plan.expiresAt ?? null,
      createdAt: plan.createdAt,
      wallet: shortAddress(row.walletAddress),
    },
    limits: {
      perBuyUsd: plan.limits.maxPerBuyUsd,
      perDayUsd: planDaily,
      remainingTodayUsd: usdText(remainingToday),
      houseDailyCapUsd: String(config.caps.dailySpendCapUsd),
    },
    cycles: cycles.map((c) => ({
      id: c.id,
      dueAt: isoTime(c.dueAt),
      startedAt: isoTime(c.startedAt),
      finishedAt: c.finishedAt ? isoTime(c.finishedAt) : null,
      state: c.state,
      executionMode: c.executionMode,
      outcome: c.outcomeKind ? cycleOutcomeFromJson(c.outcome) : c.outcome,
      why: c.whyKey ? { key: c.whyKey, params: c.whyParams } : null,
      spendUsd: c.spendUsd ? usdText(c.spendUsd) : null,
    })),
    receipts: receipts.map((r) => ({
      kind: r.kind,
      txHash: r.txHash,
      explorerUrl: r.explorerUrl,
      amounts: r.amounts,
      broadcastVia: r.broadcastVia,
      status: r.status,
      cycleId: r.cycleId,
      at: isoTime(r.createdAt),
    })),
    holdings: holdings.map(holdingFromRow),
    guardian: events.map((e) => ({
      rule: e.rule,
      action: e.action,
      detail: e.detail,
      at: isoTime(e.ts),
      resolvedAt: e.resolvedAt ? isoTime(e.resolvedAt) : null,
    })),
  };
}
