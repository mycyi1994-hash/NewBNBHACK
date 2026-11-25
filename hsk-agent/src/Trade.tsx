import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts';
import * as cex from './cex.ts';
import * as I from './indicators.ts';
import { gateCandles, GATE_SECONDS, type GateInterval } from './gate.ts';
import { EXPLORER, POOLS, poolDetail, type PoolDetail } from './dex.ts';
import { ASSETS, type Asset } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import { RollNum, SlidePill } from './motion.tsx';
import MarketAgents from './Strategies.tsx';
import type { Agent } from './agents.ts';
import type { MoaContext } from './MoaFeed.tsx';
import { CoinMark } from './CoinMark.tsx';

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

/** Korean axis labels (2026 · 11월 · 21일 · 14:00); English keeps the library's own labels. */
function koTicks(time: Time, type: number): string | null {
  if (document.documentElement.lang === 'en' || typeof time !== 'number') return null;
  const d = new Date(time * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  switch (type) {
    case 0: return String(d.getFullYear());
    case 1: return `${d.getMonth() + 1}월`;
    case 2: return `${d.getDate()}일`;
    default: return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}

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
      timeScale: { borderColor: '#e8e6e3', timeVisible: true, secondsVisible: false, rightOffset: RIGHT_BARS, minBarSpacing: 0.5, barSpacing: 7, tickMarkFormatter: koTicks },
      crosshair: { mode: 0 },
      localization: { locale: document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR', dateFormat: document.documentElement.lang === 'en' ? 'dd MMM \'yy' : 'yyyy-MM-dd' },
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
    <div className="iv-group has-pill" role="group" aria-label="Interval">
      <SlidePill dep={value} />
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
  return <div className="stat"><span className="muted">{label}</span><RollNum className={cls} text={value} /></div>;
}

/* ---------- CEX: HashKey Global BTC/USDT perpetual ---------- */

/** Live market data for one HashKey Global market. A failed poll keeps the last numbers; the next poll catches up. */
function useCex(m: cex.Market) {
  const [t, setT] = useState<cex.Ticker | null>(null);
  const [mi, setMi] = useState<{ mark: number; index: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setT(null); setMi(null);
    const fast = () => { cex.ticker(m).then((x) => alive && setT(x)).catch(() => undefined); };
    const slow = () => { if (m.kind === 'perp') cex.markAndIndex(m).then((x) => alive && setMi(x)).catch(() => undefined); };
    fast(); slow();
    const a = setInterval(fast, 4000), b = setInterval(slow, 10000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, [m.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  return { t, mi };
}

/** Price with sensible decimals for anything from BTC to DOGE. */
const px = (v: number) => (v >= 1000 ? usd(v, 1) : v >= 1 ? usd(v, 2) : fmtPrice(v));

/** Market picker (Binance/Upbit style): search, perpetuals first, then spot, each with live price and 24h change. */
function MarketPicker({ value, onChange }: { value: cex.Market; onChange: (m: cex.Market) => void }) {
  const { t: s } = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [tick, setTick] = useState<Record<string, cex.Ticker>>({});
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => cex.allTickers().then((x) => alive && setTick(x)).catch(() => undefined);
    load();
    const id = setInterval(load, 8000);
    setTimeout(() => search.current?.focus(), 30);
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { alive = false; clearInterval(id); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const list = cex.MARKETS.filter((m) => !q || m.base.toLowerCase().includes(q.trim().toLowerCase()));
  const row = (m: cex.Market) => {
    const x = tick[m.symbol];
    const chg = x ? (x.last / x.open - 1) * 100 : undefined;
    return (
      <button key={m.symbol} role="option" aria-selected={m.symbol === value.symbol} className={`mk-row${m.symbol === value.symbol ? ' on' : ''}`}
        onClick={() => { onChange(m); setOpen(false); setQ(''); }}>
        <CoinMark base={m.base} />
        <span className="mk-name"><b>{m.base}</b><small>{m.kind === 'perp' ? s.perpetual : s.spotTag}</small></span>
        <span className="mk-px">{x ? px(x.last) : '—'}</span>
        <span className={`mk-chg ${chg === undefined ? '' : chg >= 0 ? 'pos' : 'neg'}`}>{chg === undefined ? '' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`}</span>
      </button>
    );
  };
  const perps = list.filter((m) => m.kind === 'perp'), spots = list.filter((m) => m.kind === 'spot');

  return (
    <div className="mk-picker" ref={ref}>
      <button className="pair mk-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <CoinMark base={value.base} big />
        <div>
          <div className="pair-name">{value.base}/USDT <span className="tag">{value.kind === 'perp' ? s.perpetual : s.spotTag}</span>
            <svg className="mk-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div className="muted">{value.kind === 'perp' ? s.usdtMargined : s.spotSub}</div>
        </div>
      </button>
      {open && (
        <div className="mk-pop" role="listbox" aria-label={s.marketSearch}>
          <input ref={search} className="mk-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={s.marketSearch} aria-label={s.marketSearch} />
          <div className="mk-list">
            {perps.length > 0 && <div className="mk-group">{s.perpsLabel}</div>}
            {perps.map(row)}
            {spots.length > 0 && <div className="mk-group">{s.spotsLabel}</div>}
            {spots.map(row)}
          </div>
        </div>
      )}
    </div>
  );
}

const CEX_IV = ['1m', '15m', '1h', '4h', '1d', '1w'] as const;
const DEX_IV = ['15m', '1h', '4h', '1d', '7d'] as const;
function stored<T extends string>(key: string, list: readonly T[], dflt: T): T {
  try { const v = localStorage.getItem(key) as T | null; if (v && list.includes(v)) return v; } catch { /* storage unavailable */ }
  return dflt;
}
const save = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } };

function CexPanel({ market, setMarket, dexPrice, onPick }: { market: cex.Market; setMarket: (m: cex.Market) => void; dexPrice?: number; onPick: (a: Agent) => void }) {
  const { t: s } = useT();
  const [interval, setIv] = useState<cex.Interval>(() => stored('moa.iv', CEX_IV, '4h'));
  const pickIv = (v: cex.Interval) => { setIv(v); save('moa.iv', v); };
  const { t, mi } = useCex(market);
  const [inds, toggleInd] = useStoredInds();
  const key = `cex-${market.symbol}-${interval}`;
  const { candles, more } = useCandles(key, (n) => cex.klines(market, interval, n), (first) => cex.klines(market, interval, 1000, first.time * 1000 - 1), 15000);
  const chg = t ? (t.last / t.open - 1) * 100 : 0;
  const up = chg >= 0;
  const perp = market.kind === 'perp';

  return (
    <>
      <div className="market-head card">
        <MarketPicker value={market} onChange={setMarket} />
        <div className={`last ${up ? 'pos' : 'neg'}`}><RollNum text={t ? px(t.last) : '—'} /></div>
        <div className="stats">
          <Stat label={s.change24h} value={t ? `${arrow(up)} ${up ? '+' : ''}${chg.toFixed(2)}%` : '—'} cls={up ? 'pos' : 'neg'} />
          {perp && <Stat label={s.mark} value={mi ? px(mi.mark) : '—'} />}
          {perp && <Stat label={s.index} value={mi ? px(mi.index) : '—'} />}
          <Stat label={s.high24h} value={t ? px(t.high) : '—'} />
          <Stat label={s.low24h} value={t ? px(t.low) : '—'} />
          <Stat label={s.vol24h} value={t ? `${compact(t.volBase)} ${market.base}` : '—'} />
        </div>
      </div>

      <section className="card chart-card">
        <div className="chart-toolbar">
          <IntervalBar list={CEX_IV} value={interval} set={pickIv} label={(v) => s.ivLabel[v]} />
          <IndMenu on={inds} toggle={toggleInd} />
          <span className="live"><span className="live-dot" /> {s.live} · HashKey Global</span>
        </div>
        {candles.length ? <CandleChart candles={candles} inds={inds} onOlder={more} resetKey={key} /> : <div className="chart-empty skel-block" role="status"><span className="sr-only">{s.loadingCandles}</span></div>}
        {dexPrice !== undefined && t && (
          <div className="moa-note">
            <span className="orb sm" aria-hidden />
            {s.dexVsPerp(`$${px(dexPrice)}`, `${dexPrice >= t.last ? '▲ +' : '▼ '}${((dexPrice / t.last - 1) * 100).toFixed(2)}%`)}
          </div>
        )}
      </section>

      <MarketAgents venue="cex" market={market} onPick={onPick} />
    </>
  );
}

/* ---------- DEX: HSKSwap on HSK Chain ---------- */

function DexPanel({ asset, setAsset, detail, quotes, onPick }: { asset: Asset; setAsset: (a: Asset) => void; detail: PoolDetail | null; quotes: Quote[]; onPick: (a: Agent) => void }) {
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
        <div className="last"><RollNum text={detail ? `$${fmtPrice(detail.price)}` : '—'} /></div>
        <div className="stats">
          <Stat label={s.gateSpot} value={gate?.exchange !== undefined ? `$${fmtPrice(gate.exchange)}` : '—'} />
          <Stat label={s.vsGateLabel} value={gap === undefined ? '—' : `${gap > 0 ? '+' : ''}${(gap * 100).toFixed(2)}%`} cls={gap === undefined ? '' : gap < 0 ? 'pos' : 'neg'} />
          <Stat label={s.poolUsdt} value={detail ? `$${compact(detail.reserveUsdt)}` : '—'} />
          <Stat label={s.swaps24h} value={detail ? String(detail.swaps.length) : '—'} />
          <Stat label={s.vol24h} value={detail ? `$${compact(vol)}` : '—'} />
        </div>
      </div>
      <section className="card chart-card">
        <div className="chart-toolbar">
          <IntervalBar list={DEX_IV} value={iv} set={pickIv} label={(v) => s.ivLabel[v === '7d' ? '1w' : v]} />
          <IndMenu on={inds} toggle={toggleInd} />
          <span className="live chart-legend"><i className="lg-candle" />{s.dexCandles}<i className="lg-pool" />{s.dexPoolLine}<i className="lg-swap" />{s.dexSwapMarks}</span>
        </div>
        {candles.length ? <CandleChart candles={candles} inds={inds} onOlder={more} priceLine={priceLine} markers={markers} resetKey={key} /> : <div className="chart-empty skel-block" role="status"><span className="sr-only">{s.loadingCandles}</span></div>}
      </section>
      <MarketAgents venue="dex" asset={asset} setAsset={setAsset} onPick={onPick} />
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

export default function Trade({ quotes, onContext, onPick }: { quotes: Quote[]; onContext: (c: MoaContext) => void; onPick: (a: Agent) => void }) {
  const { t } = useT();
  const [venue, setVenue] = useState<Venue>('cex');
  const [asset, setAsset] = useState<Asset>('BTC');
  const [market, setMarketState] = useState<cex.Market>(() => { try { return cex.marketBySymbol(localStorage.getItem('moa.market') ?? ''); } catch { return cex.DEFAULT_MARKET; } });
  const setMarket = (m: cex.Market) => { setMarketState(m); save('moa.market', m.symbol); };
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const ctx: MoaContext = venue === 'cex' ? { venue, label: t.ctxCex(market.base, market.kind === 'perp'), asset: market.base, perp: market.kind === 'perp' } : { venue, label: t.ctxDex(POOLS[asset].symbol), asset, perp: false };
  // Moa sits outside this page; tell it what the user is looking at.
  useEffect(() => { onContext(ctx); }, [ctx.label]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if ((ASSETS as readonly string[]).includes(market.base)) setAsset(market.base as Asset); }, [market.base]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    const load = () => poolDetail(asset).then((d) => { if (alive) setDetail(d); }).catch(() => undefined);
    load();
    const x = setInterval(load, 30000);
    return () => { alive = false; clearInterval(x); };
  }, [asset]);

  return (
    <div className="trade-page">
      <div className="trade-main">
        <div className="segmented has-pill" role="tablist" aria-label="Venue">
          <SlidePill dep={venue} />
          <button role="tab" aria-selected={venue === 'cex'} className={venue === 'cex' ? 'on' : ''} onClick={() => setVenue('cex')}>{t.cex} <span>{t.cexSub}</span></button>
          <span className="swap-arrows" aria-hidden>⇄</span>
          <button role="tab" aria-selected={venue === 'dex'} className={venue === 'dex' ? 'on' : ''} onClick={() => setVenue('dex')}>{t.dex} <span>{t.dexSub}</span></button>
        </div>
        {venue === 'cex'
          ? <CexPanel market={market} setMarket={setMarket} dexPrice={market.base === asset ? detail?.price : undefined} onPick={onPick} />
          : <DexPanel asset={asset} setAsset={setAsset} detail={detail} quotes={quotes} onPick={onPick} />}
        <p className="muted small">{t.dataNote}</p>
      </div>
    </div>
  );
}
