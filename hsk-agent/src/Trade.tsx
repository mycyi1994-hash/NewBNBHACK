import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts';
import * as cex from './cex.ts';
import * as I from './indicators.ts';
import { gateCandles, GATE_SECONDS, type GateInterval } from './gate.ts';
import { EXPLORER, POOLS, poolDetail, type PoolDetail } from './dex.ts';
import { ASSETS, type Asset } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import type { VaultInfo } from './parts.tsx';
import StrategyGrid, { type StratNote } from './Strategies.tsx';
import MoaFeed, { type MoaContext } from './MoaFeed.tsx';

type Venue = 'cex' | 'dex';
const usd = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (v: number) => v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const arrow = (up: boolean) => (up ? '▲' : '▼');

/* ---------- chart ---------- */

export type Ind = 'ma' | 'ema' | 'boll' | 'vol' | 'rsi';
const IND_ALL: Ind[] = ['ma', 'ema', 'boll', 'vol', 'rsi'];
const MA_COLORS = ['#f59e0b', '#7c5cf0', '#0ea5e9'];
const RIGHT_BARS = 20;      // empty space to the right of the last candle
const FIRST_VIEW = 160;     // bars in view on first load; the rest is a scroll/zoom away

const line = (times: number[], xs: number[]) => times.map((t, i) => ({ time: t as UTCTimestamp, value: xs[i] })).filter((p) => Number.isFinite(p.value));

function useStoredInds(): [Set<Ind>, (i: Ind) => void] {
  const [on, setOn] = useState<Set<Ind>>(() => {
    try { const v = JSON.parse(localStorage.getItem('moa.ind') ?? 'null'); if (Array.isArray(v)) return new Set(v.filter((x) => IND_ALL.includes(x))); } catch { /* storage unavailable */ }
    return new Set<Ind>(['ma', 'vol']);
  });
  const toggle = (i: Ind) => setOn((cur) => {
    const next = new Set(cur); if (next.has(i)) next.delete(i); else next.add(i);
    try { localStorage.setItem('moa.ind', JSON.stringify([...next])); } catch { /* storage unavailable */ }
    return next;
  });
  return [on, toggle];
}

/** Candles with indicator overlays. Scroll left to load older candles (onOlder), 20 bars of room on the right. */
function CandleChart({ candles, inds, onOlder, priceLine, markers, resetKey }: {
  candles: cex.Candle[]; inds: Set<Ind>; onOlder?: () => void; priceLine?: { price: number; title: string }; markers?: SeriesMarker<Time>[]; resetKey: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const extra = useRef<ISeriesApi<'Line' | 'Histogram'>[]>([]);
  const pl = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const shownKey = useRef<string | null>(null);
  const prevFirst = useRef<number | null>(null);
  const older = useRef(onOlder); older.current = onOlder;

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#6b665f', fontFamily: 'Inter Variable, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: '#f3f1ee' }, horzLines: { color: '#f3f1ee' } },
      rightPriceScale: { borderColor: '#e8e6e3' },
      timeScale: { borderColor: '#e8e6e3', timeVisible: true, secondsVisible: false, rightOffset: RIGHT_BARS, minBarSpacing: 0.5, barSpacing: 7 },
      crosshair: { mode: 0 },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    chart.current = c;
    main.current = c.addCandlestickSeries({ upColor: '#16a34a', downColor: '#dc2626', borderVisible: false, wickUpColor: '#16a34a', wickDownColor: '#dc2626' });
    box.current.querySelector('a')?.setAttribute('aria-label', 'TradingView Lightweight Charts');
    // Near the left edge: ask for older candles.
    c.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r && r.from < 30) older.current?.(); });
    return () => { c.remove(); chart.current = null; main.current = null; extra.current = []; pl.current = null; };
  }, []);

  useEffect(() => {
    const c = chart.current, m = main.current;
    if (!c || !m || !candles.length) return;
    const ts = c.timeScale();
    const before = ts.getVisibleLogicalRange();
    const added = prevFirst.current !== null && candles[0].time < prevFirst.current && shownKey.current === resetKey
      ? candles.findIndex((x) => x.time === prevFirst.current) : 0;
    m.setData(candles.map((d) => ({ ...d, time: d.time as UTCTimestamp })));

    for (const x of extra.current) c.removeSeries(x);
    extra.current = [];
    const times = candles.map((d) => d.time), close = candles.map((d) => d.close);
    const showRsi = inds.has('rsi'), showVol = inds.has('vol');
    m.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: showRsi ? (showVol ? 0.4 : 0.26) : showVol ? 0.2 : 0.06 } });
    const addLine = (xs: number[], color: string, width: 1 | 2 = 1, scale?: string) => {
      const s = c.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...(scale ? { priceScaleId: scale } : {}) });
      s.setData(line(times, xs)); extra.current.push(s); return s;
    };
    if (inds.has('ma')) [7, 25, 99].forEach((n, i) => addLine(I.sma(close, n), MA_COLORS[i]));
    if (inds.has('ema')) addLine(I.ema(close, 20), '#db2777');
    if (inds.has('boll')) { const b = I.boll(close); addLine(b.up, '#94a3b8'); addLine(b.mid, '#64748b'); addLine(b.lo, '#94a3b8'); }
    if (showVol) {
      const v = c.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
      v.priceScale().applyOptions({ scaleMargins: { top: showRsi ? 0.64 : 0.82, bottom: showRsi ? 0.23 : 0 } });
      v.setData(candles.map((d) => ({ time: d.time as UTCTimestamp, value: d.volume, color: d.close >= d.open ? 'rgba(22,163,74,.35)' : 'rgba(220,38,38,.35)' })));
      extra.current.push(v);
    }
    if (showRsi) {
      const r = addLine(I.rsi(close), '#7c5cf0', 1, 'rsi');
      r.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0.02 } });
      r.applyOptions({ lastValueVisible: true });
      r.createPriceLine({ price: 70, color: '#e8a0a0', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      r.createPriceLine({ price: 30, color: '#9fd3b0', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    }

    m.setMarkers(markers ?? []);
    if (pl.current) { m.removePriceLine(pl.current); pl.current = null; }
    if (priceLine) pl.current = m.createPriceLine({ price: priceLine.price, color: '#7c5cf0', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: priceLine.title });

    if (shownKey.current !== resetKey) {
      // New market or interval: show the latest FIRST_VIEW bars with room on the right.
      ts.setVisibleLogicalRange({ from: candles.length - FIRST_VIEW, to: candles.length + RIGHT_BARS });
      shownKey.current = resetKey;
    } else if (added > 0 && before) {
      // Older candles were prepended: keep the same bars in view.
      ts.setVisibleLogicalRange({ from: before.from + added, to: before.to + added });
    }
    prevFirst.current = candles[0].time;
  }, [candles, inds, priceLine?.price, priceLine?.title, markers, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={box} className="chart" />;
}

function IndMenu({ on, toggle }: { on: Set<Ind>; toggle: (i: Ind) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="ind-menu" ref={ref}>
      <button className={`ind-btn${open ? ' on' : ''}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M2 12l4-5 3 3 5-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {t.indicators}{on.size > 0 && <span className="ind-count">{on.size}</span>}
      </button>
      {open && (
        <div className="ind-pop" role="menu">
          {IND_ALL.map((i) => (
            <label key={i} className="ind-item" role="menuitemcheckbox" aria-checked={on.has(i)}>
              <input type="checkbox" checked={on.has(i)} onChange={() => toggle(i)} />
              <span><b>{t.ind[i][0]}</b><small>{t.ind[i][1]}</small></span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function IntervalBar<T extends string>({ list, value, set, label }: { list: readonly T[]; value: T; set: (v: T) => void; label: (v: T) => string }) {
  return (
    <div className="iv-group" role="group" aria-label="Interval">
      {list.map((iv) => <button key={iv} className={iv === value ? 'on' : ''} aria-pressed={iv === value} onClick={() => set(iv)}>{label(iv)}</button>)}
    </div>
  );
}

/** Keeps the newest candles fresh and pages older ones in on demand. */
function useCandles(key: string, latest: (limit: number) => Promise<cex.Candle[]>, olderThan: (first: cex.Candle) => Promise<cex.Candle[]>, refreshMs: number) {
  const [candles, setCandles] = useState<cex.Candle[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false), done = useRef(false), cur = useRef<cex.Candle[]>([]), fns = useRef({ latest, olderThan }), keyNow = useRef(key);
  fns.current = { latest, olderThan }; keyNow.current = key;
  useEffect(() => {
    let alive = true;
    cur.current = []; setCandles([]); setErr(null); done.current = false;
    const load = () => fns.current.latest(cur.current.length ? 100 : 1000).then((k) => {
      if (!alive || !k.length) return;
      const keep = cur.current.filter((c) => c.time < k[0].time);
      cur.current = [...keep, ...k]; setCandles(cur.current); setErr(null);
    }).catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)));
    load();
    const x = setInterval(load, refreshMs);
    return () => { alive = false; clearInterval(x); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = () => {
    const first = cur.current[0];
    if (!first || busy.current || done.current) return;
    busy.current = true;
    const k0 = key;
    fns.current.olderThan(first).then((k) => {
      if (k0 !== keyNow.current) return;
      const add = k.filter((c) => c.time < first.time);
      if (!add.length) { done.current = true; return; }
      cur.current = [...add, ...cur.current]; setCandles(cur.current);
    }).catch(() => undefined).finally(() => { busy.current = false; });
  };
  return { candles, err, more };
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return <div className="stat"><span className="muted">{label}</span><span className={cls}>{value}</span></div>;
}

/* ---------- CEX: HashKey Global BTC/USDT perpetual ---------- */

/** Live perp data. One failed poll keeps the last numbers (marked stale); only a run of failures shows "unavailable". */
function useCex() {
  const [t, setT] = useState<cex.Ticker | null>(null);
  const [tape, setTape] = useState<cex.Trade[]>([]);
  const [mi, setMi] = useState<{ mark: number; index: number } | null>(null);
  const [at, setAt] = useState(0);
  const [fails, setFails] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fast = async () => {
      const [a, c] = await Promise.allSettled([cex.ticker(), cex.trades(20)]);
      if (!alive) return;
      if (a.status === 'fulfilled') { setT(a.value); setAt(Date.now()); setFails(0); setErr(null); }
      else { setFails((n) => n + 1); setErr(a.reason instanceof Error ? a.reason.message : String(a.reason)); }
      if (c.status === 'fulfilled') setTape(c.value);
    };
    const slow = () => cex.markAndIndex().then((x) => alive && setMi(x)).catch(() => undefined);
    fast(); slow();
    const a = setInterval(fast, 4000), b = setInterval(slow, 10000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, []);

  // LIVE, STALE (last good numbers, with their age) or UNAVAILABLE (never loaded, or failing for a while).
  const state: 'live' | 'stale' | 'down' = fails === 0 ? 'live' : t && fails < 8 ? 'stale' : 'down';
  return { t, tape, mi, err, state, at };
}

const CEX_IV = ['1m', '15m', '1h', '4h', '1d', '1w'] as const;
const DEX_IV = ['15m', '1h', '4h', '1d', '7d'] as const;
function stored<T extends string>(key: string, list: readonly T[], dflt: T): T {
  try { const v = localStorage.getItem(key) as T | null; if (v && list.includes(v)) return v; } catch { /* storage unavailable */ }
  return dflt;
}
const save = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } };

function CexPanel({ dexBtc, quotes, onPick }: { dexBtc?: number; quotes: Quote[]; onPick: (n: StratNote) => void }) {
  const { t: s } = useT();
  const [interval, setIv] = useState<cex.Interval>(() => stored('moa.iv', CEX_IV, '4h'));
  const pickIv = (v: cex.Interval) => { setIv(v); save('moa.iv', v); };
  const { t, tape, mi, err, state, at } = useCex();
  const [inds, toggleInd] = useStoredInds();
  const { candles, more } = useCandles(`cex-${interval}`, (n) => cex.klines(interval, n), (first) => cex.klines(interval, 1000, first.time * 1000 - 1), 15000);
  const chg = t ? (t.last / t.open - 1) * 100 : 0;
  const up = chg >= 0;

  return (
    <>
      <div className="market-head card">
        <div className="pair">
          <span className="coin coin-btc big" />
          <div>
            <div className="pair-name">BTC/USDT <span className="tag">{s.perpetual}</span></div>
            <div className="muted">{s.usdtMargined}</div>
          </div>
        </div>
        <div className={`last ${up ? 'pos' : 'neg'}`}>{t ? usd(t.last, 1) : '—'}</div>
        <div className="stats">
          <Stat label={s.change24h} value={t ? `${arrow(up)} ${up ? '+' : ''}${chg.toFixed(2)}%` : '—'} cls={up ? 'pos' : 'neg'} />
          <Stat label={s.mark} value={mi ? usd(mi.mark, 1) : '—'} />
          <Stat label={s.index} value={mi ? usd(mi.index, 1) : '—'} />
          <Stat label={s.high24h} value={t ? usd(t.high, 1) : '—'} />
          <Stat label={s.low24h} value={t ? usd(t.low, 1) : '—'} />
          <Stat label={s.vol24h} value={t ? `${compact(t.volContracts * cex.CONTRACT_BTC)} BTC` : '—'} />
        </div>
        {state === 'stale' && <span className="stale-chip" role="status">{s.staleAt(ago(at))}</span>}
        {state === 'down' && <span className="unavail">{s.feedDown} {err}</span>}
      </div>

      <section className="card chart-card">
        <div className="chart-toolbar">
          <IntervalBar list={CEX_IV} value={interval} set={pickIv} label={(v) => s.ivLabel[v]} />
          <IndMenu on={inds} toggle={toggleInd} />
          <span className={`live${state !== 'live' ? ' is-stale' : ''}`}><span className="live-dot" /> {state === 'live' ? s.live : s.stale} · HashKey Global</span>
        </div>
        {candles.length ? <CandleChart candles={candles} inds={inds} onOlder={more} resetKey={`cex-${interval}`} /> : <div className="chart-empty skel-block" role="status"><span className="sr-only">{s.loadingCandles}</span></div>}
        {dexBtc !== undefined && t && (
          <div className="moa-note">
            <span className="orb sm" aria-hidden />
            {s.dexVsPerp(`$${usd(dexBtc, 0)}`, `${dexBtc >= t.last ? '▲ +' : '▼ '}${((dexBtc / t.last - 1) * 100).toFixed(2)}%`)}
          </div>
        )}
      </section>

      <StrategyGrid venue="cex" quotes={quotes} mark={mi?.mark} index={mi?.index} tape={tape} onPick={onPick} />
    </>
  );
}

/* ---------- DEX: HSKSwap on HSK Chain ---------- */

function DexPanel({ asset, setAsset, detail, err, quotes, onPick }: { asset: Asset; setAsset: (a: Asset) => void; detail: PoolDetail | null; err: string | null; quotes: Quote[]; onPick: (n: StratNote) => void }) {
  const { t: s } = useT();
  const [iv, setIv] = useState<GateInterval>(() => stored('moa.dexiv', DEX_IV, '1h'));
  const pickIv = (v: GateInterval) => { setIv(v); save('moa.dexiv', v); };
  const [inds, toggleInd] = useStoredInds();
  const key = `dex-${asset}-${iv}`;
  const { candles, more } = useCandles(key, (n) => gateCandles(asset, iv, n), (first) => gateCandles(asset, iv, 1000, first.time - 1), 20000);
  const vol = detail ? detail.swaps.reduce((acc, x) => acc + x.usdt, 0) : 0;
  const p = POOLS[asset];
  const gate = quotes.find((q) => q.asset === asset);
  const gap = gate?.gap;

  // Real HSKSwap swaps, pinned to the Gate candle they fall in.
  const markers = useMemo(() => {
    if (!detail || !candles.length) return [];
    const sec = GATE_SECONDS[iv], first = candles[0].time, last = candles[candles.length - 1].time;
    const out: SeriesMarker<Time>[] = [];
    for (const x of [...detail.swaps].reverse()) {
      const t0 = Math.floor(x.time / 1000);
      if (t0 < first || t0 > last + sec) continue;
      let lo = 0, hi = candles.length - 1;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (candles[mid].time <= t0) lo = mid; else hi = mid - 1; }
      const buy = x.side === 'buy';
      out.push({ time: candles[lo].time as UTCTimestamp, position: buy ? 'belowBar' : 'aboveBar', color: buy ? '#16a34a' : '#dc2626', shape: buy ? 'arrowUp' : 'arrowDown', size: 0.8 });
    }
    return out.sort((a, b) => (a.time as number) - (b.time as number));
  }, [detail, candles, iv]);
  const priceLine = useMemo(() => (detail ? { price: detail.price, title: 'HSKSwap' } : undefined), [detail?.price]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="pair-tabs" role="tablist">
        {ASSETS.map((a) => <button key={a} role="tab" aria-selected={a === asset} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}><span className={`coin coin-${a.toLowerCase()}`} />{POOLS[a].symbol}/USDT</button>)}
      </div>
      <div className="market-head card">
        <div className="pair">
          <span className={`coin coin-${asset.toLowerCase()} big`} />
          <div>
            <div className="pair-name">{p.symbol}/USDT <span className="tag">HSKSwap · {s.spot}</span></div>
            <div className="muted">Uniswap V3 · 0.3% · <a href={`${EXPLORER}/address/${p.pool}`} target="_blank" rel="noreferrer" data-tip={p.pool}>{p.pool.slice(0, 6)}…{p.pool.slice(-4)} ↗</a></div>
          </div>
        </div>
        <div className="last">{detail ? `$${fmtPrice(detail.price)}` : '—'}</div>
        <div className="stats">
          <Stat label={s.gateSpot} value={gate?.exchange !== undefined ? `$${fmtPrice(gate.exchange)}` : '—'} />
          <Stat label={s.vsGateLabel} value={gap === undefined ? '—' : `${gap > 0 ? '+' : ''}${(gap * 100).toFixed(2)}%`} cls={gap === undefined ? '' : gap < 0 ? 'pos' : 'neg'} />
          <Stat label={s.poolUsdt} value={detail ? `$${compact(detail.reserveUsdt)}` : '—'} />
          <Stat label={s.swaps24h} value={detail ? String(detail.swaps.length) : '—'} />
          <Stat label={s.vol24h} value={detail ? `$${compact(vol)}` : '—'} />
        </div>
        {err && detail && <span className="stale-chip" role="status">{s.stale}</span>}
        {err && !detail && <span className="unavail">{s.feedDown} {err}</span>}
      </div>
      <section className="card chart-card">
        <div className="chart-toolbar">
          <IntervalBar list={DEX_IV} value={iv} set={pickIv} label={(v) => s.ivLabel[v === '7d' ? '1w' : v]} />
          <IndMenu on={inds} toggle={toggleInd} />
          <span className="live chart-legend"><i className="lg-candle" />{s.dexCandles}<i className="lg-pool" />{s.dexPoolLine}<i className="lg-swap" />{s.dexSwapMarks}</span>
        </div>
        {candles.length ? <CandleChart candles={candles} inds={inds} onOlder={more} priceLine={priceLine} markers={markers} resetKey={key} /> : <div className="chart-empty skel-block" role="status"><span className="sr-only">{s.loadingCandles}</span></div>}
      </section>
      <StrategyGrid venue="dex" quotes={quotes} onPick={onPick} asset={asset} setAsset={setAsset} />
      <section className="card book-card">
        <div className="card-title">{s.recentSwaps}</div>
        <div className="book-cols four muted"><span>{s.side}</span><span>{s.price}</span><span>{s.amount}</span><span>{s.when}</span></div>
        {detail?.swaps.slice(0, 8).map((x) => (
          <a key={x.tx + x.block} className="tape-row four" href={`${EXPLORER}/tx/${x.tx}`} target="_blank" rel="noreferrer">
            <span className={x.side === 'buy' ? 'pos' : 'neg'}>{arrow(x.side === 'buy')} {x.side === 'buy' ? s.buy : s.sell}</span>
            <span>{fmtPrice(x.price)}</span>
            <span>${usd(x.usdt)}</span>
            <span className="muted">{ago(x.time)}</span>
          </a>
        ))}
        {detail && detail.swaps.length === 0 && <div className="muted pad">{s.noSwaps}</div>}
      </section>
    </>
  );
}

/* ---------- page ---------- */

export default function Trade({ onAsk, quotes, vault }: { onAsk: (prompt: string, context?: string) => void; quotes: Quote[]; vault: VaultInfo | null }) {
  const { t } = useT();
  const [venue, setVenue] = useState<Venue>('cex');
  const [note, setNote] = useState<StratNote | null>(null);
  const [asset, setAsset] = useState<Asset>('BTC');
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [dexErr, setDexErr] = useState<string | null>(null);
  const ctx: MoaContext = venue === 'cex' ? { venue, label: t.ctxCex, asset: 'BTC' } : { venue, label: t.ctxDex(POOLS[asset].symbol), asset };
  const pick = (n: StratNote) => { setNote(n); if (window.innerWidth <= 1180) document.querySelector('.feed-dock')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  useEffect(() => {
    let alive = true;
    setDetail(null);
    const load = () => poolDetail(asset).then((d) => { if (alive) { setDetail(d); setDexErr(null); } }).catch((e: unknown) => alive && setDexErr(e instanceof Error ? e.message : String(e)));
    load();
    const x = setInterval(load, 30000);
    return () => { alive = false; clearInterval(x); };
  }, [asset]);

  return (
    <div className="trade-page">
      <div className="trade-main">
        <div className="segmented" role="tablist" aria-label="Venue">
          <button role="tab" aria-selected={venue === 'cex'} className={venue === 'cex' ? 'on' : ''} onClick={() => setVenue('cex')}>{t.cex} <span>{t.cexSub}</span></button>
          <span className="swap-arrows" aria-hidden>⇄</span>
          <button role="tab" aria-selected={venue === 'dex'} className={venue === 'dex' ? 'on' : ''} onClick={() => setVenue('dex')}>{t.dex} <span>{t.dexSub}</span></button>
        </div>
        {venue === 'cex'
          ? <CexPanel dexBtc={asset === 'BTC' ? detail?.price : undefined} quotes={quotes} onPick={pick} />
          : <DexPanel asset={asset} setAsset={setAsset} detail={detail} err={dexErr} quotes={quotes} onPick={pick} />}
        <p className="muted small">{t.dataNote}</p>
      </div>
      <MoaFeed onAsk={onAsk} quotes={quotes} vault={vault} inject={note} context={ctx} />
    </div>
  );
}
