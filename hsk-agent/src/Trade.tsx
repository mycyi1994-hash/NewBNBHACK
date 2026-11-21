import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import * as cex from './cex.ts';
import { EXPLORER, POOLS, poolDetail, type PoolDetail } from './dex.ts';
import { ASSETS, type Asset } from './intent.ts';
import { fmtPrice } from './market.ts';

type Venue = 'cex' | 'dex';
const usd = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (v: number) => v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

/* ---------- chart ---------- */

type ChartData = { kind: 'candles'; data: cex.Candle[] } | { kind: 'line'; data: { time: number; value: number }[] };

function PriceChart({ data, height = 360 }: { data: ChartData; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Area'> | null>(null);
  const kind = useRef<ChartData['kind'] | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#8a857f', fontFamily: 'Inter Variable, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: '#f3f1ee' }, horzLines: { color: '#f3f1ee' } },
      rightPriceScale: { borderColor: '#e8e6e3' },
      timeScale: { borderColor: '#e8e6e3', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
    });
    chart.current = c;
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
  }, [data]);

  return <div ref={box} className="chart" style={{ height }} />;
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
    const fast = () => Promise.all([cex.ticker(), cex.depth(10), cex.trades(18)])
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

function CexPanel({ dexBtc }: { dexBtc?: number }) {
  const [interval, setInterval_] = useState<cex.Interval>('15m');
  const { t, book, tape, candles, mi, err } = useCex(interval);
  const chg = t ? (t.last / t.open - 1) * 100 : 0;
  const maxQty = book ? Math.max(...book.bids.map((x) => x.qty), ...book.asks.map((x) => x.qty), 1) : 1;

  return (
    <>
      <div className="market-head card">
        <div className="pair">
          <span className="coin coin-btc big" />
          <div>
            <div className="pair-name">BTC/USDT <span className="tag">Perpetual</span></div>
            <div className="muted">HashKey Global · USDT-margined</div>
          </div>
        </div>
        <div className={`last ${chg >= 0 ? 'pos' : 'neg'}`}>{t ? usd(t.last, 1) : '—'}</div>
        <Stat label="24h change" value={t ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—'} cls={chg >= 0 ? 'pos' : 'neg'} />
        <Stat label="Mark" value={mi ? usd(mi.mark, 1) : '—'} />
        <Stat label="Index" value={mi ? usd(mi.index, 1) : '—'} />
        <Stat label="24h high" value={t ? usd(t.high, 1) : '—'} />
        <Stat label="24h low" value={t ? usd(t.low, 1) : '—'} />
        <Stat label="24h volume" value={t ? `${compact(t.volContracts * cex.CONTRACT_BTC)} BTC · $${compact(t.volUsdt)}` : '—'} />
        {err && <span className="unavail">Feed unavailable: {err}</span>}
      </div>

      <div className="trade-grid">
        <section className="card chart-card">
          <div className="chart-toolbar">
            {(['1m', '15m', '1h', '4h'] as cex.Interval[]).map((iv) => (
              <button key={iv} className={iv === interval ? 'on' : ''} onClick={() => setInterval_(iv)}>{iv}</button>
            ))}
            <span className="live"><span className="live-dot" /> Live</span>
          </div>
          {candles.length ? <PriceChart data={{ kind: 'candles', data: candles }} /> : <div className="chart-empty muted">Loading candles…</div>}
          {dexBtc !== undefined && t && (
            <div className="moa-note">
              <span className="moa-avatar sm" aria-hidden />
              On HSK Chain, the HSKSwap WBTC pool is at ${usd(dexBtc, 0)}, {Math.abs(dexBtc / t.last - 1) < 0.003 ? 'in line with' : dexBtc > t.last ? `${((dexBtc / t.last - 1) * 100).toFixed(2)}% above` : `${((1 - dexBtc / t.last) * 100).toFixed(2)}% below`} this perpetual.
            </div>
          )}
        </section>

        <section className="card book">
          <div className="card-title">Order book</div>
          <div className="book-cols muted"><span>Price (USDT)</span><span>Size (BTC)</span></div>
          {book?.asks.slice(0, 10).reverse().map((l) => <BookRow key={'a' + l.price} l={l} side="ask" max={maxQty} />)}
          <div className="spread">{t ? <>{usd(t.last, 1)} <span className="muted">spread {usd(t.ask - t.bid, 1)}</span></> : '—'}</div>
          {book?.bids.slice(0, 10).map((l) => <BookRow key={'b' + l.price} l={l} side="bid" max={maxQty} />)}
        </section>

        <section className="card tape">
          <div className="card-title">Recent trades</div>
          <div className="book-cols muted"><span>Price</span><span>Size (BTC)</span><span>Time</span></div>
          {tape.map((x, i) => (
            <div key={i} className="tape-row">
              <span className={x.buyerIsMaker ? 'neg' : 'pos'}>{usd(x.price, 1)}</span>
              <span>{(x.qty * cex.CONTRACT_BTC).toFixed(3)}</span>
              <span className="muted">{ago(x.t)}</span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}

function BookRow({ l, side, max }: { l: cex.Level; side: 'bid' | 'ask'; max: number }) {
  return (
    <div className={`book-row ${side}`}>
      <span className="depth-bar" style={{ width: `${(l.qty / max) * 100}%` }} />
      <span className={side === 'bid' ? 'pos' : 'neg'}>{usd(l.price, 1)}</span>
      <span>{(l.qty * cex.CONTRACT_BTC).toFixed(3)}</span>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return <div className="stat"><span className="muted">{label}</span><span className={cls}>{value}</span></div>;
}

/* ---------- DEX: HSKSwap on HSK Chain ---------- */

function DexPanel({ asset, setAsset, detail, err }: { asset: Asset; setAsset: (a: Asset) => void; detail: PoolDetail | null; err: string | null }) {
  const vol = detail ? detail.swaps.reduce((s, x) => s + x.usdt, 0) : 0;
  const line = detail ? (() => {
    const pts = [...detail.swaps].reverse().map((s) => ({ time: Math.floor(s.time / 1000), value: s.price }));
    pts.push({ time: Math.floor(detail.at / 1000), value: detail.price });
    const dedup: { time: number; value: number }[] = [];
    for (const p of pts) { if (dedup.length && dedup[dedup.length - 1].time >= p.time) dedup[dedup.length - 1] = { ...p, time: dedup[dedup.length - 1].time }; else dedup.push(p); }
    return dedup;
  })() : [];
  const p = POOLS[asset];

  return (
    <>
      <div className="pair-tabs">
        {ASSETS.map((a) => <button key={a} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}><span className={`coin coin-${a.toLowerCase()}`} />{POOLS[a].symbol}/USDT</button>)}
      </div>
      <div className="market-head card">
        <div className="pair">
          <span className={`coin coin-${asset.toLowerCase()} big`} />
          <div>
            <div className="pair-name">{p.symbol}/USDT <span className="tag">HSKSwap · 0.3%</span></div>
            <div className="muted">Uniswap V3 pool on HSK Chain mainnet · <a href={`${EXPLORER}/address/${p.pool}`} target="_blank" rel="noreferrer">{p.pool.slice(0, 6)}…{p.pool.slice(-4)}</a></div>
          </div>
        </div>
        <div className="last">{detail ? `$${fmtPrice(detail.price)}` : '—'}</div>
        <Stat label={`Pool ${p.symbol}`} value={detail ? compact(detail.reserveBase) : '—'} />
        <Stat label="Pool USDT" value={detail ? `$${compact(detail.reserveUsdt)}` : '—'} />
        <Stat label="24h swaps" value={detail ? String(detail.swaps.length) : '—'} />
        <Stat label="24h volume" value={detail ? `$${compact(vol)}` : '—'} />
        <Stat label="Block" value={detail ? detail.head.toLocaleString('en-US') : '—'} />
        {err && <span className="unavail">Chain read failed: {err}</span>}
      </div>
      <div className="trade-grid dex">
        <section className="card chart-card">
          <div className="chart-toolbar"><span className="muted">Pool price from every swap in the last 24 hours</span><span className="live"><span className="live-dot" /> HSK Chain</span></div>
          {line.length > 1 ? <PriceChart data={{ kind: 'line', data: line }} /> : <div className="chart-empty muted">{detail ? 'Fewer than two swaps in 24 hours.' : 'Reading HSK Chain…'}</div>}
        </section>
        <section className="card tape wide">
          <div className="card-title">Recent swaps</div>
          <div className="book-cols four muted"><span>Side</span><span>Price</span><span>Amount</span><span>When</span></div>
          {detail?.swaps.slice(0, 18).map((s) => (
            <a key={s.tx + s.block} className="tape-row four" href={`${EXPLORER}/tx/${s.tx}`} target="_blank" rel="noreferrer">
              <span className={s.side === 'buy' ? 'pos' : 'neg'}>{s.side === 'buy' ? 'Buy' : 'Sell'}</span>
              <span>{fmtPrice(s.price)}</span>
              <span>${usd(s.usdt)}</span>
              <span className="muted">{ago(s.time)}</span>
            </a>
          ))}
          {detail && detail.swaps.length === 0 && <div className="muted pad">No swaps in the last 24 hours.</div>}
        </section>
      </div>
    </>
  );
}

/* ---------- page ---------- */

export default function Trade({ onAsk }: { onAsk: (prompt: string) => void }) {
  const [venue, setVenue] = useState<Venue>('cex');
  const [asset, setAsset] = useState<Asset>('BTC');
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [dexErr, setDexErr] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let alive = true;
    setDetail(null);
    const load = () => poolDetail(asset).then((d) => { if (alive) { setDetail(d); setDexErr(null); } }).catch((e: unknown) => alive && setDexErr(e instanceof Error ? e.message : String(e)));
    load();
    const x = setInterval(load, 30000);
    return () => { alive = false; clearInterval(x); };
  }, [asset]);

  return (
    <div className="page trade-page">
      <div className="venue-row">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={venue === 'cex'} className={venue === 'cex' ? 'on' : ''} onClick={() => setVenue('cex')}>CEX <span>HashKey Global</span></button>
          <span className="swap-arrows" aria-hidden>⇄</span>
          <button role="tab" aria-selected={venue === 'dex'} className={venue === 'dex' ? 'on' : ''} onClick={() => setVenue('dex')}>DEX <span>HSK Chain · HSKSwap</span></button>
        </div>
        <form className="ask-inline" onSubmit={(e) => { e.preventDefault(); onAsk(draft.trim()); }}>
          <span className="moa-avatar sm" aria-hidden />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask Moa: “Collect $10 of BTC every day…”" aria-label="Ask Moa" />
          <button className="btn-dark" type="submit">Ask</button>
        </form>
      </div>
      {venue === 'cex'
        ? <CexPanel dexBtc={asset === 'BTC' ? detail?.price : undefined} />
        : <DexPanel asset={asset} setAsset={setAsset} detail={detail} err={dexErr} />}
      <p className="muted small">Market data: HashKey Global public API and HSK Chain mainnet (chain 177). Read-only; Moa does not place orders yet.</p>
    </div>
  );
}
