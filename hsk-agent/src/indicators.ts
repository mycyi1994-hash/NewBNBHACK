// Small, pure indicator math used by the chart overlays and the strategy backtests.
// Inputs are oldest-first arrays; outputs keep the same length with NaN where there is not enough history.

export function sma(xs: number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i];
    if (i >= n) s -= xs[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(xs: number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  if (xs.length < n) return out;
  const k = 2 / (n + 1);
  let e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < xs.length; i++) { e = xs[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

/** Bollinger bands: middle = SMA(n), upper/lower = middle ± k standard deviations. */
export function boll(xs: number[], n = 20, k = 2) {
  const mid = sma(xs, n);
  const up = new Array<number>(xs.length).fill(NaN), lo = new Array<number>(xs.length).fill(NaN);
  for (let i = n - 1; i < xs.length; i++) {
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (xs[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / n);
    up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
  }
  return { mid, up, lo };
}

/** Wilder's RSI. */
export function rsi(xs: number[], n = 14): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  if (xs.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i] - xs[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** Average true range over the last n bars (simple mean of true ranges). */
export function atr(bars: { high: number; low: number; close: number }[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1].close;
    s += Math.max(b.high - b.low, Math.abs(b.high - p), Math.abs(b.low - p));
  }
  return s / n;
}
