// The spread panel under the chart (both CEX and HSKSwap views): the gap between HSKSwap and HashKey Global now,
// what is left of it after costs at three sizes, the recorded gap history with the cost band shaded, and the spread
// hunter, the one way a vault can act on it. Every number is read or recorded; nothing is filled in.
import { useEffect, useMemo, useState } from 'react';
import type { Agent } from './agents.ts';
import type { Asset } from './intent.ts';
import { useT } from './i18n.ts';
import { Face } from './AgentCard.tsx';
import { costBand, gapHistory, gapOf, gapStats, hunterAgent, hunterRun, hunterState, KEEP_DAYS, lastOf, liveSpread, POOL_FEE, TAKER_FEE, type GapPoint, type Spread } from './spread.ts';

const pc = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(d)}%`;
const usd = (v: number) => (v >= 1_000_000 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v).toLocaleString('en-US')}`);

/** The gap over time against the cost band: inside the band acting does not pay, outside it does (at $100). */
function GapChart({ pts, from, to }: { pts: GapPoint[]; from: number; to: number }) {
  const { t } = useT();
  const W = 600, H = 132, P = 6;
  const rows = pts.map((p) => ({ t: p.t, g: gapOf(p)!, band: costBand(p) })).filter((r) => r.g !== undefined);
  if (rows.length < 2) return null;
  const lo = Math.min(...rows.map((r) => Math.min(r.g, r.band[0]))), hi = Math.max(...rows.map((r) => Math.max(r.g, r.band[1])));
  const pad = (hi - lo) * 0.12 || 0.001, y0 = lo - pad, y1 = hi + pad;
  const x = (tt: number) => ((tt - from) / (to - from || 1)) * W;
  const y = (v: number) => P + (1 - (v - y0) / (y1 - y0)) * (H - 2 * P);
  const band = `${rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(r.band[1]).toFixed(1)}`).join('')}${[...rows].reverse().map((r) => `L${x(r.t).toFixed(1)},${y(r.band[0]).toFixed(1)}`).join('')}Z`;
  const line = rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(r.g).toFixed(1)}`).join('');
  const out = rows.filter((r) => r.g < r.band[0] || r.g > r.band[1]);
  return (
    <div className="sx-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t.sxHistory}>
        <path d={band} className="sx-band" />
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="sx-zero" vectorEffect="non-scaling-stroke" />
        <path d={line} className="sx-line" fill="none" vectorEffect="non-scaling-stroke" />
        {out.map((r) => <circle key={r.t} cx={x(r.t)} cy={y(r.g)} r="2.6" className={r.g < 0 ? 'sx-dot cheap' : 'sx-dot dear'} vectorEffect="non-scaling-stroke" />)}
      </svg>
      <span className="sx-axis top">{pc(y1, 1)}</span>
      <span className="sx-axis zero" style={{ top: `${(y(0) / H) * 100}%` }}>0%</span>
      <span className="sx-axis bottom">{pc(y0, 1)}</span>
    </div>
  );
}

export default function SpreadPanel({ asset, onHire }: { asset: Asset; onHire: (a: Agent) => void }) {
  const { t } = useT();
  const [now, setNow] = useState<Spread | null | 'loading'>('loading');
  const [hist, setHist] = useState<GapPoint[] | null | 'error'>(null);
  const [days, setDays] = useState<1 | 7>(1);
  useEffect(() => {
    let alive = true;
    setNow('loading'); setHist(null);
    const read = () => liveSpread(asset).then((s) => alive && setNow(s), () => alive && setNow(null));
    const load = () => gapHistory(asset, KEEP_DAYS).then((xs) => alive && setHist(xs), () => alive && setHist('error'));
    void read(); void load();
    const a = setInterval(read, 60_000), b = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, [asset]);

  const all = Array.isArray(hist) ? hist : [];
  const shown = useMemo(() => lastOf(all, days * 86_400_000), [all, days]);
  const stats = useMemo(() => gapStats(shown), [shown]);
  const hunter = useMemo(() => hunterAgent(asset, all), [asset, all]);
  const run = useMemo(() => hunterRun(all), [all]);
  const hs = hunterState(all);
  // The time axis covers what was recorded inside the window: with only an hour of records the hour fills the chart.
  const to = Date.now(), from = Math.max(to - days * 86_400_000, shown[0]?.t ?? 0);
  const span = (ms: number) => (ms >= 86_400_000 ? t.sxDaysN(Math.floor(ms / 86_400_000)) : ms >= 3_600_000 ? t.sxHoursN(Math.floor(ms / 3_600_000)) : t.sxMinsN(Math.max(0, Math.floor(ms / 60_000))));
  const s = now === 'loading' ? null : now;
  // "Yes" only for a trade the vault can make: a discount bigger than a round trip, on a pool that has closed one before.
  const vaultYes = !!s && s.vaultNet !== undefined && s.vaultNet > 0 && run.reverted;

  return (
    <div className="sx">
      <section className="sx-now" aria-label={t.sxNow}>
        <small>{t.sxNow}{s ? ` · ${t.sxVs(s.venue)}` : ''}</small>
        {now === 'loading' ? <div className="skel" style={{ height: 40, width: '70%' }} /> : !s ? <p className="sx-none">{t.sxUnavailable}</p> : <>
          <b className={s.gap < 0 ? 'cheap' : 'dear'}>{pc(s.gap)}</b>
          <span className="sx-side">{s.gap < 0 ? t.sxCheap : t.sxDear}</span>
          {/* What the vault itself can do: it trades only on HSKSwap. */}
          <div className={`sx-vault${vaultYes ? ' yes' : ''}`}>
            <span className="sx-net-head">{t.sxVault}</span>
            {s.side === 'poolCheap' && s.vaultNet !== undefined ? <>
              <span className="sx-vault-row"><em>{t.sxRoundTrip}</em><b>{pc(-(s.roundTrip ?? 0))}</b></span>
              <span className="sx-vault-row"><em>{t.sxIfCloses}</em><b className={s.vaultNet > 0 ? 'pos' : 'neg'}>{pc(s.vaultNet)}</b></span>
              <p>{vaultYes ? t.sxVaultYes : s.vaultNet <= 0 ? t.sxVaultSmall : t.sxVaultNoRecord}</p>
            </> : <p>{s.side === 'poolDear' ? t.sxVaultDear : t.sxNoDepth}</p>}
          </div>
          <div className="sx-net">
            <span className="sx-net-head">{t.sxNet}</span>
            {s.sizes.map((z) => (
              <span key={z.usd} className="sx-net-row">
                <em>{usd(z.usd)}</em>
                <b className={Number.isNaN(z.net) ? '' : z.net > 0 ? 'pos' : 'neg'}>{Number.isNaN(z.net) ? '—' : pc(z.net)}</b>
              </span>
            ))}
          </div>
          <p className="sx-verdict">{s.breakEven === undefined ? t.sxNoDepth : s.breakEven > 0 ? t.sxBreak(usd(s.breakEven)) : t.sxNoBreak}</p>
        </>}
        <p className="sx-costs tip-tap" tabIndex={0} data-tip={t.sxNotCounted}>{t.sxCosts(`${(POOL_FEE * 100).toFixed(1)}%`, `${(TAKER_FEE * 100).toFixed(1)}%`)}<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7.2v3.6M8 5.2v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></p>
      </section>

      <section className="sx-hist" aria-label={t.sxHistory}>
        <header>
          <b>{t.sxHistory}</b>
          <span className="sx-legend"><i className="band" />{t.sxBand}</span>
          <div className="seg" role="group" aria-label={t.sxHistory}>
            {([1, 7] as const).map((d) => <button key={d} className={days === d ? 'on' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>{d === 1 ? t.sxDay : t.sxWeek}</button>)}
          </div>
        </header>
        {hist === null ? <div className="skel-block" style={{ height: 132 }} />
          : hist === 'error' ? <p className="sx-none">{t.sxHistErr}</p>
          : shown.length < 2 ? <p className="sx-none">{shown.length ? t.sxFew(shown.length) : t.sxNoRecords}</p>
          : <GapChart pts={shown} from={from} to={to} />}
        {shown.length >= 2 && <p className="sx-hist-foot">{t.sxOutside(stats.outside, stats.n)} · {t.sxEvery}</p>}
      </section>

      <section className="sx-hunter" aria-label={t.agNick.spread}>
        <div className="sx-hunter-who">
          <Face rule="spread" base={asset} size="lg" />
          <span><b>{asset} {t.agNick.spread}</b><small>{t.agPlain.spread}</small></span>
        </div>
        {hs.building
          ? <p className="sx-building"><i aria-hidden />{t.sxBuilding(span(hs.spanMs))}</p>
          : <p className="sx-result"><small>{t.mpVsHold} · {t.sxRecorded(span(hunter.days * 86_400_000))}</small><b className={hunter.total - hunter.hold >= 0 ? 'pos' : 'neg'}>{pc(hunter.total - hunter.hold, 1)}</b><span>{t.sxTrades(hunter.trades)}</span></p>}
        {!hs.building && <p className="sx-state">{hunter.live ? t.frHolding : run.reverted ? t.sxWaiting : t.sxNoRevert}</p>}
        <p className="sx-rules">{t.sxExit}</p>
        {/* Hireable only once there is a past result to judge it by. */}
        {hunter.runnable && <button className="btn-primary sx-hire" onClick={() => onHire(hunter)}>{t.acHire}</button>}
        <p className="sx-act">{t.sxAct}</p>
      </section>
    </div>
  );
}
