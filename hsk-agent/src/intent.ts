// Turns a plain-English goal into a structured plan Moa can run.
// This rule-based parser is the first stage; the LLM stage will emit the same Plan shape.

export type Asset = 'HSK' | 'ETH' | 'BTC';
export const ASSETS: Asset[] = ['HSK', 'ETH', 'BTC'];
export type Every = 'hour' | 'day' | 'week';

export interface AccumulateStep {
  kind: 'accumulate';
  asset: Asset;
  perBuyUsd?: number;
  every?: Every;
  durationDays?: number;
  targetQty?: number;
  deadline?: string;
  maxPrice?: number;
  budgetUsd?: number;
}
export interface StopLossStep {
  kind: 'stopLoss';
  asset: Asset;
  dropPct: number;
  sellFraction: number;
}
export interface TakeProfitStep {
  kind: 'takeProfit';
  asset: Asset;
  risePct: number;
  sellFraction: number;
}
export interface EarnStep {
  kind: 'earn';
  what: 'idle USDT' | 'accumulated coins';
}
export type Step = AccumulateStep | StopLossStep | TakeProfitStep | EarnStep;

export interface Plan {
  steps: Step[];
  /** Questions Moa must ask before the plan can run. */
  missing: string[];
}

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const num = (s: string) => Number(s.replace(/,/g, ''));

function findAsset(text: string): Asset | undefined {
  const m = text.match(/\b(hsk|eth|ether|ethereum|btc|bitcoin)\b/i);
  if (!m) return undefined;
  const a = m[1].toLowerCase();
  if (a === 'hsk') return 'HSK';
  if (a.startsWith('eth')) return 'ETH';
  return 'BTC';
}

function findFraction(text: string): number {
  if (/\b(half|50\s*%)\b/i.test(text)) return 0.5;
  if (/\b(a third|one third|1\/3)\b/i.test(text)) return 1 / 3;
  if (/\b(a quarter|one quarter|1\/4)\b/i.test(text)) return 0.25;
  const pct = text.match(/sell\s+(\d+(?:\.\d+)?)\s*%/i);
  if (pct) return Math.min(1, num(pct[1]) / 100);
  return 1;
}

function splitClauses(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/\s*(?:[;\n]|\.\s|,\s*(?:and\s+)?then\b|\bthen\b|,\s*and\b|,(?=\s*(?:if|sell|take|stake|deposit|put|park|when|keep|stop)\b)|\band\s+(?=(?:if|sell|take|stake|deposit|put|park|keep)\b))\s*/i)
    .map((c) => c.trim())
    .filter(Boolean)
    // "If BTC falls 20%, sell 40%": a bare condition belongs to the action that follows it.
    .reduce<string[]>((out, c) => {
      const prev = out[out.length - 1];
      if (prev !== undefined && /^(if|when|once)\b/i.test(prev) && !/\b(sell|take|buy|stake|deposit)\b/i.test(prev)) out[out.length - 1] = `${prev}, ${c}`;
      else out.push(c);
      return out;
    }, []);
}

function parseAccumulate(c: string, asset: Asset): AccumulateStep {
  const step: AccumulateStep = { kind: 'accumulate', asset };
  const perBuy = c.match(new RegExp(String.raw`\$\s?${NUM}(?!\s*(?:k\b|budget))`, 'i')) ?? c.match(new RegExp(`${NUM}\\s*(?:usdt|usd|dollars?)\\b`, 'i'));
  const budget = c.match(new RegExp(String.raw`(?:budget(?: of| is)?|up to|spend(?:ing)? at most|no more than)\s*\$?\s*${NUM}`, 'i'));
  if (budget) step.budgetUsd = num(budget[1]);
  if (perBuy && (!budget || num(perBuy[1]) !== step.budgetUsd)) step.perBuyUsd = num(perBuy[1]);

  if (/\b(hourly|every hour|each hour|an hour|per hour)\b/i.test(c)) step.every = 'hour';
  else if (/\b(daily|every day|each day|a day|per day)\b/i.test(c)) step.every = 'day';
  else if (/\b(weekly|every week|each week|a week|per week)\b/i.test(c)) step.every = 'week';

  const dur = c.match(/\bfor\s+(?:the\s+next\s+)?(\d+|a|one|two|three|four)\s*(day|week|month)s?\b/i);
  if (dur) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4 };
    const n = words[dur[1].toLowerCase()] ?? num(dur[1]);
    step.durationDays = n * ({ day: 1, week: 7, month: 30 } as const)[dur[2].toLowerCase() as 'day' | 'week' | 'month'];
  }

  const target = c.match(new RegExp(`${NUM}\\s*(?:${asset}|${asset.toLowerCase()})\\b`, 'i'));
  if (target) step.targetQty = num(target[1]);

  const by = c.match(/\b(?:by|before|until)\s+((?:the\s+)?end of [a-z]+|[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})/i);
  if (by) step.deadline = by[1];

  const cap = c.match(new RegExp(String.raw`(?:under|below|less than|at most|cheaper than|max(?:imum)?(?: price)?(?: of)?)\s*\$?\s*${NUM}`, 'i'));
  if (cap && num(cap[1]) < 1_000_000 && num(cap[1]) !== step.budgetUsd) step.maxPrice = num(cap[1]);
  return step;
}

export function parseIntent(text: string): Plan {
  const steps: Step[] = [];
  const missing: string[] = [];
  let lastAsset: Asset | undefined;

  for (const c of splitClauses(text)) {
    const asset = findAsset(c) ?? lastAsset;
    const isAccumulate = /\b(buy|accumulate|collect|stack|dca|gather|save up|pick up)\b/i.test(c) && !/\bsell\b/i.test(c);
    const drop = c.match(/\b(?:drops?|falls?|dips?|goes down|down|loses?|crashes)\s*(?:by\s*|more than\s*|over\s*)?(\d+(?:\.\d+)?)\s*%/i)
      ?? c.match(/\bstop[- ]?loss(?: at| of)?\s*-?(\d+(?:\.\d+)?)\s*%/i);
    const rise = c.match(/\b(?:rises?|pumps?|goes up|up|gains?|climbs?)\s*(?:by\s*|more than\s*|over\s*)?(\d+(?:\.\d+)?)\s*%/i)
      ?? c.match(/\btake[- ]?profit(?: at| of)?\s*\+?(\d+(?:\.\d+)?)\s*%/i)
      ?? c.match(/\+(\d+(?:\.\d+)?)\s*%/);
    const isEarn = /\b(stake|staking|deposit|earn|yield|park|interest|put .* to work)\b/i.test(c);

    if (isAccumulate) {
      if (!asset) {
        missing.push('Which coin should I collect: HSK, ETH or BTC?');
        continue;
      }
      const s = parseAccumulate(c, asset);
      steps.push(s);
      lastAsset = asset;
      const hasPace = s.perBuyUsd !== undefined && s.every !== undefined;
      const hasTarget = s.targetQty !== undefined && s.deadline !== undefined;
      if (!hasPace && !hasTarget && s.budgetUsd === undefined) {
        if (s.targetQty !== undefined) missing.push(`By when do you want the ${s.targetQty.toLocaleString('en-US')} ${asset}?`);
        else if (s.perBuyUsd !== undefined) missing.push(`How often should I buy $${s.perBuyUsd} of ${asset}: hourly, daily or weekly?`);
        else missing.push(`How much should I spend on ${asset}, and how often?`);
      } else if (hasPace && s.durationDays === undefined && s.budgetUsd === undefined && s.targetQty === undefined) {
        missing.push(`For how long should I keep buying ${asset}? (or give me a total budget)`);
      }
      continue;
    }
    if (drop && /\b(sell|cut|exit|dump|stop[- ]?loss|get out)\b/i.test(c)) {
      if (!asset) { missing.push('Which coin does the stop-loss protect?'); continue; }
      steps.push({ kind: 'stopLoss', asset, dropPct: num(drop[1]), sellFraction: findFraction(c) });
      lastAsset = asset;
      continue;
    }
    if (rise && /\b(sell|take|cash out|lock in|profit)\b/i.test(c)) {
      if (!asset) { missing.push('Which coin should I take profit on?'); continue; }
      steps.push({ kind: 'takeProfit', asset, risePct: num(rise[1]), sellFraction: findFraction(c) });
      lastAsset = asset;
      continue;
    }
    if (isEarn) {
      steps.push({ kind: 'earn', what: /\b(idle|usdt|cash|stable)\b/i.test(c) ? 'idle USDT' : 'accumulated coins' });
      continue;
    }
  }
  if (steps.length === 0 && missing.length === 0) {
    missing.push('Tell me a goal, for example: "Collect $10 of HSK every day for 2 weeks, sell half if it drops 15%."');
  }
  return { steps, missing };
}

/** Total spend and number of buys implied by a pace-based accumulate step. */
export function scheduleOf(s: AccumulateStep): { buys?: number; totalUsd?: number } {
  if (s.perBuyUsd === undefined || s.every === undefined) return {};
  const perDay = { hour: 24, day: 1, week: 1 / 7 }[s.every];
  let buys: number | undefined;
  if (s.durationDays !== undefined) buys = Math.max(1, Math.round(s.durationDays * perDay));
  if (s.budgetUsd !== undefined) {
    const byBudget = Math.floor(s.budgetUsd / s.perBuyUsd);
    buys = buys === undefined ? byBudget : Math.min(buys, byBudget);
  }
  return buys === undefined ? {} : { buys, totalUsd: buys * s.perBuyUsd };
}

const pct = (f: number) => (f === 1 ? 'all' : f === 0.5 ? 'half' : Math.abs(f - 1 / 3) < 1e-9 ? 'a third' : f === 0.25 ? 'a quarter' : `${Math.round(f * 100)}%`);

const pctKo = (f: number) => (f === 1 ? '전부' : f === 0.5 ? '절반' : Math.abs(f - 1 / 3) < 1e-9 ? '1/3' : f === 0.25 ? '1/4' : `${Math.round(f * 100)}%`);
const everyKo = { hour: '매시간', day: '매일', week: '매주' } as const;

function describeKo(step: Step): string {
  switch (step.kind) {
    case 'accumulate': {
      const parts: string[] = [];
      if (step.perBuyUsd !== undefined && step.every) parts.push(`${everyKo[step.every]} $${step.perBuyUsd}씩`);
      if (step.durationDays !== undefined) parts.push(`${step.durationDays}일 동안`);
      if (step.deadline) parts.push(`${step.deadline}까지`);
      if (step.targetQty !== undefined) parts.push(`${step.targetQty.toLocaleString('en-US')}개 목표`);
      if (step.maxPrice !== undefined) parts.push(`$${step.maxPrice} 이하일 때만`);
      if (step.budgetUsd !== undefined) parts.push(`예산 $${step.budgetUsd}`);
      return `${step.asset} 모으기${parts.length ? ': ' + parts.join(', ') : ''}`;
    }
    case 'stopLoss':
      return `평단보다 ${step.dropPct}% 떨어지면 ${step.asset} ${pctKo(step.sellFraction)} 매도`;
    case 'takeProfit':
      return `평단보다 ${step.risePct}% 오르면 ${step.asset} ${pctKo(step.sellFraction)} 매도`;
    case 'earn':
      return step.what === 'idle USDT' ? '놀고 있는 USDT를 HSK 체인 예치처에 넣기' : '모은 코인을 HSK 체인 예치처에 넣기';
  }
}

/** One line per step, in English (default) or Korean. */
export function describe(step: Step, lang: 'en' | 'ko' = 'en'): string {
  if (lang === 'ko') return describeKo(step);
  switch (step.kind) {
    case 'accumulate': {
      const parts: string[] = [];
      if (step.perBuyUsd !== undefined && step.every) parts.push(`$${step.perBuyUsd} of ${step.asset} every ${step.every}`);
      else if (step.targetQty !== undefined) parts.push(`${step.targetQty.toLocaleString('en-US')} ${step.asset}`);
      else parts.push(step.asset);
      if (step.targetQty !== undefined && step.perBuyUsd !== undefined) parts.push(`until ${step.targetQty.toLocaleString('en-US')} ${step.asset}`);
      if (step.durationDays !== undefined) parts.push(`for ${step.durationDays} days`);
      if (step.deadline) parts.push(`by ${step.deadline}`);
      if (step.maxPrice !== undefined) parts.push(`only below $${step.maxPrice}`);
      if (step.budgetUsd !== undefined) parts.push(`budget $${step.budgetUsd}`);
      return `Collect ${parts.join(', ')}`;
    }
    case 'stopLoss':
      return `Sell ${pct(step.sellFraction)} of ${step.asset} if it falls ${step.dropPct}% below my average cost`;
    case 'takeProfit':
      return `Sell ${pct(step.sellFraction)} of ${step.asset} once it is up ${step.risePct}% on my average cost`;
    case 'earn':
      return `Put ${step.what} to work in a yield venue on HSK Chain`;
  }
}

/** A short name for a bot, from its first step. */
export function botName(plan: Plan): string {
  const first = plan.steps[0];
  if (!first) return 'New bot';
  if (first.kind === 'accumulate') return `${first.asset} Stacker`;
  if (first.kind === 'stopLoss' || first.kind === 'takeProfit') return `${first.asset} Guard`;
  return 'Yield Keeper';
}
