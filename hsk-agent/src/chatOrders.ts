// Fixed readers for two kinds of chat request that need no AI: a one-off order ("BTC 1달러 사줘") and a change to
// the vault's own settings ("하루 한도 30달러로", "손절 10%로", "잠가줘"). They only read the words; an order becomes a
// server ticket the user confirms, and a settings change becomes a transaction the owner's wallet signs. Neither
// reader ever acts.
import type { Asset } from './intent.ts';

export interface ChatOrder { asset: Asset; side: 'buy' | 'sell'; amount: number | 'all' }
export type VaultChange =
  | { kind: 'limits'; perDay?: number | null; perTrade?: number | null }
  | { kind: 'stop'; pct: number }
  | { kind: 'lock'; on: boolean };

const NUM = '(\\d+(?:[.,]\\d+)?)';
const num = (s: string) => Number(s.replace(',', '.'));
const coinOf = (q: string): Asset | undefined =>
  /(btc|bitcoin|비트)/i.test(q) ? 'BTC' : /(eth|ether|이더)/i.test(q) ? 'ETH' : /(hsk|whsk)/i.test(q) ? 'HSK' : undefined;

/** "BTC 1달러 사줘", "buy $5 of ETH", "HSK 20개 팔아줘", "이더 전부 팔아". Undefined when it is not one clear order. */
export function parseOrder(q: string): ChatOrder | undefined {
  const asset = coinOf(q);
  if (!asset) return undefined;
  const buy = /(사\s?줘|사\s?주세요|사\s?줄래|매수해|구매해|\bbuy\b)/i.test(q), sell = /(팔아|팔\s?줘|매도해|\bsell\b)/i.test(q);
  if (buy === sell) return undefined;
  if (buy) {
    const m = new RegExp(`(?:\\$\\s?${NUM})|(?:${NUM}\\s?(?:달러|불|usdt|usd|\\$))`, 'i').exec(q);
    const amount = m ? num(m[1] ?? m[2]) : NaN;
    return amount > 0 ? { asset, side: 'buy', amount } : undefined;
  }
  if (/(전부|전량|모두|다\s?팔|\ball\b)/i.test(q)) return { asset, side: 'sell', amount: 'all' };
  const m = new RegExp(`${NUM}\\s?(?:개|btc|eth|hsk|whsk|wbtc|weth)`, 'i').exec(q);
  const amount = m ? num(m[1]) : NaN;
  return amount > 0 ? { asset, side: 'sell', amount } : undefined;
}

/** A change to the vault's limits, stop-loss or lock. Undefined when the words are not one. */
export function parseVaultChange(q: string): VaultChange | undefined {
  const money = `${NUM}\\s?(?:달러|불|usdt|usd|\\$)?`;
  if (/(손절|stop.?loss)/i.test(q)) {
    if (/(꺼|끄|없애|해제|off|remove)/i.test(q)) return { kind: 'stop', pct: 0 };
    const m = new RegExp(`${NUM}\\s?(?:%|퍼센트|프로)`, 'i').exec(q);
    return m && num(m[1]) >= 1 && num(m[1]) <= 90 ? { kind: 'stop', pct: num(m[1]) } : undefined;
  }
  const day = /(하루|일일|daily|per day|a day)/i.test(q), trade = /(1회|한 ?번에|건당|per trade|each trade)/i.test(q);
  if ((day || trade) && /(한도|limit|까지|로|으로)/i.test(q)) {
    const none = /(없애|해제|풀어|무제한|no limit|remove)/i.test(q);
    const m = new RegExp(`(?:\\$\\s?${NUM})|(?:${money})`, 'i').exec(q.replace(/1회|24시간/g, ''));
    const v = none ? null : m ? num(m[1] ?? m[2]) : NaN;
    if (v !== null && !(v > 0)) return undefined;
    return day ? { kind: 'limits', perDay: v } : { kind: 'limits', perTrade: v };
  }
  if (/(잠금\s?풀|잠금을\s?풀|잠금 해제|unlock|다시 열어|거래 다시)/i.test(q)) return { kind: 'lock', on: false };
  if (/(잠가|잠궈|잠금|lock|(?:금고|볼트).{0,6}(멈춰|정지)|거래.{0,4}(멈춰|정지|막아))/i.test(q)) return { kind: 'lock', on: true };
  return undefined;
}
