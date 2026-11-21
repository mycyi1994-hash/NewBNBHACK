// Moa's voice: short, direct, a little cheeky. Never invents numbers it does not have.
import { scheduleOf, type Plan } from './intent.ts';
import type { Quote } from './market.ts';
import { fmtPrice } from './market.ts';

export function reply(plan: Plan, quotes: Quote[]): string {
  if (plan.steps.length === 0) return plan.missing[0];
  const lines: string[] = [];
  const kinds = new Set(plan.steps.map((s) => s.kind));
  if (kinds.has('accumulate') && kinds.has('stopLoss')) lines.push('Stack slowly, bail out fast. I like it.');
  else if (kinds.has('accumulate')) lines.push('Slow and steady. Boring wins more often than people admit.');
  else if (kinds.has('stopLoss') || kinds.has('takeProfit')) lines.push('Guard duty. Got it.');
  else lines.push('Making idle money work. Respect.');

  for (const s of plan.steps) {
    if (s.kind !== 'accumulate') continue;
    const sch = scheduleOf(s);
    if (sch.buys !== undefined && sch.totalUsd !== undefined) lines.push(`That is ${sch.buys} buys, $${sch.totalUsd.toLocaleString('en-US')} in total.`);
    const q = quotes.find((x) => x.asset === s.asset);
    if (q?.pool !== undefined) {
      let line = `${s.asset} is ${fmtPrice(q.pool)} on HSKSwap right now`;
      if (q.gap !== undefined) {
        const g = q.gap * 100;
        line += Math.abs(g) < 0.3 ? ', in line with the exchanges.' : g > 0 ? `, ${g.toFixed(1)}% above the exchanges, so I would wait for a better fill.` : `, ${(-g).toFixed(1)}% below the exchanges. Nice entry.`;
      } else line += '.';
      lines.push(line);
    }
    if (s.maxPrice !== undefined && q?.pool !== undefined && q.pool > s.maxPrice) lines.push(`Heads-up: your cap is $${s.maxPrice}, so I will sit on my hands until it dips.`);
  }
  if (kinds.has('earn')) lines.push('Yield venues on HSK Chain are still being checked; I will only park money where I can verify the contract.');
  if (plan.missing.length) lines.push(plan.missing[0]);
  else lines.push('Review the plan on the right. Nothing moves until you create the bot.');
  return lines.join(' ');
}

export const GREETING = "I'm Moa. Tell me what you want to end up with, not which buttons to press. I'll collect, protect and put your coins to work on HSK Chain.";

export const EXAMPLES = [
  'Collect $10 of HSK every day for 2 weeks, sell half if it drops 15%',
  'Accumulate 5,000 HSK by Dec 31 under 0.08, budget $400',
  'Buy $25 of ETH every week for 2 months, take a third at +30%, then stake idle USDT',
];
