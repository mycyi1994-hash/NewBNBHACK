// What sits around the price chart besides candles and indicators:
//  - on the exchange chart, a "Heatmap" button that lays nanotradingclub's order-book heatmap and liquidations
//    over the chart. Nothing is fetched until a layer is switched on;
//  - on the HSKSwap chart, the pool's depth read from the chain, as blocks above the chart.
import { useEffect, useRef, useState } from 'react';
import { useT } from './i18n.ts';
import type { Asset } from './intent.ts';
import { poolState } from './dex.ts';
import { poolDepth, type PoolDepth } from './depth.ts';
import { heatHistory, heatRefresh, liquidations, openInterest, NoData, NANO_REFRESH_MS, type HeatColumn, type Liq } from './nano.ts';

export type LayerState = 'off' | 'loading' | 'on' | 'none' | 'error';
export interface Layer<T> { data: T | null; state: LayerState }

/**
 * Something fetched only while it is switched on, then again every three minutes while the tab is in front.
 * Switching off, or changing what it is for, drops what was fetched.
 */
function useLayer<T>(on: boolean, key: string, first: () => Promise<T>, next: (have: T) => Promise<T>): Layer<T> {
  const [got, setGot] = useState<{ key: string; data: T | null; state: LayerState }>({ key, data: null, state: 'off' });
  const fns = useRef({ first, next }); fns.current = { first, next };
  useEffect(() => {
    if (!on) { setGot({ key, data: null, state: 'off' }); return; }
    let alive = true, have: T | null = null, at = 0, busy = false;
    setGot({ key, data: null, state: 'loading' });
    const pull = async () => {
      if (busy) return;
      busy = true;
      try {
        have = have === null ? await fns.current.first() : await fns.current.next(have);
        at = Date.now();
        if (alive) setGot({ key, data: have, state: 'on' });
      } catch (e) {
        // A refresh that fails keeps what is on screen; only a first load that fails says so.
        if (alive && have === null) setGot({ key, data: null, state: e instanceof NoData ? 'none' : 'error' });
      } finally { busy = false; }
    };
    void pull();
    const timer = setInterval(() => { if (!document.hidden) void pull(); }, NANO_REFRESH_MS);
    const back = () => { if (!document.hidden && Date.now() - at >= NANO_REFRESH_MS) void pull(); };
    document.addEventListener('visibilitychange', back);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', back); };
  }, [on, key]);
  return got.key === key ? got : { data: null, state: on ? 'loading' : 'off' };
}

export type HeatKind = 'book' | 'map' | 'liq';
/** The three layers for one coin. `want` is what the user switched on. `map` holds the open interest the estimate is built from. */
export function useHeat(base: string, want: Set<HeatKind>): { book: Layer<HeatColumn[]>; liq: Layer<Liq[]>; map: Layer<number> } {
  const book = useLayer<HeatColumn[]>(want.has('book'), `book-${base}`, () => heatHistory(base), (have) => heatRefresh(base, have));
  const liq = useLayer<Liq[]>(want.has('liq'), `liq-${base}`, () => liquidations(base), () => liquidations(base));
  const map = useLayer<number>(want.has('map'), `map-${base}`, () => openInterest(base), () => openInterest(base));
  return { book, liq, map };
}

/** The "Heatmap" button next to Indicators. */
export function HeatMenu({ want, toggle, book, liq, map }: { want: Set<HeatKind>; toggle: (k: HeatKind) => void; book: LayerState; liq: LayerState; map: LayerState }) {
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
  const note = (st: LayerState, text: string) => (st === 'loading' ? t.heatLoading : st === 'none' ? t.heatNone : st === 'error' ? t.heatErr : text);
  const item = (k: HeatKind, st: LayerState, words: readonly [string, string]) => (
    <label key={k} className={`ind-item${st === 'none' || st === 'error' ? ' bad' : ''}`} role="menuitemcheckbox" aria-checked={want.has(k)}>
      <input type="checkbox" checked={want.has(k)} onChange={() => toggle(k)} />
      <span><b>{words[0]}</b><small>{note(st, words[1])}</small></span>
    </label>
  );
  const all = [book, map, liq], shown = all.filter((x) => x === 'on').length, busy = all.includes('loading');
  return (
    <div className="ind-menu heat-menu" ref={ref}>
      <button className={`ind-btn${open ? ' on' : ''}${want.size ? ' lit' : ''}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor" opacity=".35" /><rect x="9" y="2" width="5" height="5" rx="1" fill="currentColor" opacity=".7" /><rect x="2" y="9" width="5" height="5" rx="1" fill="currentColor" /><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor" opacity=".5" /></svg>
        {t.heatBtn}{busy ? <span className="spin" aria-hidden /> : shown > 0 && <span className="ind-count">{shown}</span>}
      </button>
      {open && (
        <div className="ind-pop heat-pop" role="menu">
          {item('book', book, t.heatBook)}
          {item('map', map, t.heatMap)}
          {item('liq', liq, t.heatLiq)}
          <p className="heat-src">{t.heatSrc}</p>
        </div>
      )}
    </div>
  );
}

/** The key under the toolbar while a layer is on: what the colours and circles mean. */
export function HeatLegend({ book, liq, map }: { book: boolean; liq: boolean; map: boolean }) {
  const { t } = useT();
  if (!book && !liq && !map) return null;
  return (
    <span className="heat-legend">
      {book && <span><i className="hl-ramp" aria-hidden />{t.heatKeyBook}</span>}
      {map && <span data-tip={t.heatMapTip}><i className="hl-map" aria-hidden />{t.heatKeyMap}</span>}
      {liq && <span><i className="hl-dot long" aria-hidden />{t.heatKeyLong}<i className="hl-dot short" aria-hidden />{t.heatKeyShort}</span>}
    </span>
  );
}

/* ---------- HSKSwap: the pool's depth ---------- */

const money = (v: number) => (v >= 10_000 ? `$${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K` : `$${Math.round(v).toLocaleString('en-US')}`);
const movePct = (v: number) => (!Number.isFinite(v) ? '—' : `+${(v * 100).toFixed(v < 0.001 ? 3 : 2)}%`);

export function usePoolDepth(asset: Asset): PoolDepth | 'error' | null {
  const [got, setGot] = useState<{ asset: Asset; d: PoolDepth | 'error' } | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => poolState(asset).then((s) => { if (alive) setGot({ asset, d: poolDepth(s) }); }).catch(() => { if (alive) setGot((had) => (had?.asset === asset && had.d !== 'error' ? had : { asset, d: 'error' })); });
    void pull();
    const timer = setInterval(() => { if (!document.hidden) void pull(); }, NANO_REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [asset]);
  return got?.asset === asset ? got.d : null;
}

const ROWS = 6;
const priceText = (v: number) => (v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(4)}`);

/**
 * Above the HSKSwap chart: what the pool holds at each price, as columns of blocks. Under the price now it is USDT,
 * over it the coin. A column is as tall as its share of the thickest one.
 */
export function PoolRange({ asset, symbol, price }: { asset: Asset; symbol: string; price?: number }) {
  const { t } = useT();
  const d = usePoolDepth(asset);
  if (d === 'error') return <div className="pr bad">{t.lpErr}</div>;
  const bins = d?.range ?? [], max = bins.reduce((m, b) => Math.max(m, b.usd), 0);
  const half = bins.length / 2;
  const column = (b: (typeof bins)[number], i: number) => {
    const filled = b.usd > 0 && max > 0 ? Math.max(1, Math.round((b.usd / max) * ROWS)) : 0;
    const tip = price !== undefined ? `${priceText(price * b.from)} – ${priceText(price * b.to)} · ${money(b.usd)}` : money(b.usd);
    return <span key={i} className={`pr-col pr-${b.side}`} data-tip={tip}>{Array.from({ length: ROWS }, (_, r) => <i key={r} className={r >= ROWS - filled ? 'on' : ''} />)}</span>;
  };
  const hundred = d?.impact.find((x) => x.usd === 100), thousand = d?.impact.find((x) => x.usd === 1000);
  const reach = bins.length ? 1 - bins[0].from : 0.05;
  return (
    <div className="pr" role="group" aria-label={t.lpTitle}>
      <div className="pr-head">
        <span className="pr-title"><b data-tip={t.prTip}>{t.lpTitle}</b><span className="pr-key"><span><i className="pr-usdt" aria-hidden />USDT</span><span><i className="pr-coin" aria-hidden />{symbol}</span></span></span>
        <span className="pr-now">{price !== undefined ? t.prNow(priceText(price)) : '—'}</span>
        <span className="lp-impact">{hundred && <span>{t.lpImpact('100', movePct(hundred.pct))}</span>}{thousand && <span className="more"><i aria-hidden>·</i>{t.lpImpact('1,000', movePct(thousand.pct))}</span>}</span>
      </div>
      <div className={`pr-cols${d ? '' : ' wait'}`} style={{ '--side': half || 10 } as React.CSSProperties}>
        {d ? <>{bins.slice(0, half).map(column)}<span className="pr-mid" aria-hidden />{bins.slice(half).map((b, i) => column(b, half + i))}</>
          : <>{Array.from({ length: 10 }, (_, i) => <span key={i} className="pr-col pr-usdt">{Array.from({ length: ROWS }, (_, r) => <i key={r} />)}</span>)}<span className="pr-mid" aria-hidden />{Array.from({ length: 10 }, (_, i) => <span key={i} className="pr-col pr-coin">{Array.from({ length: ROWS }, (_, r) => <i key={r} />)}</span>)}</>}
      </div>
      {price !== undefined && (
        <div className="pr-axis" aria-hidden>
          {[1 - reach, 1 - reach / 2, 1, 1 + reach / 2, 1 + reach].map((m) => <span key={m}>{priceText(price * m)}</span>)}
        </div>
      )}
    </div>
  );
}
