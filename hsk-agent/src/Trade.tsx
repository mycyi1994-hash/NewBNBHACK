import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import * as cex from './cex.ts';
import { EXPLORER, POOLS, poolDetail, type PoolDetail } from './dex.ts';
import { ASSETS, type Asset } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import { MoaGlyph, SpreadTable, VaultPanel, type VaultInfo } from './parts.tsx';

type Venue = 'cex' | 'dex';
type Book = { bids: cex.Level[]; asks: cex.Level[] };
const usd = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (v: number) => v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* ---------- chart ---------- */

type ChartData = { kind: 'candles'; data: cex.Candle[] } | { kind: 'line'; data: { time: number; value: number }[] };
const C = { bg: '#101317', grid: '#181c22', text: '#8b939e', border: '#22272e', up: '#2ebd85', down: '#f6465d', line: '#d7dbe0' };

function PriceChart({ data }: { data: ChartData }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Area'> | null>(null);
  const kind = useRef<ChartData['kind'] | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: C.bg }, textColor: C.text, fontFamily: 'Inter Variable, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      // Same number format as the rest of the app: 64,000 not 64000.00.
      localization: { priceFormatter: (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: p < 1 ? 5 : p < 100 ? 3 : 0 }) },
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
        ? c.addCandlestickSeries({ upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down })
        : c.addAreaSeries({ lineColor: C.line, topColor: 'rgba(215,219,224,0.12)', bottomColor: 'rgba(215,219,224,0)', lineWidth: 2, lineType: LineType.WithSteps, pointMarkersVisible: true, pointMarkersRadius: 3 });
      kind.current = data.kind;
    }
    if (data.kind === 'candles') (series.current as ISeriesApi<'Candlestick'>).setData(data.data.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    else { (series.current as ISeriesApi<'Area'>).setData(data.data.map((d) => ({ ...d, time: d.time as UTCTimestamp }))); c.timeScale().fitContent(); }
  }, [data]);

  return <div ref={box} className="chart" />;
}

function Stat({ label, value, cls, tip }: { label: string; value: string; cls?: string; tip?: string }) {
  return <div className="stat" title={tip}><span className={tip ? 'has-tip' : undefined}>{label}</span><b className={cls}>{value}</b></div>;
}

/* ---------- data hooks ---------- */

function useCex(interval: cex.Interval) {
  const [t, setT] = useState<cex.Ticker | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [tape, setTape] = useState<cex.Trade[]>([]);
  const [candles, setCandles] = useState<cex.Candle[]>([]);
  const [mi, setMi] = useState<{ mark: number; index: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fast = () => Promise.all([cex.ticker(), cex.depth(12), cex.trades(24)])
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

function useDex(asset: Asset) {
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    const load = () => poolDetail(asset).then((d) => { if (alive) { setDetail(d); setErr(null); } }).catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)));
    load();
    const x = setInterval(load, 30000);
    return () => { alive = false; clearInterval(x); };
  }, [asset]);
  return { detail, err };
}

/* ---------- order book / trades / swaps ---------- */

function OrderBook({ book, t, tape }: { book: Book | null; t: cex.Ticker | null; tape: cex.Trade[] }) {
  const { t: s } = useT();
  const [tab, setTab] = useState<'book' | 'trades'>('book');
  const asks = book ? book.asks.slice(0, 7) : [];
  const bids = book ? book.bids.slice(0, 7) : [];
  const max = Math.max(1, ...asks.map((x) => x.qty), ...bids.map((x) => x.qty));
  return (
    <section className="panel book">
      <div className="panel-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'book'} className={tab === 'book' ? 'on' : ''} onClick={() => setTab('book')}>{s.orderBook}</button>
        <button role="tab" aria-selected={tab === 'trades'} className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>{s.recentTrades}</button>
      </div>
      {tab === 'book' ? (
        <div className="book-body">
          <div className="cols"><span>{s.price}</span><span>{s.size}</span></div>
          <div className="asks">{[...asks].reverse().map((l) => <Level key={'a' + l.price} l={l} side="ask" max={max} />)}</div>
          <div className="mid">
            <b className={t && t.last >= t.open ? 'pos' : 'neg'}>{t ? usd(t.last, 1) : '—'}</b>
            <span>{t ? `${s.spread} ${usd(t.ask - t.bid, 1)}` : ''}</span>
          </div>
          <div className="bids">{bids.map((l) => <Level key={'b' + l.price} l={l} side="bid" max={max} />)}</div>
        </div>
      ) : (
        <div className="book-body">
          <div className="cols three"><span>{s.price}</span><span>{s.size}</span><span>{s.time}</span></div>
          {tape.map((x, i) => (
            <div key={i} className="lvl three">
              <span className={x.buyerIsMaker ? 'neg' : 'pos'}>{usd(x.price, 1)}</span>
              <span>{(x.qty * cex.CONTRACT_BTC).toFixed(3)}</span>
              <span className="muted">{clock(x.t)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Level({ l, side, max }: { l: cex.Level; side: 'bid' | 'ask'; max: number }) {
  return (
    <div className={`lvl ${side}`}>
      <span className="depth" style={{ width: `${(l.qty / max) * 100}%` }} />
      <span className={side === 'bid' ? 'pos' : 'neg'}>{usd(l.price, 1)}</span>
      <span>{(l.qty * cex.CONTRACT_BTC).toFixed(3)}</span>
    </div>
  );
}

function Swaps({ detail }: { detail: PoolDetail | null }) {
  const { t: s } = useT();
  return (
    <section className="panel book">
      <div className="panel-tabs"><span className="tab-label on">{s.recentSwaps}</span></div>
      <div className="book-body">
        <div className="cols four"><span>{s.side}</span><span>{s.price}</span><span>{s.amount}</span><span>{s.when}</span></div>
        {detail?.swaps.slice(0, 12).map((x) => (
          <a key={x.tx + x.block} className="lvl four" href={`${EXPLORER}/tx/${x.tx}`} target="_blank" rel="noreferrer">
            <span className={x.side === 'buy' ? 'pos' : 'neg'}>{x.side === 'buy' ? s.buy : s.sell}</span>
            <span>{fmtPrice(x.price)}</span>
            <span>${usd(x.usdt)}</span>
            <span className="muted">{ago(x.time)}</span>
          </a>
        ))}
        {detail && detail.swaps.length === 0 && <div className="muted pad">{s.noSwaps}</div>}
        {!detail && <div className="muted pad">{s.readingChain}</div>}
      </div>
    </section>
  );
}

/* ---------- page ---------- */

export default function Trade({ quotes, vault }: { quotes: Quote[]; vault: VaultInfo | null }) {
  const { t: s } = useT();
  const [venue, setVenue] = useState<Venue>('cex');
  const [interval, setIv] = useState<cex.Interval>('15m');
  const [asset, setAsset] = useState<Asset>('BTC');
  const c = useCex(interval);
  const d = useDex(asset);

  const chg = c.t ? (c.t.last / c.t.open - 1) * 100 : 0;
  const up = chg >= 0;
  const p = POOLS[asset];
  const vol = d.detail ? d.detail.swaps.reduce((a, x) => a + x.usdt, 0) : 0;
  const line = d.detail ? (() => {
    const pts = [...d.detail.swaps].reverse().map((x) => ({ time: Math.floor(x.time / 1000), value: x.price }));
    pts.push({ time: Math.floor(d.detail.at / 1000), value: d.detail.price });
    const out: { time: number; value: number }[] = [];
    for (const q of pts) { if (out.length && out[out.length - 1].time >= q.time) out[out.length - 1] = { ...q, time: out[out.length - 1].time }; else out.push(q); }
    return out;
  })() : [];
  const dexBtc = asset === 'BTC' ? d.detail?.price : undefined;

  return (
    <div className="trade fade-in">
      <div className="ticker">
        <div className="venue" role="tablist" aria-label="Venue">
          <button role="tab" aria-selected={venue === 'cex'} className={venue === 'cex' ? 'on' : ''} onClick={() => setVenue('cex')}>{s.cex}<small>{s.cexSub}</small></button>
          <button role="tab" aria-selected={venue === 'dex'} className={venue === 'dex' ? 'on' : ''} onClick={() => setVenue('dex')}>{s.dex}<small>{s.dexSub}</small></button>
        </div>
        {venue === 'cex' ? (
          <>
            <div className="sym"><span className="coin coin-btc" /><b>BTCUSDT</b><span className="tag" title={s.tipPerp}>{s.perpetual}</span></div>
            <div className={`last ${up ? 'pos' : 'neg'}`}>{c.t ? usd(c.t.last, 1) : '—'}</div>
            <div className="stats">
              <Stat label={s.change24h} value={c.t ? `${up ? '+' : ''}${chg.toFixed(2)}%` : '—'} cls={up ? 'pos' : 'neg'} />
              <Stat label={s.mark} tip={s.tipMark} value={c.mi ? usd(c.mi.mark, 1) : '—'} />
              <Stat label={s.index} tip={s.tipIndex} value={c.mi ? usd(c.mi.index, 1) : '—'} />
              <Stat label={s.high24h} value={c.t ? usd(c.t.high, 1) : '—'} />
              <Stat label={s.low24h} value={c.t ? usd(c.t.low, 1) : '—'} />
              <Stat label={s.vol24h} value={c.t ? `${compact(c.t.volContracts * cex.CONTRACT_BTC)} BTC` : '—'} />
            </div>
            {c.err && <span className="unavail">{s.feedDown} {c.err}</span>}
          </>
        ) : (
          <>
            <div className="pairs" role="tablist">
              {ASSETS.map((a) => <button key={a} role="tab" aria-selected={a === asset} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}><span className={`coin coin-${a.toLowerCase()}`} />{POOLS[a].symbol}/USDT</button>)}
            </div>
            <div className="last">{d.detail ? fmtPrice(d.detail.price) : '—'}</div>
            <div className="stats">
              <Stat label={s.poolOf(p.symbol)} value={d.detail ? compact(d.detail.reserveBase) : '—'} />
              <Stat label={s.poolUsdt} value={d.detail ? compact(d.detail.reserveUsdt) : '—'} />
              <Stat label={s.swaps24h} value={d.detail ? String(d.detail.swaps.length) : '—'} />
              <Stat label={s.vol24h} value={d.detail ? `$${compact(vol)}` : '—'} />
              <Stat label={s.block} value={d.detail ? d.detail.head.toLocaleString('en-US') : '—'} />
            </div>
            {d.err && <span className="unavail">{d.err}</span>}
          </>
        )}
      </div>

      <div className="trade-grid">
        <div className="col-main">
          <section className="panel chart-panel">
            <div className="panel-tabs">
              {venue === 'cex'
                ? (['1m', '15m', '1h', '4h'] as cex.Interval[]).map((iv) => <button key={iv} className={iv === interval ? 'on' : ''} aria-pressed={iv === interval} onClick={() => setIv(iv)}>{iv}</button>)
                : <span className="tab-label">{s.poolLine} · <a href={`${EXPLORER}/address/${p.pool}`} target="_blank" rel="noreferrer">{p.pool.slice(0, 6)}…{p.pool.slice(-4)}</a></span>}
              <span className="status-dot on push">{s.live}</span>
            </div>
            {venue === 'cex'
              ? (c.candles.length ? <PriceChart key="candles" data={{ kind: 'candles', data: c.candles }} /> : <div className="chart-empty muted">{s.loadingCandles}</div>)
              : (line.length > 1 ? <PriceChart key={'line' + asset} data={{ kind: 'line', data: line }} /> : <div className="chart-empty muted">{d.detail ? s.fewSwaps : s.readingChain}</div>)}
            {venue === 'cex' && (
              <div className="chart-foot split">
                <span>{dexBtc !== undefined && c.t ? s.dexVsPerp(usd(dexBtc, 0), `${dexBtc >= c.t.last ? '+' : ''}${((dexBtc / c.t.last - 1) * 100).toFixed(2)}%`) : ''}</span>
                <button className="bridge" onClick={() => { setAsset('HSK'); setVenue('dex'); }} title={s.bridgeTip}><MoaGlyph size={14} />{s.bridge} →</button>
              </div>
            )}
            {venue === 'dex' && d.detail && d.detail.swaps.length < 6 && <div className="chart-foot">{s.fewSwapsNote(d.detail.swaps.length)}</div>}
          </section>
          <SpreadTable quotes={quotes} onPick={(a) => { setAsset(a); setVenue('dex'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
        </div>
        <div className="col-side">
          <VaultPanel vault={vault} />
          {venue === 'cex' ? <OrderBook book={c.book} t={c.t} tape={c.tape} /> : <Swaps detail={d.detail} />}
        </div>
      </div>
      <p className="data-note">{s.dataNote}</p>
    </div>
  );
}
