// Draws the order-book heatmap and the liquidation map on a dark chart, on two canvases laid on the chart's plot
// area: walls of resting orders under the candles, and at the right edge where positions would be liquidated
// (longs under the price, shorts over it) with the largest amounts labelled. Nothing animates: a frame only
// repaints when the view, the size or the data changed.
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import { liqMap, wallScale, type HeatColumn } from './nano.ts';

export interface Bar { time: number; high: number; low: number; close: number; volume: number }
/** `oi` is the open interest in coins, when the liquidation map is on. `words` label the map's amounts. */
export interface HeatInput { heat: HeatColumn[] | null; oi: number | null; bars: Bar[]; v: number; words: { long: string; short: string } }

/** Walls on a dark ground: deep red for a wall just thick enough to show, through coral, to pale peach for the thickest. */
const STOPS: [number, number, number, number, number][] = [
  [0, 125, 22, 30, 120], [0.25, 210, 46, 50, 200], [0.55, 255, 102, 80, 245], [1, 255, 216, 170, 255],
];
const LUT = new Uint8ClampedArray(256 * 4);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  let k = 1;
  while (k < STOPS.length - 1 && v > STOPS[k][0]) k++;
  const a = STOPS[k - 1], b = STOPS[k], f = Math.min(1, Math.max(0, (v - a[0]) / (b[0] - a[0])));
  for (let c = 0; c < 4; c++) LUT[i * 4 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f;
}

/** Running totals of a column's bins, so the average over any stretch of prices costs two reads. */
const sums = new WeakMap<HeatColumn, Float64Array>();
function prefix(c: HeatColumn): Float64Array {
  let s = sums.get(c);
  if (!s) {
    s = new Float64Array(c.bins.length + 1);
    for (let i = 0; i < c.bins.length; i++) s[i + 1] = s[i] + c.bins[i];
    sums.set(c, s);
  }
  return s;
}
/**
 * The book is always thick next to the price and thin far from it, so a wall is judged against its neighbourhood
 * as well: the average over twelve cells either side of it (at least three bins). Without this every moment lights
 * up as one band hugging the candles and the walls further out never show.
 */
const NEAR_CELLS = 12;
function around(c: HeatColumn, s: Float64Array, i0: number, i1: number, cellPrice: number): number {
  const reach = Math.max(3, Math.round((NEAR_CELLS * cellPrice) / c.step));
  const a = Math.max(0, i0 - reach), b = Math.min(c.bins.length - 1, i1 + reach);
  return (s[b + 1] - s[a]) / (b - a + 1);
}
const REL_FLOOR = Math.log(1.6), REL_SPAN = Math.log(7) - Math.log(1.6);

const money = (usd: number) => (usd >= 1e9 ? `$${(usd / 1e9).toFixed(1)}B` : usd >= 1e6 ? `$${(usd / 1e6).toFixed(1)}M` : usd >= 1e3 ? `$${Math.round(usd / 1e3)}K` : `$${Math.round(usd)}`);

/** A smoothed copy: each value averaged with its neighbours, so the map reads as a shape rather than a comb. */
function smooth(xs: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(xs.length), w: number[] = [];
  for (let k = -radius; k <= radius; k++) w.push(Math.exp(-(k * k) / (2 * (radius / 2 + 0.5) ** 2)));
  for (let i = 0; i < xs.length; i++) {
    let s = 0, ws = 0;
    for (let k = -radius; k <= radius; k++) { const j = i + k; if (j < 0 || j >= xs.length) continue; s += xs[j] * w[k + radius]; ws += w[k + radius]; }
    out[i] = ws ? s / ws : 0;
  }
  return out;
}

export function mountHeat(under: HTMLCanvasElement, over: HTMLCanvasElement, chart: IChartApi, series: ISeriesApi<'Candlestick'>, read: () => HeatInput): () => void {
  let raf = 0, seen = '';
  const off = document.createElement('canvas');

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
    for (const cv of [under, over, off]) {
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    }
    for (const cv of [under, over]) { cv.style.width = `${w}px`; cv.style.height = `${h}px`; }
    const yOf = (price: number) => ((price - top) / (bottom - top)) * H;
    const priceAt = (y: number) => top + (y / H) * (bottom - top);
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

    const u = under.getContext('2d')!, o = over.getContext('2d')!;
    u.clearRect(0, 0, W, H);
    o.clearRect(0, 0, W, H);

    // ---- walls: each moment of the book in cells a few pixels tall; a cell shows when its average is a wall ----
    if (d.heat?.length) {
      const cols = d.heat, cell = Math.max(2, Math.round(3 * dpr)), rows = Math.ceil(H / cell);
      // The prices at the edges of each cell, top to bottom.
      const edge = new Float64Array(rows + 1);
      for (let r = 0; r <= rows; r++) edge[r] = priceAt(Math.min(H, r * cell));
      const cellPrice = Math.abs(priceAt(cell) - priceAt(0));
      const ox = off.getContext('2d')!, img = ox.createImageData(W, H), px = img.data;
      let painted = -1;   // the last pixel column already filled
      for (let k = 0; k < cols.length; k++) {
        const c = cols[k], x0 = xOf(c.t);
        // The book right now runs on to the right edge: that is where the price is heading into.
        const x1 = k < cols.length - 1 ? xOf(cols[k + 1].t) : W;
        if (x0 === null || x1 === null || x1 <= 0 || x0 >= W) continue;
        // Zoomed out, many moments share one pixel: the first of them gets it.
        let a = Math.max(0, Math.round(x0)), b = Math.min(W, Math.round(x1));
        if (b <= a) b = a + 1;
        if (a <= painted) a = painted + 1;
        if (b <= a || a >= W) continue;
        painted = b - 1;
        const [floor, ceil] = wallScale(c), lf = Math.log(floor), span = Math.log(ceil) - lf, s = prefix(c), nb = c.bins.length;
        if (!(floor > 0) || !(span > 0)) continue;
        for (let r = 0; r < rows; r++) {
          const hiP = Math.max(edge[r], edge[r + 1]), loP = Math.min(edge[r], edge[r + 1]);
          const i0 = Math.max(0, Math.floor((loP - c.lo) / c.step)), i1 = Math.min(nb - 1, Math.floor((hiP - c.lo) / c.step));
          if (i1 < i0) continue;
          const avg = (s[i1 + 1] - s[i0]) / (i1 - i0 + 1);
          if (avg <= floor) continue;
          // Thick for where it stands counts most; thick for this moment as a whole adds to it.
          const rel = (Math.log(avg / Math.max(1e-9, around(c, s, i0, i1, cellPrice))) - REL_FLOOR) / REL_SPAN;
          if (rel <= 0) continue;
          const abs = (Math.log(avg) - lf) / span;
          const li = Math.min(255, Math.round(Math.min(1, 0.6 * Math.min(1, rel) + 0.5 * Math.min(1, abs)) * 255)) * 4;
          const y0 = r * cell, y1 = Math.min(H, y0 + cell);
          for (let y = y0; y < y1; y++) {
            let p = (y * W + a) * 4;
            for (let x = a; x < b; x++, p += 4) { px[p] = LUT[li]; px[p + 1] = LUT[li + 1]; px[p + 2] = LUT[li + 2]; px[p + 3] = LUT[li + 3]; }
          }
        }
      }
      ox.putImageData(img, 0, 0);
      // A slight blur turns the cells into the soft bands a heatmap is read as.
      u.filter = `blur(${dpr}px)`;
      u.drawImage(off, 0, 0);
      u.filter = 'none';
    }

    // ---- the liquidation map: a profile from the right edge, longs under the price in red, shorts over it in green ----
    // Entry prices come from the last week of candles whatever the zoom: positions opened months ago are mostly
    // closed, and counting them would fill prices far away with liquidations that will not happen.
    if (d.oi && n) {
      const now = bars[n - 1].close;
      const week = bars.filter((x) => x.time >= bars[n - 1].time - 7 * 86_400);
      const entries = week.length >= 5 ? week : bars.slice(-30);
      const low = Math.min(top, bottom), high = Math.max(top, bottom), cells = Math.max(30, Math.round(H / (2 * dpr)));
      const m = liqMap(entries, d.oi * now, low, high, cells);
      if (m) {
        const longs = smooth(m.longs, 3), shorts = smooth(m.shorts, 3);
        // Longs above the price and shorts under it would already have been closed: only the side still ahead shows.
        const val = (i: number) => { const p = m.low + (i + 0.5) * m.step; return p < now ? longs[i] : shorts[i]; };
        let max = 0;
        for (let i = 0; i < m.n; i++) max = Math.max(max, val(i));
        if (max > 0) {
          const reach = W * 0.2;
          for (const side of ['long', 'short'] as const) {
            const keep = (i: number) => (side === 'long' ? m.low + (i + 0.5) * m.step < now : m.low + (i + 0.5) * m.step >= now);
            u.beginPath();
            let started = false, lastY = 0;
            for (let i = 0; i < m.n; i++) {
              if (!keep(i)) continue;
              const y = yOf(m.low + (i + 0.5) * m.step), x = W - (val(i) / max) * reach;
              if (!started) { u.moveTo(W, y); started = true; }
              u.lineTo(x, y); lastY = y;
            }
            if (!started) continue;
            u.lineTo(W, lastY); u.closePath();
            const grad = u.createLinearGradient(W - reach, 0, W, 0);
            const rgb = side === 'long' ? '239,68,68' : '34,197,94';
            grad.addColorStop(0, `rgba(${rgb},.55)`); grad.addColorStop(1, `rgba(${rgb},.2)`);
            u.fillStyle = grad; u.fill();
            u.strokeStyle = `rgba(${rgb},.95)`; u.lineWidth = dpr; u.stroke();
          }
          // The peaks, labelled at the right edge: the three largest on each side, kept apart so they can be read.
          const peaks: { y: number; usd: number; long: boolean }[] = [];
          for (let i = 1; i < m.n - 1; i++) {
            const v = val(i), p = m.low + (i + 0.5) * m.step;
            if (v > 0 && v >= val(i - 1) && v > val(i + 1) && v >= max * 0.12) peaks.push({ y: yOf(p), usd: (p < now ? m.longs : m.shorts).slice(Math.max(0, i - 3), i + 4).reduce((x, z) => x + z, 0), long: p < now });
          }
          const gap = 18 * dpr, shown: typeof peaks = [];
          for (const side of [true, false]) {
            for (const pk of peaks.filter((x) => x.long === side).sort((a, b) => b.usd - a.usd)) {
              if (shown.filter((x) => x.long === side).length >= 3) break;
              if (shown.some((x) => Math.abs(x.y - pk.y) < gap) || pk.y < 8 * dpr || pk.y > H - 8 * dpr) continue;
              shown.push(pk);
            }
          }
          o.font = `600 ${11 * dpr}px 'Google Sans Flex', 'Pretendard Variable', system-ui, sans-serif`;
          o.textBaseline = 'middle';
          for (const pk of shown) {
            const text = `${pk.long ? d.words.long : d.words.short} ${money(pk.usd)}`, tw = o.measureText(text).width;
            const bw = tw + 12 * dpr, bh = 18 * dpr, bx = W - bw - 4 * dpr, by = pk.y - bh / 2;
            o.fillStyle = pk.long ? 'rgba(127,29,29,.92)' : 'rgba(20,83,45,.92)';
            o.beginPath(); o.roundRect(bx, by, bw, bh, 4 * dpr); o.fill();
            o.fillStyle = pk.long ? '#fecaca' : '#bbf7d0';
            o.fillText(text, bx + 6 * dpr, pk.y + 0.5 * dpr);
          }
        }
      }
    }
  };
  raf = requestAnimationFrame(paint);
  return () => {
    cancelAnimationFrame(raf);
    for (const cv of [under, over]) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
  };
}
