/**
 * Guardian rules (PLAN §7, SPEC §6): pure, evaluated every tick. The worker gathers the inputs
 * (Venus flags and utilisation on chain, protocol TVL from the DeFi API, the USDT price from the
 * Market API), records every firing in guardian_events and carries out the actions; decideCycle
 * only honours the verdict. Price gap, price impact, caps and asset status are decideCycle's own
 * steps and are not repeated here.
 */

export type GuardianRule = 'protocol_paused' | 'tvl_drop' | 'utilization_high' | 'usdt_depeg';

export interface GuardianAction {
  rule: GuardianRule;
  /**
   * redeem_all: take yield plans out of Venus (only after a successful simulation) and pause them.
   * pause_buys: no plan buys while the rule holds. stop_deposits: no new principal. warn: show it.
   */
  action: 'redeem_all' | 'pause_buys' | 'stop_deposits' | 'warn';
  detail: Record<string, string>;
}

export interface GuardianInputs {
  now: Date;
  /** Venus vUSDT market, read on chain; undefined when the read failed. */
  venus?: { mintPaused: boolean; redeemPaused: boolean; utilizationBps: number };
  /** Venus protocol TVL now and about 24 h ago (DeFi API samples); dayAgo null until known. */
  tvl?: { nowUsd: number; dayAgoUsd: number | null };
  /** USDT price and since when it has stayed below the peg threshold (null: it has not). */
  usdt?: { priceUsd: number; belowPegSince: string | null };
}

export const TVL_DROP_PCT = 30;
export const UTILIZATION_LIMIT_BPS = 9_500;
export const USDT_PEG_FLOOR = 0.99;
export const USDT_DEPEG_MS = 30 * 60_000;

/** A usable positive reading: a bad sample (0, NaN, "") counts as missing, never as a crash. */
const usable = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Rules this tick could not evaluate for lack of data. Their open events stay open: missing
 * data is never read as "all clear" (a dead feed must not resolve a redeem_all).
 */
export function unevaluatedRules(inputs: GuardianInputs): GuardianRule[] {
  const rules: GuardianRule[] = [];
  if (!inputs.venus) rules.push('protocol_paused', 'utilization_high');
  if (!usable(inputs.tvl?.nowUsd) || !usable(inputs.tvl?.dayAgoUsd)) rules.push('tvl_drop');
  if (!usable(inputs.usdt?.priceUsd)) rules.push('usdt_depeg');
  return rules;
}

export function evaluateGuardian(inputs: GuardianInputs): GuardianAction[] {
  const actions: GuardianAction[] = [];
  const { venus, tvl, usdt } = inputs;

  if (venus && (venus.mintPaused || venus.redeemPaused)) {
    const detail = {
      mintPaused: String(venus.mintPaused),
      redeemPaused: String(venus.redeemPaused),
    };
    // With redemptions paused nothing can be taken out: stop buying and wait for a human.
    actions.push({
      rule: 'protocol_paused',
      action: venus.redeemPaused ? 'pause_buys' : 'redeem_all',
      detail,
    });
  }

  if (tvl && usable(tvl.nowUsd) && usable(tvl.dayAgoUsd)) {
    const changePct = (tvl.nowUsd / tvl.dayAgoUsd - 1) * 100;
    if (changePct <= -TVL_DROP_PCT) {
      actions.push({
        rule: 'tvl_drop',
        action: 'redeem_all',
        detail: {
          changePct: changePct.toFixed(1),
          nowUsd: String(tvl.nowUsd),
          dayAgoUsd: String(tvl.dayAgoUsd),
        },
      });
    }
  }

  if (venus && venus.utilizationBps > UTILIZATION_LIMIT_BPS) {
    actions.push({
      rule: 'utilization_high',
      action: 'stop_deposits',
      detail: { utilizationPct: (venus.utilizationBps / 100).toFixed(2) },
    });
  }

  if (usdt && usable(usdt.priceUsd) && usdt.priceUsd < USDT_PEG_FLOOR && usdt.belowPegSince) {
    const heldMs = inputs.now.getTime() - Date.parse(usdt.belowPegSince);
    if (heldMs >= USDT_DEPEG_MS) {
      actions.push({
        rule: 'usdt_depeg',
        action: 'pause_buys',
        detail: { priceUsd: String(usdt.priceUsd), since: usdt.belowPegSince },
      });
    }
  }
  return actions;
}

/** What decideCycle gets: the first rule that blocks buying, if any. */
export function guardianVerdict(
  open: readonly { rule: string; action: string }[],
): { blocked: false } | { blocked: true; rule: string } {
  const blocking = open.find((a) => a.action === 'pause_buys' || a.action === 'redeem_all');
  return blocking ? { blocked: true, rule: blocking.rule } : { blocked: false };
}
