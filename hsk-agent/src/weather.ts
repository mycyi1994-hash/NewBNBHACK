// "Coin weather": Moa's one-word call per coin, folded from signals the app already computes
// (50-day trend, RSI, recent volatility, HSKSwap vs Gate, perp mark vs index). The numbers behind it are
// kept so Moa can explain the call at any depth.
import * as cex from './cex.ts';
import * as I from './indicators.ts';
import type { Quote } from './market.ts';

export type Sky = 'sun' | 'cloud' | 'rain' | 'storm';
export interface Weather {
  base: 'BTC' | 'ETH'; sky: Sky; price: number;
  m1: number; vsMa: number; rsi: number; volRatio: number; gap?: number; basis?: number;
}

const perp = (b: 'BTC' | 'ETH') => cex.marketBySymbol(`${b}USDT-PERPETUAL`);

/** The call: storm on a volatility spike, rain under the trend or when HSKSwap is pricey, sun when all is well. */
export function skyOf(w: Omit<Weather, 'sky'>): Sky {
  if (w.volRatio >= 1.8) return 'storm';
  if (w.vsMa < 0 || (w.gap ?? 0) >= 0.003) return 'rain';
  if (w.vsMa > 0 && (w.gap ?? 0) <= 0.001 && w.rsi < 70) return 'sun';
  return 'cloud';
}

export async function loadWeather(quotes: Quote[]): Promise<Weather[]> {
  const out: Weather[] = [];
  for (const base of ['BTC', 'ETH'] as const) {
    const m = perp(base);
    const [bars, mi] = await Promise.all([cex.klines(m, '1d', 120), cex.markAndIndex(m).catch(() => undefined)]);
    if (bars.length < 70) continue;
    const c = bars.map((b) => b.close);
    const last = c[c.length - 1];
    const ma = I.sma(c, 50);
    const atrNow = I.atr(bars, 14) ?? 0, atrBefore = I.atr(bars.slice(0, -30), 14) ?? atrNow;
    const q = quotes.find((x) => x.asset === base);
    const w = {
      base, price: last,
      m1: last / c[c.length - 31] - 1,
      vsMa: last / ma[ma.length - 1] - 1,
      rsi: I.rsi(c)[c.length - 1],
      volRatio: atrBefore > 0 ? atrNow / atrBefore : 1,
      gap: q?.gap,
      basis: mi ? mi.mark / mi.index - 1 : undefined,
    };
    out.push({ ...w, sky: skyOf(w) });
  }
  return out;
}
