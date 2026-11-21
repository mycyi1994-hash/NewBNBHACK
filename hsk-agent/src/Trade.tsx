import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import * as cex from './cex.ts';
import { EXPLORER, POOLS, poolDetail, type PoolDetail } from './dex.ts';
import { ASSETS, type Asset } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import type { VaultInfo } from './parts.tsx';
import Strategies from './Strategies.tsx';
import MoaFeed from './MoaFeed.tsx';

type Venue = 'cex' | 'dex';
const usd = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (v: number) => v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const arrow = (up: boolean) => (up ? '▲' : '▼');

/* ---------- chart ---------- */

type ChartData = { kind: 'candles'; data: cex.Candle[] } | { kind: 'line'; data: { time: number; value: number }[] };

function PriceChart({ data }: { data: ChartData }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Area'> | null>(null);
  const kind = useRef<ChartData['kind'] | null>(null);
  const fittedFrom = useRef<number | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#6b665f', fontFamily: 'Inter Variable, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: '#f3f1ee' }, horzLines: { color: '#f3f1ee' } },
      rightPriceScale: { borderColor: '#e8e6e3' },
      timeScale: { borderColor: '#e8e6e3', timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: 1 },
    });
    chart.current = c;
    // The library adds an unlabeled TradingView attribution link; give it a name for screen readers.
    box.current.querySelector("a")?.setAttribute("aria-label", "TradingView Lightweight Charts");
    return () => { c.remove(); chart.current = null; series.current = null; kind.current = null; };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (kind.current !== data.kind) {
      if (series.current) c.removeSeries(series.current);
      series.current = data.kind === 'candles'
        ? c.addCandlestickSeries({ upColor: '#16a34a', downColor: '#dc2626', borderVisible: false, wickUpColor: '#16a34a', wickDownColor: '#dc2626' })
        : c.addAreaSeries({ lineColor: '#7c5cf0', topColor: 'rgba(124,92,240,0.22)', bottomColor: 'rgba(124,92,240,0.02)', lineWidth: 2 });
      kind.current = data.kind;
    }
    if (data.kind === 'candles') (series.current as ISeriesApi<'Candlestick'>).setData(data.data.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    else (series.current as ISeriesApi<'Area'>).setData(data.data.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    // Fill the chart width on a new series or interval; live refreshes keep the user's zoom.
    const first = data.data[0]?.time;
    if (first !== undefined && fittedFrom.current !== first) { c.timeScale().fitContent(); fittedFrom.current = first; }
  }, [data]);

  return <div ref={box} className="chart" />;
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return <div className="stat"><span className="muted">{label}</span><span className={cls}>{value}</span></div>;
}

/* ---------- CEX: HashKey Global BTC/USDT perpetual ---------- */

function useCex(interval: cex.Interval) {
  const [t, setT] = useState<cex.Ticker | null>(null);
  const [book, setBook] = useState<{ bids: cex.Level[]; asks: cex.Level[] } | null>(null);
  const [tape, setTape] = useState<cex.Trade[]>([]);
  const [candles, setCandles] = useState<cex.Candle[]>([]);
  const [mi, setMi] = useState<{ mark: number; index: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fast = () => Promise.all([cex.ticker(), cex.depth(8), cex.trades(20)])
      .then(([a, b, c]) => { if (alive) { setT(a); setBook(b); setTape(c); setErr(null); } })
      .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)));
    const slow = () => cex.markAndIndex().then((x) => alive && setMi(x)).catch(() => undefined);
    fast(); slow();
    const a = setInterval(fast, 3000), b = setInterval(slow, 10000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => cex.klines(interval).then((k) => alive && setCandles(k)).catch(() => undefined);
    load();
    const x = setInterval(load, 15000);
    return () => { alive = false; clearInterval(x); };
  }, [interval]);

  return { t, book, tape, candles, mi, err };
}

function CexPanel({ dexBtc, quotes, onAsk }: { dexBtc?: number; quotes: Quote[]; onAsk: (prompt: string) => void }) {
  const { t: s } = useT();
  const [interval, setIv] = useState<cex.Interval>('15m');
  const { t, tape, candles, mi, err } = useCex(interval);
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
        {err && <span className="unavail">{s.feedDown} {err}</span>}
      </div>

      <section className="card chart-card">
        <div className="chart-toolbar" role="group" aria-label="Interval">
          {(['1m', '15m', '1h', '4h'] as cex.Interval[]).map((iv) => (
            <button key={iv} className={iv === interval ? 'on' : ''} aria-pressed={iv === interval} onClick={() => setIv(iv)}>{iv}</button>
          ))}
          <span className="live"><span className="live-dot" /> {s.live}</span>
        </div>
        {candles.length ? <PriceChart data={{ kind: 'candles', data: candles }} /> : <div className="chart-empty skel-block" role="status"><span className="sr-only">{s.loadingCandles}</span></div>}
        {dexBtc !== undefined && t && (
          <div className="moa-note">
            <span className="orb sm" aria-hidden />
            {s.dexVsPerp(`$${usd(dexBtc, 0)}`, `${dexBtc >= t.last ? '▲ +' : '▼ '}${((dexBtc / t.last - 1) * 100).toFixed(2)}%`)}
          </div>
        )}
      </section>

      <Strategies quotes={quotes} mark={mi?.mark} index={mi?.index} tape={tape} onAsk={onAsk} />
    </>
  );
}

/* ---------- DEX: HSKSwap on HSK Chain ---------- */

function DexPanel({ asset, setAsset, detail, err }: { asset: Asset; setAsset: (a: Asset) => void; detail: PoolDetail | null; err: string | null }) {
  const { t: s } = useT();
  const vol = detail ? detail.swaps.reduce((acc, x) => acc + x.usdt, 0) : 0;
  const line = detail ? (() => {
    const pts = [...detail.swaps].reverse().map((x) => ({ time: Math.floor(x.time / 1000), value: x.price }));
    pts.push({ time: Math.floor(detail.at / 1000), value: detail.price });
    const dedup: { time: number; value: number }[] = [];
    for (const p of pts) { if (dedup.length && dedup[dedup.length - 1].time >= p.time) dedup[dedup.length - 1] = { ...p, time: dedup[dedup.length - 1].time }; else dedup.push(p); }
    return dedup;
  })() : [];
  const p = POOLS[asset];

  return (
    <>
      <div className="pair-tabs" role="tablist">
        {ASSETS.map((a) => <button key={a} role="tab" aria-selected={a === asset} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}><span className={`coin coin-${a.toLowerCase()}`} />{POOLS[a].symbol}/USDT</button>)}
      </div>
      <div className="market-head card">
        <div className="pair">
          <span className={`coin coin-${asset.toLowerCase()} big`} />
          <div>
            <div className="pair-name">{p.symbol}/USDT <span className="tag">HSKSwap · 0.3%</span></div>
            <div className="muted">Uniswap V3 · <a href={`${EXPLORER}/address/${p.pool}`} target="_blank" rel="noreferrer" data-tip={p.pool}>{p.pool.slice(0, 6)}…{p.pool.slice(-4)} ↗</a></div>
          </div>
        </div>
        <div className="last">{detail ? `$${fmtPrice(detail.price)}` : '—'}</div>
        <div className="stats">
          <Stat label={s.poolOf(p.symbol)} value={detail ? compact(detail.reserveBase) : '—'} />
          <Stat label={s.poolUsdt} value={detail ? `$${compact(detail.reserveUsdt)}` : '—'} />
          <Stat label={s.swaps24h} value={detail ? String(detail.swaps.length) : '—'} />
          <Stat label={s.vol24h} value={detail ? `$${compact(vol)}` : '—'} />
          <Stat label={s.block} value={detail ? detail.head.toLocaleString('en-US') : '—'} />
        </div>
        {err && <span className="unavail">{err}</span>}
      </div>
      <section className="card chart-card">
        <div className="chart-toolbar"><span className="muted">{s.poolLine}</span><span className="live"><span className="live-dot" /> HSK Chain</span></div>
        {line.length > 1 ? <PriceChart data={{ kind: 'line', data: line }} /> : detail ? <div className="chart-empty muted">{s.fewSwaps}</div> : <div className="chart-empty skel-block" role="status"><span className="sr-only">{s.readingChain}</span></div>}
      </section>
      <section className="card book-card">
        <div className="card-title">{s.recentSwaps}</div>
        <div className="book-cols four muted"><span>{s.side}</span><span>{s.price}</span><span>{s.amount}</span><span>{s.when}</span></div>
        {detail?.swaps.slice(0, 12).map((x) => (
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
  const [asset, setAsset] = useState<Asset>('BTC');
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [dexErr, setDexErr] = useState<string | null>(null);

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
          ? <CexPanel dexBtc={asset === 'BTC' ? detail?.price : undefined} quotes={quotes} onAsk={(p) => onAsk(p)} />
          : <DexPanel asset={asset} setAsset={setAsset} detail={detail} err={dexErr} />}
        <p className="muted small">{t.dataNote}</p>
      </div>
      <MoaFeed onAsk={onAsk} quotes={quotes} vault={vault} />
    </div>
  );
}
