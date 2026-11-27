// What Moa understands about a liquidity plan without asking the AI: amounts, the shape, how wide, which side.
// Anything it does not recognise goes to the AI, which fills the same plan with its set_lp_plan tool.
import { SPACING, type LpPlan, type Shape } from './lp.ts';

/** Percent the price moves across `ticks`. */
export const pctOf = (ticks: number) => (Math.pow(1.0001, ticks) - 1) * 100;
/** How far the steps reach on one side, in percent. */
export const reachOf = (plan: Pick<LpPlan, 'step' | 'perSide'>) => pctOf(plan.step * (plan.perSide + 1));

/** The step width and count that come closest to reaching `pct` percent on each side. */
export function widthFor(pct: number): Pick<LpPlan, 'step' | 'perSide'> {
  let best = { step: SPACING, perSide: 10 }, err = Infinity;
  for (const step of [SPACING, SPACING * 2, SPACING * 4]) for (const perSide of [5, 10, 15]) {
    const e = Math.abs(reachOf({ step, perSide }) - pct) + (perSide === 10 ? 0 : 0.01);   // ten steps a side when it is a tie
    if (e < err) { err = e; best = { step, perSide }; }
  }
  return best;
}

const COIN = /(\d+(?:\.\d+)?|\.\d+)\s*(w?btc|w?eth|w?hsk|비트코인|비트|이더리움|이더)/i;
const PCT = /±?\s*(\d+(?:\.\d+)?)\s*(%|퍼센트|프로)/;
const MONEY = /(\$\s*)?(\d[\d,]*(?:\.\d+)?)\s*(usdt|달러|불|dollars?|\$)?/i;

/** The changes a message asks for, or null when it asks for none Moa recognises. */
export function parseLp(q: string): Partial<LpPlan> | null {
  const s = q.trim().toLowerCase();
  const out: Partial<LpPlan> = {};
  let rest = s;
  const coin = COIN.exec(rest);
  if (coin) { out.coin = Number(coin[1]); rest = rest.replace(coin[0], ' '); }
  const pct = PCT.exec(rest);
  if (pct) { Object.assign(out, widthFor(Number(pct[1]))); rest = rest.replace(pct[0], ' '); }
  else if (/아주 ?넓|very wide/.test(s)) Object.assign(out, widthFor(24));
  else if (/넓게|넓혀|wide/.test(s)) Object.assign(out, widthFor(12));
  else if (/좁게|좁혀|narrow|tight/.test(s)) Object.assign(out, widthFor(3));
  else if (/보통|중간|normal|medium/.test(s)) Object.assign(out, widthFor(6));
  // a number with a money unit, or a message that is only a number, is the USDT amount
  const money = MONEY.exec(rest);
  if (money && (money[1] || money[3] || /^\s*[\d,]+(?:\.\d+)?\s*$/.test(rest))) out.usdt = Number(money[2].replace(/,/g, ''));
  const shape: Shape | null = /(고르게|균등|골고루|스팟|spot|even)/.test(s) ? 'spot'
    : /(양 ?끝|끝에|bid.?ask|ends)/.test(s) ? 'bidask'
      : /(몰아|몰기|집중|커브|curve|가까이|near)/.test(s) ? 'curve' : null;
  if (shape) out.shape = shape;
  if (/(아래만|아래쪽만|사는 ?쪽만|사기만|코인 ?없이|buy side only|only buy|usdt only)/.test(s)) out.coin = 0;
  if (/(위만|위쪽만|파는 ?쪽만|팔기만|sell side only|only sell)/.test(s)) out.usdt = 0;
  return Object.keys(out).length ? out : null;
}

/** Moa's suggested shape for a coin, and why (words in i18n: lpWhy[shape]). */
export const suggestShape = (asset: string): Exclude<Shape, 'custom'> => (asset === 'HSK' ? 'spot' : 'curve');
