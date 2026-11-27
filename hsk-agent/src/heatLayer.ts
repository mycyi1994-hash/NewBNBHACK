// Draws the order-book heatmap under the candles and the liquidations over them, on two canvases laid on the
// chart's plot area. Nothing animates: a frame only repaints when the view, the size or the data changed.
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import { heatScale, liqMap, type HeatColumn, type Liq } from './nano.ts';

export interface Bar { time: number; high: number; low: number; close: number; volume: number }
/** `oi` is the open interest in coins, when the liquidation map is on. */
export interface HeatInput { heat: HeatColumn[] | null; liqs: Liq[] | null; oi: number | null; bars: Bar[]; v: number }

/** Colour by how thick a bin is against a typical thick one: pale yellow, orange, fuchsia, deep purple. */
const STOPS: [number, number, number, number, number][] = [
  [0.06, 254, 240, 180, 60], [0.35, 253, 190, 100, 130], [0.7, 217, 70, 200, 165], [1, 88, 28, 135, 205],
];
const LUT = new Uint8ClampedArray(256 * 4);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  if (v < STOPS[0][0]) continue;
  let k = 1;
  while (k < STOPS.length - 1 && v > STOPS[k][0]) k++;
  const a = STOPS[k - 1], b = STOPS[k], f = Math.min(1, (v - a[0]) / (b[0] - a[0]));
  for (let c = 0; c < 4; c++) LUT[i * 4 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f;
}

const short = (usd: number) => (usd >= 1e9 ? `$${(usd / 1e9).toFixed(1)}B` : usd >= 1e6 ? `$${(usd / 1e6).toFixed(usd >= 1e7 ? 0 : 1)}M` : usd >= 1e3 ? `$${Math.round(usd / 1e3)}K` : `$${Math.round(usd)}`);

export function mountHeat(under: HTMLCanvasElement, over: HTMLCanvasElement, chart: IChartApi, series: ISeriesApi<'Candlestick'>, read: () => HeatInput): () => void {
  let raf = 0, seen = '';
  const strip = document.createElement('canvas');

  const paint = () => {
    raf = requestAnimationFrame(paint);
    const box = under.parentElement;
    if (!box) return;
    const ts = chart.timeScale(), w = ts.width(), h = box.clientHeight - ts.height();
    const range = ts.getVisibleLogicalRange();
    const top = series.coordinateToPrice(0), bottom = series.coordinateToPrice(h);
    const d = read();
    if (!range || top === null || bottom === null || w <= 0 || h <= 0 || top === bottom) return;
    const sig = `${w}|${h}|${range.from.toFixed(3)}|${range.to.toFixed(3)}|${top}|${bottom}|${d.v}`;
    if (sig === seen) return;
    seen = sig;

    const dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.round(w * dpr), H = Math.round(h * dpr);
    for (const cv of [under, over]) {
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    }
    const yOf = (price: number) => ((price - top) / (bottom - top)) * H;
    // A moment in time sits inside its candle: the candle's own width runs from its open time to the next one's.
    const bars = d.bars, n = bars.length, sec = n > 1 ? bars[n - 1].time - bars[n - 2].time : 60;
    // The library places whole bars only (a fraction comes back as 0), so the part of a bar is added by hand.
    const bar0 = ts.logicalToCoordinate(0 as Logical), bar1 = ts.logicalToCoordinate(1 as Logical);
    if (bar0 === null || bar1 === null) return;
    const xOf = (t: number): number | null => {
      if (!n || t < bars[0].time) return null;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid].time <= t) lo = mid; else hi = mid - 1; }
      return (bar0 + (lo - 0.5 + Math.min((t - bars[lo].time) / sec, lo === n - 1 ? 2 : 1)) * (bar1 - bar0)) * dpr;
    };

    const u = under.getContext('2d')!;
    u.clearRect(0, 0, W, H);
    if (d.heat?.length) {
      const cols = d.heat, [floor, ceil] = heatScale(cols[cols.length - 1], Math.min(top, bottom), Math.max(top, bottom));
      if (strip.width !== 1 || strip.height !== H) { strip.width = 1; strip.height = H; }
      const sx = strip.getContext('2d')!;
      u.imageSmoothingEnabled = false;
      for (let k = 0; k < cols.length; k++) {
        const c = cols[k], x0 = xOf(c.t);
        // The book right now runs on to the right edge: that is where the price is heading into.
        const x1 = k < cols.length - 1 ? xOf(cols[k + 1].t) : W;
        if (x0 === null || x1 === null || x1 <= 0 || x0 >= W || x1 - x0 < 0.5) continue;
        const img = sx.createImageData(1, H), px = img.data;
        const from = Math.max(0, Math.floor((Math.min(top, bottom) - c.lo) / c.step)), to = Math.min(c.bins.length - 1, Math.ceil((Math.max(top, bottom) - c.lo) / c.step));
        const rows = new Float32Array(H);
        for (let i = from; i <= to; i++) {
          const val = c.bins[i];
          if (val <= 0) continue;
          const a = yOf(c.lo + (i + 1) * c.step), b = yOf(c.lo + i * c.step);
          const r0 = Math.max(0, Math.floor(Math.min(a, b))), r1 = Math.min(H - 1, Math.max(r0, Math.ceil(Math.max(a, b)) - 1));
          for (let r = r0; r <= r1; r++) if (val > rows[r]) rows[r] = val;
        }
        for (let r = 0; r < H; r++) {
          if (!rows[r]) continue;
          const li = Math.max(0, Math.min(255, Math.round(((rows[r] - floor) / (ceil - floor)) * 255))) * 4;
          px[r * 4] = LUT[li]; px[r * 4 + 1] = LUT[li + 1]; px[r * 4 + 2] = LUT[li + 2]; px[r * 4 + 3] = LUT[li + 3];
        }
        sx.putImageData(img, 0, 0);
        u.drawImage(strip, 0, 0, 1, H, Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), H);
      }
    }

    // The liquidation map: bars from the right edge, one per price step, longer where more would be liquidated.
    // Entry prices come from the candles on screen (all of them when only a few are).
    if (d.oi && n) {
      const from = Math.max(0, Math.floor(range.from)), to = Math.min(n - 1, Math.ceil(range.to));
      const seenBars = to - from >= 5 ? bars.slice(from, to + 1) : bars;
      const m = liqMap(seenBars, d.oi * bars[n - 1].close, Math.min(top, bottom), Math.max(top, bottom), Math.max(20, Math.round(h / 4)));
      if (m) {
        let max = 0;
        for (let i = 0; i < m.n; i++) max = Math.max(max, m.lowLev[i] + m.midLev[i] + m.highLev[i]);
        const reach = W * 0.24, groups: [Float64Array, string][] = [[m.highLev, 'rgba(94,234,212,.8)'], [m.midLev, 'rgba(20,184,166,.8)'], [m.lowLev, 'rgba(15,118,110,.8)']];
        for (let i = 0; max > 0 && i < m.n; i++) {
          const a = yOf(m.low + (i + 1) * m.step), b = yOf(m.low + i * m.step), y = Math.min(a, b), tall = Math.max(1, Math.abs(b - a) - dpr);
          let x = W;
          for (const [arr, colour] of groups) {
            const len = (arr[i] / max) * reach;
            if (len < 0.5) continue;
            u.fillStyle = colour; u.fillRect(x - len, y, len, tall); x -= len;
          }
        }
      }
    }

    const o = over.getContext('2d')!;
    o.clearRect(0, 0, W, H);
    if (d.liqs?.length) {
      const seenNow: { x: number; y: number; q: Liq }[] = [];
      for (const q of d.liqs) {
        const x = xOf(q.t);
        if (x === null || x < 0 || x > W) continue;
        const y = yOf(q.price);
        if (y < 0 || y > H) continue;
        seenNow.push({ x, y, q });
      }
      seenNow.sort((a, b) => b.q.usd - a.q.usd);
      // The largest ones only: a screen full of circles says nothing.
      const max = seenNow[0]?.q.usd ?? 1, shown = seenNow.filter((x) => x.q.usd >= max * 0.02).slice(0, 110);
      o.lineWidth = dpr;
      o.font = `600 ${11 * dpr}px 'Google Sans Flex', 'Pretendard Variable', system-ui, sans-serif`;
      o.textBaseline = 'middle';
      shown.forEach(({ x, y, q }, i) => {
        const r = (2.5 + 13 * Math.sqrt(q.usd / max)) * dpr, rgb = q.long ? '220,38,38' : '22,163,74';
        o.beginPath(); o.arc(x, y, r, 0, Math.PI * 2);
        o.fillStyle = `rgba(${rgb},.22)`; o.fill();
        o.strokeStyle = `rgba(${rgb},.9)`; o.stroke();
        if (i < 3) {
          const text = short(q.usd), tw = o.measureText(text).width, left = x + r + 4 * dpr + tw > W;
          o.fillStyle = `rgb(${rgb})`;
          o.fillText(text, left ? x - r - 4 * dpr - tw : x + r + 4 * dpr, y);
        }
      });
    }
  };
  raf = requestAnimationFrame(paint);
  return () => {
    cancelAnimationFrame(raf);
    for (const cv of [under, over]) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
  };
}
