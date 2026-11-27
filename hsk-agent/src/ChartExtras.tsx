// What sits around the price chart besides candles and indicators:
//  - on the exchange chart, a "Heatmap" switch that shows nanotradingclub's own fire chart in place of Moa's chart:
//    its order-book heatmap, liquidation map and liquidations, drawn by its own code. Nothing of it loads until the
//    switch is on, and only where nanotradingclub lets this Moa show it (server/nanoFrame.ts reads its headers);
//  - on the HSKSwap chart, the pool's liquidity read from the chain, as columns of blocks above the chart.
import { useEffect, useState } from 'react';
import { useT } from './i18n.ts';
import type { Asset } from './intent.ts';
import type { Interval } from './cex.ts';
import { poolState } from './dex.ts';
import { poolDepth, type PoolDepth } from './depth.ts';
import { NANO_REFRESH_MS } from './nano.ts';

/* ---------- the exchange chart: nanotradingclub's fire chart ---------- */

const NANO_FIRE = 'https://nanotradingclub.xyz/fire';
const NANO_CDN = 'https://cdn.nanotradingclub.xyz';
/** nanotradingclub's intervals are 1m, 10m, 30m, 1h, 4h, 1d and 7d; Moa's 15m opens as its 10m. */
const NANO_TF: Record<Interval, string> = { '1m': '1m', '15m': '10m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '7d' };
export const nanoChartUrl = (base: string, interval: Interval, embed = true) =>
  `${NANO_FIRE}?${embed ? 'embed=1&' : ''}sym=${encodeURIComponent(base.toUpperCase())}USDT&tf=${NANO_TF[interval]}`;

export type NanoState = 'off' | 'checking' | 'on' | 'refused' | 'unreachable' | 'nocoin';
let frameKept: { at: number; v: { allowed: boolean; why?: string } } | null = null;
const coinKept = new Map<string, boolean>();

/** Whether nanotradingclub's chart can be shown for this coin, asked only once the switch is on. */
export function useNanoChart(on: boolean, base: string): NanoState {
  const [st, setSt] = useState<{ key: string; v: NanoState }>({ key: '', v: 'off' });
  const key = `${on}|${base}`;
  useEffect(() => {
    if (!on) { setSt({ key, v: 'off' }); return; }
    let alive = true;
    setSt({ key, v: 'checking' });
    const frame = frameKept && Date.now() - frameKept.at < 300_000 ? Promise.resolve(frameKept.v)
      : fetch('/api/nano-frame').then((r) => r.json() as Promise<{ allowed: boolean; why?: string }>).then((v) => { frameKept = { at: Date.now(), v }; return v; });
    // A coin nanotradingclub collects has its book on the CDN (HSK has none).
    const sym = `${base.toUpperCase()}USDT`;
    const coin = coinKept.has(sym) ? Promise.resolve(coinKept.get(sym)!)
      : fetch(`${NANO_CDN}/fire_latest_${sym}.json`, { method: 'HEAD' }).then((r) => { coinKept.set(sym, r.ok); return r.ok; });
    Promise.all([frame, coin]).then(([f, c]) => {
      if (!alive) return;
      setSt({ key, v: !c ? 'nocoin' : f.allowed ? 'on' : f.why === 'unreachable' ? 'unreachable' : 'refused' });
    }).catch(() => { if (alive) setSt({ key, v: 'unreachable' }); });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return st.key === key ? st.v : on ? 'checking' : 'off';
}

/** The "Heatmap" switch next to Indicators. */
export function HeatSwitch({ on, state, toggle }: { on: boolean; state: NanoState; toggle: () => void }) {
  const { t } = useT();
  return (
    <button className={`ind-btn heat-switch${on ? ' lit' : ''}`} aria-pressed={on} onClick={toggle} data-tip={t.nanoTip}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor" opacity=".35" /><rect x="9" y="2" width="5" height="5" rx="1" fill="currentColor" opacity=".7" /><rect x="2" y="9" width="5" height="5" rx="1" fill="currentColor" /><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor" opacity=".5" /></svg>
      {t.heatBtn}{state === 'checking' && <span className="spin" aria-hidden />}
    </button>
  );
}

/** nanotradingclub's chart where Moa's was, or why it cannot be shown. */
export function NanoChart({ base, interval, state }: { base: string; interval: Interval; state: NanoState }) {
  const { t } = useT();
  const open = <a href={nanoChartUrl(base, interval, false)} target="_blank" rel="noreferrer">{t.nanoOpen} ↗</a>;
  if (state === 'on') return (
    <div className="nano-wrap">
      <iframe key={`${base}-${interval}`} className="nano-frame" src={nanoChartUrl(base, interval)} title={t.nanoTitle(base)} allow="clipboard-write" />
    </div>
  );
  return (
    <div className="chart-empty nano-note">
      {state === 'checking' ? <><span className="spin" aria-hidden />{t.nanoChecking}</> : (
        <div><b>{state === 'nocoin' ? t.nanoNoCoin(base) : state === 'refused' ? t.nanoRefused : t.nanoDown}</b><p>{state === 'nocoin' ? t.nanoNoCoinSub : t.nanoRefusedSub}</p>{state !== 'nocoin' && open}</div>
      )}
    </div>
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

const ROWS = 8;
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
