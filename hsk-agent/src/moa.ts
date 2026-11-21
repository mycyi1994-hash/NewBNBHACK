// Offline replies: plain and factual, like an order confirmation. Never invents numbers it does not have.
import { scheduleOf, type Plan } from './intent.ts';
import type { Quote } from './market.ts';
import { fmtPrice } from './market.ts';

/** Offline reply in Korean (used when the AI server is unreachable). */
function replyKo(plan: Plan, quotes: Quote[]): string {
  if (plan.steps.length === 0) return '무엇을, 얼마씩, 언제까지 살지 적어 주세요. 예: “HSK를 2주 동안 매일 10달러씩 사고, 15% 빠지면 절반 매도.”';
  const lines: string[] = [];
  for (const s of plan.steps) {
    if (s.kind !== 'accumulate') continue;
    const sch = scheduleOf(s);
    if (sch.buys !== undefined && sch.totalUsd !== undefined) lines.push(`총 ${sch.buys}회, $${sch.totalUsd.toLocaleString('en-US')}.`);
    const q = quotes.find((x) => x.asset === s.asset);
    if (q?.pool !== undefined && q.gap !== undefined) {
      const g = q.gap * 100;
      lines.push(`HSKSwap ${s.asset} $${fmtPrice(q.pool)}, ${Math.abs(g) < 0.3 ? '현물과 비슷.' : g > 0 ? `현물보다 ${g.toFixed(1)}% 높아 매수 대기.` : `현물보다 ${(-g).toFixed(1)}% 낮음.`}`);
    }
  }
  if (plan.missing.length) lines.push('금액과 주기, 또는 기한이 필요해요.');
  else lines.push('계획을 확인하세요. 봇을 만들기 전에는 아무것도 실행되지 않아요.');
  return lines.join(' ');
}

export function reply(plan: Plan, quotes: Quote[], lang: 'en' | 'ko' = 'en'): string {
  if (lang === 'ko') return replyKo(plan, quotes);
  if (plan.steps.length === 0) return plan.missing[0];
  const lines: string[] = [];
  const kinds = new Set(plan.steps.map((s) => s.kind));
  for (const s of plan.steps) {
    if (s.kind !== 'accumulate') continue;
    const sch = scheduleOf(s);
    if (sch.buys !== undefined && sch.totalUsd !== undefined) lines.push(`${sch.buys} buys, $${sch.totalUsd.toLocaleString('en-US')} total.`);
    const q = quotes.find((x) => x.asset === s.asset);
    if (q?.pool !== undefined) {
      let line = `HSKSwap ${s.asset} $${fmtPrice(q.pool)}`;
      if (q.gap !== undefined) {
        const g = q.gap * 100;
        line += Math.abs(g) < 0.3 ? ', in line with spot.' : g > 0 ? `, ${g.toFixed(1)}% above spot. Buys wait for a better fill.` : `, ${(-g).toFixed(1)}% below spot.`;
      } else line += '.';
      lines.push(line);
    }
    if (s.maxPrice !== undefined && q?.pool !== undefined && q.pool > s.maxPrice) lines.push(`Price cap $${s.maxPrice}: no buys until the pool is below it.`);
  }
  if (kinds.has('earn')) lines.push('Yield step: no verified venue on HSK Chain yet, so idle USDT stays in the vault.');
  if (plan.missing.length) lines.push(plan.missing[0]);
  else lines.push('Review the plan. Nothing runs until you create the bot.');
  return lines.join(' ');
}

export const GREETING = 'Describe what to buy, how often and when to stop. You review the plan before anything runs.';

export const EXAMPLES = [
  'Collect $10 of HSK every day for 2 weeks, sell half if it drops 15%',
  'Accumulate 5,000 HSK by Dec 31 under 0.08, budget $400',
  'Buy $25 of ETH every week for 2 months, take a third at +30%, then stake idle USDT',
];
