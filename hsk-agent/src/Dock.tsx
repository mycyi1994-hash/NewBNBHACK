// The panel under the chart. One screen does the whole job:
//  - "Agents for this market": the agents from agents.ts for the market on the chart (same numbers as the agent
//    market and Moa's cards), ranked. The default order is Moa's own: published classics first, then the smaller
//    worst drop. Picking one does not move money; it opens its backtest right here.
//  - "Backtest": what that agent would have done: the result against just holding, its curve among the others,
//    and every buy and sell (the chart above shows the same buys and sells on the candles). One year by default,
//    so agents compare like for like; "All history" reruns it over everything the exchange has.
//  - "Recent swaps" (HSKSwap view only).
// Hiring happens from the backtest, after the evidence, through the same hire sheet as everywhere else.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Asset } from './intent.ts';
import type * as cex from './cex.ts';
import { SENSITIVITY_USD } from './fills.ts';
import { marketAgents } from './agentsClient.ts';
import { holdoutDays, POSITION_RULES, isRetired, pickDays, byMerit, DEMOTED, rescoreAt, horizonOf, idle, isRunnable, rescore, HORIZONS, PROOF, type Agent, type Horizon, type Mark } from './agents.ts';
import { TEMPLATES } from './spec.ts';
import { useMade } from './madeStore.ts';
import { AgentCard, agentName, condText, drop, pct, ruleLines, statePill, Face } from './AgentCard.tsx';
import { LP_STRATEGIES, type LpStrategy } from './lpStrategies.ts';
import type { IconName } from './Icons.tsx';
import { fmtPrice } from './market.ts';
import { useT } from './i18n.ts';
import { Icon, Spark } from './Icons.tsx';
import { SlidePill } from './motion.tsx';
import { StateBox } from './ui.tsx';
import SpreadPanel from './SpreadPanel.tsx';
import { AgentRow, AsOf, byTier, FOLDED, HoldRow, PERIODS, PeriodSwitch, periodResult, usePeriod, verdictOf, VERDICT_MARK, type PeriodDays } from './Perf.tsx';
import OnchainPanel from './OnchainPanel.tsx';
import { ASSETS } from './intent.ts';
import { feeText } from './share.ts';
import { whoText } from './Shared.tsx';

/** Price with sensible decimals for anything from BTC to DOGE. */
export const px = (v: number) => (v >= 1000 ? v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  : v >= 1 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : fmtPrice(v));

/** The agents for the market on the chart: the strategies that follow a signal, the user's own, and on the HSKSwap tab the ones that buy on a schedule. */
export function useMarketAgents(venue: 'cex' | 'dex', market: cex.Market, asset: Asset) {
  const [list, setList] = useState<Agent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [again, setAgain] = useState(0);
  /** When the list was scored (ms): shown as "5분 전 기준". */
  const [listAt, setListAt] = useState<number | null>(null);
  const mine = useMade();
  useEffect(() => {
    let alive = true;
    setList(null); setFailed(false);
    // The market's own agents, then the ones the user made for it. On the HSKSwap tab the same strategies are
    // listed (their signals come from the exchange's daily candles; the trades happen on HSKSwap), plus the agents
    // that buy on a schedule, which only exist there.
    // From the server's cache in one request (scored every ~5 minutes; `at` says when), else scored here (agentsClient.ts).
    marketAgents(venue, market, asset).then((x) => { if (alive) { setList(x.list); setListAt(x.at); } }, () => alive && setFailed(true));
    return () => { alive = false; };
  }, [venue, market.symbol, asset, again, mine]); // eslint-disable-line react-hooks/exhaustive-deps
  return { list, failed, at: listAt, retry: () => setAgain((n) => n + 1) };
}

export type Period = 'year' | 'std' | 'all';
/** The backtest on screen: the standard three years from the list, or the same agent over one year or all its history. */
export function useBacktest(sel: Agent | null) {
  const [period, setPeriod] = useState<Period>('std');
  // A short-term agent has no separate one-year view: its own window is the standard one.
  useEffect(() => { if (sel?.interval && period === 'year') setPeriod('std'); }, [sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [other, setOther] = useState<{ agent: Agent; period: Period } | null>(null);
  useEffect(() => {
    setOther(null);
    if (!sel || period === 'std') return;
    let alive = true;
    rescore(sel, period === 'year' ? 365 : Infinity).then((a: Agent | null) => { if (alive && a) setOther({ agent: a, period }); }, () => undefined);
    return () => { alive = false; };
  }, [sel?.id, period]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = !!sel && period !== 'std' && other?.period === period && other.agent.id === sel.id;
  // While another period is being scored the standard one stays on screen, with a small "working" mark.
  return { period, setPeriod, shown: ready ? other!.agent : sel, busy: !!sel && period !== 'std' && !ready };
}

/** Round trips of a position agent, newest first. The last one may still be open (valued at the last close). */
export interface Trip { buy: Mark; sell?: Mark; ret: number }
export function trips(a: Agent): Trip[] {
  const out: Trip[] = [];
  let open: Mark | null = null;
  for (const m of a.marks) {
    if (m.resize) continue;   // a weight agent resizing inside a round trip
    if (m.side === 'buy') open = m;
    else if (open) { out.push({ buy: open, sell: m, ret: m.ret ?? m.price / open.price - 1 }); open = null; }
  }
  if (open) out.push({ buy: open, ret: (a.price / open.price) * (1 - a.fee) - 1 });
  return out.reverse();
}


/* ---------- money: "if you had put in this much" ---------- */

/** The amounts offered, per language (won in Korean, dollars in English). The choice is kept in this browser. */
const AMOUNTS = { ko: [1_000_000, 5_000_000, 10_000_000, 100_000_000], en: [1_000, 5_000, 10_000, 100_000] } as const;
function usePrincipal(lang: 'ko' | 'en') {
  const [at, setAt] = useState(() => { try { const v = Number(localStorage.getItem('moa.principal') ?? 0); return v >= 0 && v < 4 ? Math.floor(v) : 0; } catch { return 0; } });
  const pick = (n: number) => { setAt(n); try { localStorage.setItem('moa.principal', String(n)); } catch { /* storage unavailable */ } };
  return { at, pick, amount: AMOUNTS[lang][at], list: AMOUNTS[lang] };
}
/** 1,829,000 → "182.9만원" (or "1.83억원"); in English "$1,829". `short` is for the chart's axis. */
export function moneyText(lang: 'ko' | 'en', v: number, short = false): string {
  if (lang === 'en') return short ? `$${v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}` : `$${Math.round(v).toLocaleString('en-US')}`;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: short ? 1 : 2 })}억${short ? '' : '원'}`;
  const man = v / 1e4;
  return `${man.toLocaleString('ko-KR', { maximumFractionDigits: short || Math.abs(man) >= 1000 ? 0 : 1 })}만${short ? '' : '원'}`;
}

/** Where the backtest stands on a day (the replay's cursor), or at its end: the agent's value and holding's, as multiples of the start. */
export function standing(a: Agent, cursor: number | null) {
  const last = a.equity.length - 1;
  if (last < 0) return { eq: 1, hold: 1 };
  if (cursor === null) return { eq: a.equity[last].value, hold: a.bench[Math.min(last, a.bench.length - 1)]?.value ?? 1 };
  let k = -1;
  for (let i = 0; i <= last && a.equity[i].time <= cursor; i++) k = i;
  return k < 0 ? { eq: 1, hold: 1 } : { eq: a.equity[k].value, hold: a.bench[Math.min(k, a.bench.length - 1)]?.value ?? 1 };
}

/* ---------- character: what kind of strategy this is, read off its own backtest ---------- */

/** Risk by the worst drop, frequency by trades a year, holding by days in the coin. The cut-offs are shown in the tags' tooltip. */
export function profile(a: Agent) {
  const perYear = (a.target !== undefined ? a.moves ?? a.trades : a.trades) / Math.max(1, a.days / 365);
  return {
    perYear,
    risk: (a.maxDd >= 0.45 ? 'hi' : a.maxDd >= 0.25 ? 'mid' : 'lo') as 'hi' | 'mid' | 'lo',
    freq: (a.kind === 'collect' && perYear >= 200 ? 'daily' : perYear >= 12 ? 'often' : perYear >= 3 ? 'some' : 'rare') as 'daily' | 'often' | 'some' | 'rare',
    hold: ((a.exposure ?? a.inMarket) >= 0.7 ? 'most' : (a.exposure ?? a.inMarket) >= 0.3 ? 'half' : 'cash') as 'most' | 'half' | 'cash',
  };
}

/**
 * The agent's curve against just holding, in money, with the market's other agents faint behind it (tap one to
 * open it). During a replay only the days up to the cursor are drawn, on the full backtest's scale.
 */
function Curves({ a, peers, upto, label, onPick }: { a: Agent; peers: Agent[]; upto: number | null; label: (mult: number) => string; onPick: (p: Agent) => void }) {
  const W = 400, H = 100;
  if (a.equity.length < 2) return null;
  const t0 = a.equity[0].time, t1 = a.equity[a.equity.length - 1].time;
  // Peers are drawn over the same days, rebased to 1 where this agent's window starts.
  const others = (upto === null ? peers : []).map((p) => {
    const pts = p.equity.filter((x) => x.time >= t0 && x.time <= t1);
    const base = pts[0]?.value || 1;
    return { p, pts: pts.map((x) => ({ time: x.time, value: x.value / base })) };
  }).filter((o) => o.pts.length > 1);
  const all = [...a.equity, ...a.bench, ...others.flatMap((o) => o.pts)];
  const lo = Math.min(1, ...all.map((p) => p.value)), hi = Math.max(1, ...all.map((p) => p.value)), span = hi - lo || 1;
  const yOf = (v: number) => H - 3 - ((v - lo) / span) * (H - 6);
  const d = (pts: { time: number; value: number }[]) => pts.filter((p) => upto === null || p.time <= upto).map((p, i) => `${i ? 'L' : 'M'}${(((p.time - t0) / (t1 - t0 || 1)) * W).toFixed(1)},${yOf(p.value).toFixed(1)}`).join('');
  const base = yOf(1);
  // Three amounts on the side: the most it was worth, what was put in, the least.
  const marks = [hi, 1, lo].filter((v, i, xs) => i === 1 ? Math.abs(yOf(1) - yOf(hi)) > 16 && Math.abs(yOf(1) - yOf(lo)) > 16 : xs.indexOf(v) === i);
  return (
    <div className="bt-curve-wrap" key={`${a.id}-${a.days}`}>
      <svg className="bt-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <line x1="0" x2={W} y1={base} y2={base} className="bt-zero" vectorEffect="non-scaling-stroke" />
        {others.map((o) => (
          <g key={o.p.id} className="bt-peer" onClick={() => onPick(o.p)}>
            <path d={d(o.pts)} className="bt-peer-hit" fill="none" vectorEffect="non-scaling-stroke" />
            <path d={d(o.pts)} className="bt-peer-line" fill="none" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        <path d={d(a.bench)} className="bt-hold" fill="none" vectorEffect="non-scaling-stroke" />
        <path d={d(a.equity)} className="bt-agent" fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      {marks.map((v) => <span key={v} className={`bt-axis${v === 1 ? ' start' : ''}`} style={{ top: `${(yOf(v) / H) * 100}%` }}>{label(v)}</span>)}
    </div>
  );
}

/**
 * The two things a backtest has to say out loud: how its trades were filled (fills.ts) and how it did on the part of
 * its history no setting was chosen on (the out-of-sample split in agents.ts).
 */
function Honesty({ a, pool }: { a: Agent; pool: number }) {
  const { t } = useT();
  const f = a.fill, s = a.split;
  // The same backtest with bigger trades: only price impact changes, so a thin pool's cost at size shows.
  const [big, setBig] = useState<{ usd: number; a: Agent }[] | null>(null);
  useEffect(() => {
    let alive = true;
    setBig(null);
    if (!f || f.source === 'exchange') return;
    Promise.all(SENSITIVITY_USD.map((usd: number) => rescoreAt(a, usd).then((x) => (x ? { usd, a: x } : null)))).then((xs) => alive && setBig(xs.filter((x): x is { usd: number; a: Agent } => !!x)), () => undefined);
    return () => { alive = false; };
  }, [a.id, a.days]); // eslint-disable-line react-hooks/exhaustive-deps
  const p1 = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;
  const day = 86_400;
  const earlyDays = s ? Math.round((s.at - a.from) / day) : 0, pDays = pickDays(a), hDays = holdoutDays(a);
  const row = (label: string, x: { total: number; hold: number }, cls = '') => <div className={cls}><dt>{label}</dt><dd className={sign(x.total - x.hold)}>{pct(x.total - x.hold)}</dd></div>;
  const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  return (
    <div className="bt-honest">
      {s && (
        <div className="bh-oos">
          <b>{t.hoHead}</b>
          <dl className="three">
            {row(t.hoEarly(t.oosSpan(earlyDays)), s.early)}
            {row(t.hoPick(t.oosSpan(pDays), t.oosSpan(hDays)), s.pick, 'pick')}
            {row(t.hoHold(t.oosSpan(hDays)), s.holdout, 'oos')}
          </dl>
          <p>{t.hoBestOf(pool)}</p>
          <p>{a.made ? t.oosMade : t.oosPublished}</p>
        </div>
      )}
      {f && (
        <div className="bh-fill">
          <b>{t.fillHead}</b>
          <p>{f.source === 'exchange' ? t.fillExchange(p1(f.fee)) : f.source === 'haircut' ? t.fillHaircut(p1(f.fee), p1(f.slip)) : t.fillPool(p1(f.fee), p1(f.slip), p1(f.impactPct), `$${f.amountUsd.toLocaleString('en-US')}`)}</p>
          {f.source === 'haircut' && f.impactPct > 0 && <p>{t.fillImpact(p1(f.impactPct), `$${f.amountUsd.toLocaleString('en-US')}`)}</p>}
          {f.source === 'pool' && f.basis !== undefined && <p className="muted">{t.fillBasis(p1(Math.abs(f.basis)), f.basis < 0, f.samples)}</p>}
          {big && big.length > 0 && (
            <dl className="bh-size">
              {[{ usd: f.amountUsd, a }, ...big].map((x) => {
                const imp = x.a.fill?.impactPct ?? 0, edge = x.a.total - x.a.hold;
                return <div key={x.usd} className={imp > 0.01 ? 'thin' : ''}><dt>{t.fillAt(`$${x.usd.toLocaleString('en-US')}`)}</dt><dd><span className={sign(edge)}>{t.vsHold(pct(edge))}</span><small>{t.fillImpactAt(p1(imp))}{imp > 0.01 ? ` · ${t.fillThin}` : ''}</small></dd></div>;
              })}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

/** The record over its last `days`, rebased to 1 at the window's start (the curve then reads from what was put in). */
function cropTo(a: Agent, days: number): Agent {
  const from = (a.equity[a.equity.length - 1]?.time ?? 0) - days * 86_400;
  const cut = (xs: { time: number; value: number }[]) => { const ys = xs.filter((p) => p.time >= from); const b0 = ys[0]?.value || 1; return ys.map((p) => ({ time: p.time, value: p.value / b0 })); };
  return { ...a, equity: cut(a.equity), bench: cut(a.bench) };
}

/**
 * One agent's detail, in two columns. Above the fold (a few numbers, a few words): who and what it does; the money
 * it would have made against just holding, as two bars; three periods that are also the switch; one risk line;
 * when it works and when it struggles; hire. Everything else is in closed "자세히" sections: how it works, more
 * numbers (steadiness, trades), the record in parts and how fills were priced, the evidence, and every trade.
 */
function Backtest({ a, year, ranked, cursor, onSelect, onHire, onAsk }: {
  a: Agent; year: Agent; ranked: Agent[]; period: Period; cursor: number | null;
  onSelect: (a: Agent) => void; onHire: (a: Agent) => void; onAsk: (a: Agent) => void;
}) {
  const { t, lang } = useT();
  const pill = statePill(t, year);
  const day = (s: number) => new Date(s * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-GB', { year: '2-digit', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).replace(/\.$/, '');
  const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const live = cursor !== null;
  const seen = (time: number) => !live || time <= cursor;
  const rounds = a.kind === 'position' ? trips(a).filter((r) => seen(r.buy.time)) : [];
  const buys = a.kind === 'collect' ? [...a.marks].filter((m) => seen(m.time)).reverse().slice(0, 120) : [];
  const here = ranked.findIndex((x) => x.id === year.id);
  const step = (n: number) => { const next = ranked[(here + n + ranked.length) % ranked.length]; if (next) onSelect(next); };
  const conds = a.made ?? (a.rule !== 'made' ? TEMPLATES[a.rule] : undefined);
  const cash = usePrincipal(lang);
  const m = (mult: number, short = false) => moneyText(lang, cash.amount * mult, short);
  const [pre, post] = t.btIf('\u0000', a.kind === 'collect').split('\u0000');
  const p = profile(a);
  // The three periods are the switch: the hero and the curve follow the one picked (the page's period to start with).
  const [pagePeriod, setPagePeriod] = usePeriod();
  const avail = PERIODS.filter((d) => periodResult(a, d));
  const win: PeriodDays = avail.includes(pagePeriod) ? pagePeriod : avail[avail.length - 1] ?? pagePeriod;
  const r = periodResult(a, win);
  // During a replay the hero follows the day on screen, over the whole record.
  const now = live ? standing(a, cursor) : r ? { eq: 1 + r.total, hold: 1 + r.hold } : standing(a, null);
  const top = Math.max(now.eq, now.hold, 0.0001);
  const dir = now.eq > 1.0005 ? 'up' : now.eq < 0.9995 ? 'down' : 'flat';
  const steady = a.sharpe >= 1 ? 'hi' : a.sharpe >= 0.4 ? 'mid' : 'lo';
  return (
    <div className="bt v2" key={a.id}>
      <section className="dt-main">
        <div className="dt-who">
          <Face rule={a.rule} base={a.base} size="lg" />
          <div className="dt-name"><b>{agentName(t, a)}</b><small>{a.made ? ruleLines(t, a)[0] : t.agPlain[a.rule]}</small></div>
          <span className={`badge ${pill.cls}`}><i />{pill.text}</span>
          {here >= 0 && ranked.length > 1 && (
            <span className="bt-step">
              <button className="icon-btn sm" onClick={() => step(-1)} aria-label={t.btPrev} data-tip={t.btPrev}><Icon name="chevron" size={14} /></button>
              <button className="icon-btn sm" onClick={() => step(1)} aria-label={t.btNext} data-tip={t.btNext}><Icon name="chevron" size={14} /></button>
            </span>
          )}
        </div>

        <div className="dt-hero">
          <small>
            {live ? t.rpAt(day(cursor)) : t.pfName[win]} · {pre}
            <select className="bt-amt" value={cash.at} onChange={(e) => cash.pick(Number(e.target.value))} aria-label={t.btAmount}>
              {cash.list.map((v, i) => <option key={v} value={i}>{moneyText(lang, v)}</option>)}
            </select>
            {post}
          </small>
          <div className="dt-bar me"><span className="dt-bar-name">{a.made?.name ?? t.agNick[a.rule]}</span><i style={{ width: `${(now.eq / top) * 100}%` }} /><b className={dir}>{m(now.eq)}<em aria-hidden>{dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''}</em></b></div>
          <div className="dt-bar hold"><span className="dt-bar-name">{t.acHold}</span><i style={{ width: `${(now.hold / top) * 100}%` }} /><b>{m(now.hold)}</b></div>
        </div>

        <div className="dt-cells" role="group" aria-label={t.pfPeriod}>
          {PERIODS.map((d) => {
            const x = periodResult(a, d), v = x && verdictOf(x);
            return (
              <button key={d} className={`dt-cell${win === d && !live ? ' on' : ''} ${v ?? ''}`} disabled={!x || live} aria-pressed={win === d} onClick={() => setPagePeriod(d)}>
                <small>{t.pfName[d]}</small>
                <b>{x ? `${x.total > 0 ? '+' : x.total < 0 ? '−' : ''}${Math.abs(Math.round(x.total * 100))}%` : '—'}</b>
                <em data-tip={v ? t.pfVerdict[v] : t.pfNoData}>{v ? `${VERDICT_MARK[v]} ${t.pfVerdictShort[v]}` : t.pfNoData}</em>
              </button>
            );
          })}
        </div>

        <p className={`dt-risk risk-${p.risk}`}><span className="dt-dots" aria-hidden>{[0, 1, 2].map((k) => <i key={k} className={k <= ['lo', 'mid', 'hi'].indexOf(p.risk) ? 'on' : ''} />)}</span>{t.dtRisk(t.dtRiskLevel[p.risk], drop(a.maxDd))}</p>
        {a.rule !== 'made' && (
          <div className="dt-chips">
            <span className="good" title={t.agGood[a.rule]}><Icon name="check" size={14} /><b>{t.dtWorks}</b>{t.agGood[a.rule]}</span>
            <span className="weak" title={t.agRisk[a.rule]}><Icon name="close" size={14} /><b>{t.dtStruggles}</b>{t.agRisk[a.rule]}</span>
          </div>
        )}
        {!a.runnable && <p className="bt-demo">{t.whyNot(a.base)}</p>}
        <div className="dt-cta">
          {a.runnable && <button className="btn-primary hire" onClick={() => onHire(year)}>{t.acHire}</button>}
          <button className="btn" onClick={() => onAsk(year)}><Spark size={14} />{t.acAsk}</button>
        </div>
      </section>

      <section className="dt-side">
        <Curves a={live ? a : cropTo(a, win)} peers={[]} upto={cursor} label={(v) => m(v, true)} onPick={onSelect} />
        <div className="bt-legend">
          <span><i className="lg-agent" />{t.btAgent}</span><span><i className="lg-hold" />{t.acHold}</span>
          <span className="bt-span">{day(a.from)} – {day(a.to)}</span>
        </div>
        <details className="dt-more" open={live}>
          <summary>{t.dtMore}<Icon name="down" size={14} /></summary>
          <details className="dt-acc">
            <summary>{t.dtHow}</summary>
            {conds ? (
              <div className="bt-rule">
                <p><span className="wz-tag buy">{t.cuBuy}</span>{conds.buy.map((c) => condText(t, c)).join(` ${t.cuAnd} `)}</p>
                <p><span className="wz-tag sell">{t.cuSell}</span>{conds.sell.length ? conds.sell.map((c) => condText(t, c)).join(` ${t.cuOr} `) : t.wzSellAuto}</p>
              </div>
            ) : <ul className="bt-rule list">{ruleLines(t, a).map((x) => <li key={x}>{x}</li>)}</ul>}
            {a.rule !== 'made' && <p className="ab2-fit">{t.agFit[a.rule]}</p>}
          </details>
          <details className="dt-acc">
            <summary>{t.dtNumbers}</summary>
            <dl className="bt-stats">
              <div><dt>{t.thDd}</dt><dd>{drop(a.maxDd)}</dd></div>
              <div><dt>{t.dtSteady(a.sharpe.toFixed(2), t.dtSteadyWord[steady])}</dt><dd>{a.sharpe.toFixed(2)}</dd></div>
              <div><dt>{a.kind === 'collect' ? t.acBuys : t.thTrades}</dt><dd>{t.btTimes(a.target !== undefined ? a.moves ?? a.trades : a.trades)}</dd></div>
              {a.target !== undefined ? <div><dt>{t.btAvgShare}</dt><dd>{Math.round((a.exposure ?? 0) * 100)}%</dd></div> : <div><dt>{t.btHeldStat}</dt><dd>{Math.round(a.inMarket * 100)}%</dd></div>}
            </dl>
            <p className="bt-say">{t.btSay({ collect: a.kind === 'collect', better: a.total >= a.hold, trades: a.trades, hold: pct(a.hold), total: pct(a.total), held: `${Math.round(a.inMarket * 100)}%` })}</p>
            {a.kind === 'position' && a.exposure !== undefined && a.exposure < 0.995 && <p className="bt-say">{t.mixTip(Math.round(a.exposure * 100), pct(a.exposure * a.hold))}</p>}
          </details>
          <details className="dt-acc">
            <summary>{t.dtSlices} · {t.dtFill}</summary>
            <Honesty a={a} pool={Math.max(1, ranked.length)} />
          </details>
          <details className="dt-acc">
            <summary>{t.dtProof}</summary>
            <dl className="ab2-facts">
              <div><dt>{t.abProofRow}</dt><dd><span className={`proof lv-${PROOF[a.rule]}`}>{t.agProofLv[PROOF[a.rule]]}</span>{t.agProof[a.rule]}</dd></div>
              <div><dt>{t.abUsers}</dt><dd>{a.shared ? (a.shared.hires !== undefined ? t.shHires(a.shared.hires) : t.shLabel) : t.agUsers[a.rule]}</dd></div>
              <div><dt>{t.abSourceShow}</dt><dd className="src">{a.shared ? t.shFrom(whoText(lang, a.shared), a.shared.feeBps ? feeText(a.shared.feeBps) : '') : t.agFrom[a.rule]}</dd></div>
            </dl>
          </details>
          <details className="dt-acc" open={live}>
            <summary>{t.dtLog}</summary>
            {a.kind === 'position' ? (
              <>
                <div className="bt-log-head"><span>{t.btBuy}</span><span>{t.btSell}</span><span>{t.btRet}</span></div>
                <div className="bt-log-body">
                  {rounds.map((x) => {
                    const sold = x.sell && seen(x.sell.time) ? x.sell : undefined;
                    return (
                      <div key={x.buy.time} className="bt-log-row">
                        <span><b>{day(x.buy.time)}</b><small>{px(x.buy.price)}</small></span>
                        <span>{sold ? <><b>{day(sold.time)}</b><small>{px(sold.price)}</small></> : <span className="badge sig-good"><i />{t.acHolding}</span>}</span>
                        <span className={`bt-ret ${sold || !live ? sign(x.ret) : ''}`}>{sold || !live ? pct(x.ret) : t.scNone}</span>
                      </div>
                    );
                  })}
                  {!rounds.length && <p className="bt-none">{t.btNoTrades}</p>}
                </div>
              </>
            ) : (
              <>
                <div className="bt-log-head"><span>{t.btDay}</span><span>{t.price}</span><span>{t.btSize}</span></div>
                <div className="bt-log-body">
                  {buys.map((b) => (
                    <div key={b.time} className="bt-log-row one">
                      <span><b>{day(b.time)}</b></span>
                      <span>{px(b.price)}</span>
                      <span className={`bt-ret ${(b.mult ?? 1) > 1 ? 'pos' : ''}`}>×{b.mult ?? 1}</span>
                    </div>
                  ))}
                  {!buys.length && <p className="bt-none">{t.btNoTrades}</p>}
                </div>
              </>
            )}
          </details>
        </details>
      </section>
    </div>
  );
}

type Tab = 'mine' | 'top' | 'list' | 'spread' | 'chain' | 'bt' | 'swaps';

const LP_ICON: Record<LpStrategy['goal'], IconName> = { buy: 'dip', sell: 'trend', both: 'collect' };

/** While the list is worked out: the market's rules as real rows (name, one line), only the number shimmering. */
function PendingRows({ coin, period }: { coin: string; period: PeriodDays }) {
  const { t } = useT();
  const rules = POSITION_RULES.filter((r) => !isRetired({ rule: r.id, base: coin }) && !DEMOTED.has(r.id)).slice(0, 6);
  const [slow, setSlow] = useState(false);
  useEffect(() => { const x = setTimeout(() => setSlow(true), 10_000); return () => clearTimeout(x); }, []);
  return (
    <>
      <p className="tk-calc" role="status"><span className="spin" aria-hidden />{t.pfCalc(0, rules.length)}{slow && <em>{t.pfSlow}</em>}</p>
      <ol className="tk-list">{rules.map((r) => <AgentRow key={r.id} a={{ rule: r.id, base: coin, live: false, kind: 'position' }} period={period} pending />)}</ol>
    </>
  );
}

export default function Dock({ venue, coin, list, failed, sel, shown, period, cursor = null, onRetry, onBuild, onSelect, onHire, onAsk, swaps, mine, mineCount = 0, mineAsks = 0, onLp, at }: {
  /** When the list was scored (ms, from the server's cache), for "5분 전 기준". */
  at?: number | null;
  venue: 'cex' | 'dex'; coin: string; list: Agent[] | null; failed: boolean;
  /** The agent picked (its one-year numbers, as in the list) and the backtest on screen (one year or all history). */
  sel: Agent | null; shown: Agent | null; period: Period; setPeriod: (p: Period) => void; busy?: boolean; onRetry?: () => void; onBuild?: () => void;
  /** The replay's day, when one is open: the backtest then shows only what had happened by then. */
  cursor?: number | null;
  onSelect: (a: Agent | null) => void; onHire: (a: Agent) => void; onAsk: (a: Agent) => void; swaps?: ReactNode;
  /** The user's hired agents as a table, how many there are, and how many wait for an answer. */
  mine?: ReactNode; mineCount?: number; mineAsks?: number;
  /** HSKSwap only: open the liquidity studio with a ready-made strategy. */
  onLp?: (s: LpStrategy) => void;
}) {
  const { t } = useT();
  // Someone with agents sees how they are doing first; everyone else sees what the market offers.
  const [tab, setTab] = useState<Tab>(sel ? 'bt' : mineCount ? 'mine' : 'top');
  // The first agent hired (or the list arriving after login) brings its row up; the last one removed leaves the tab.
  const had = useRef(mineCount);
  useEffect(() => {
    if (mineCount > had.current) setTab((cur) => (cur === 'list' || cur === 'top' || cur === 'bt' && !sel ? 'mine' : cur));
    had.current = mineCount;
  }, [mineCount]); // eslint-disable-line react-hooks/exhaustive-deps
  // Picking an agent opens its backtest; closing it goes back to the list.
  useEffect(() => { setTab((cur) => (sel ? 'bt' : cur === 'bt' ? 'top' : cur)); }, [sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // One order, Moa's: published classics first, then the smaller worst drop. (Other orders live in the agent market.)
  // The research's demoted classics keep their place in the list, after the others.
  const all = useMemo(() => (list ? [...list].sort(byMerit) : []), [list]);
  // With enough published strategies for the market, the rules without a published source wait behind one row.
  const [more, setMore] = useState(false);
  const classics = all.filter((a) => a.tier === 1 || a.made);
  const fold = classics.length >= 4 && classics.length < all.length;
  const open = fold && !more && !(sel && sel.tier !== 1) ? classics : all;
  // Three columns side by side, by how long the strategy is built to hold: long, swing, short.
  const groups = HORIZONS.map((h) => ({ h, rows: open.filter((a) => horizonOf(a) === h) })).filter((g) => g.rows.length);
  const ranked = groups.flatMap((g) => g.rows);
  /** Moa's pick in each group: the first in its order that actually traded in the backtest. */
  const pickOf = (h: Horizon) => all.find((a) => horizonOf(a) === h && !idle(a))?.id;
  const hint = isRunnable(coin) ? t.mkSignalTrade : t.mkHintSignal(coin);
  const seamDay = shown?.seam ? new Date(shown.seam * 1000).toISOString().slice(0, 10) : '';
  // "Doing well now": the same order as everywhere (working first, then beating just holding), the first few.
  // The list under the chart, by tier for the period on screen (src/Perf.tsx); classics and the lab stay folded.
  const [pPeriod, setPPeriod] = usePeriod();
  const tiered = useMemo(() => byTier(all), [all]);
  const holdAgent = all.find((a) => periodResult(a, pPeriod));
  const note = tab === 'bt' && shown ? `${seamDay ? `${t.btSeam(seamDay)} ` : ''}${t.acFoot(`${(shown.fee * 100).toFixed(1)}%`, shown.days, shown.interval)}` : tab === 'list' ? hint : '';

  return (
    <section className={`tdock venue-${venue}`} aria-label={t.mkTitle}>
      <header className="tdock-head">
        <div className="tdock-tabs has-line" role="tablist">
          <SlidePill dep={`${tab}-${sel?.id ?? ''}-${mineCount}`} />
          {mine && <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>{t.navMine}{mineCount > 0 && <span className={`tdock-count${mineAsks ? ' ask' : ''}`}>{mineCount}</span>}</button>}
          <button role="tab" aria-selected={tab === 'top'} className={tab === 'top' ? 'on' : ''} onClick={() => setTab('top')}>{t.dkTopTab}</button>
          <button role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>{t.dkAllTab}</button>
          {/* HSKSwap against the exchange, for the three coins a vault trades */}
          {(ASSETS as string[]).includes(coin) && <button role="tab" aria-selected={tab === 'spread'} className={tab === 'spread' ? 'on' : ''} onClick={() => setTab('spread')}>{t.sxTab}</button>}
          {/* HSK's own chain: the WHSK pool's swaps and liquidity */}
          {coin === 'HSK' && <button role="tab" aria-selected={tab === 'chain'} className={tab === 'chain' ? 'on' : ''} onClick={() => setTab('chain')}>{t.owTab}</button>}
          {sel && (
            <button role="tab" aria-selected={tab === 'bt'} className={tab === 'bt' ? 'on' : ''} onClick={() => setTab('bt')}>
              {t.btTab}<span className="tdock-tab-sub">{sel.made?.name ?? t.agNick[sel.rule]}</span>
            </button>
          )}
          {swaps && <button role="tab" aria-selected={tab === 'swaps'} className={tab === 'swaps' ? 'on' : ''} onClick={() => setTab('swaps')}>{t.recentSwaps}</button>}
        </div>
        <p className="tdock-note">{note}</p>
        {tab === 'mine' && <button className="btn sm tdock-build" onClick={() => setTab('list')}><Icon name="plus" size={14} />{t.mdAdd}</button>}
        {tab === 'top' && <PeriodSwitch value={pPeriod} onChange={setPPeriod} />}
        {tab === 'top' && <AsOf at={at} t={t} />}
        {(tab === 'list' || tab === 'top') && onBuild && <button className="btn sm tdock-build" onClick={onBuild}><Icon name="plus" size={14} />{t.mkBuild}</button>}
        {tab === 'bt' && sel && <button className="icon-btn sm" onClick={() => onSelect(null)} aria-label={t.btBack} data-tip={t.btBack}><Icon name="close" size={16} /></button>}
      </header>

      <div className="tdock-body">
        {tab === 'mine' && (mineCount > 0 ? mine : (
          <div className="md-empty">
            <b>{t.mineEmpty}</b>
            <p>{t.mdEmptySub}</p>
            <button className="btn sm" onClick={() => setTab('list')}>{t.mdSee}</button>
          </div>
        ))}
        {tab === 'top' && (
          <div className={`tk${venue === 'dex' && onLp ? ' with-lp' : ''}`} key={`top-${venue}-${coin}`}>
            {venue === 'dex' && onLp && (
              <section className="tk-lp" aria-label={t.dkLpTitle}>
                <header className="tk-head"><b>{t.dkLpTitle}</b><small>{t.dkLpSub}</small></header>
                <div className="tk-lp-grid">
                  {LP_STRATEGIES.map((x) => (
                    <button key={x.id} className={`tk-lp-tile g-${x.goal}`} onClick={() => onLp(x)}>
                      <span className="lps-goal-ico"><Icon name={LP_ICON[x.goal]} size={16} /></span>
                      <span><b>{t.lpsStrat[x.id][0]}</b><small>{t.lpsStrat[x.id][1]}</small></span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="tk-agents" aria-label={t.dkTopTitle}>
              {failed && <StateBox compact title={t.errAgents} text={t.agFailed} retry={t.retry} onRetry={onRetry} />}
              {!list && !failed && <PendingRows coin={coin} period={pPeriod} />}
              {list && !failed && !all.length && <p className="tk-none">{t.mpNone}</p>}
              {list && !failed && !tiered.some((g) => g.tier === 'ahead') && all.length > 0 && <p className="tk-none">{t.pfNoneAhead}</p>}
              {tiered.map((g) => {
                const rows = (
                  <ol className="tk-list">
                    {g.agents.map((a) => <AgentRow key={a.id} a={a} period={pPeriod} onOpen={() => { onSelect(a); setTab('bt'); }} hire={a.runnable ? <button className="btn-primary sm tk-hire" onClick={() => onHire(a)}>{t.acHire}</button> : <span className="tk-only">{t.wzSignalOnly}</span>} />)}
                    <HoldRow coin={coin} a={holdAgent} period={pPeriod} />
                  </ol>
                );
                const head = <><b data-tip={t.tierWhy[g.tier]}>{t.tierName[g.tier]}</b><small>{g.tier === 'lab' ? t.tierLabWarn : t.pfTierSub[g.tier]}</small></>;
                return FOLDED.has(g.tier)
                  ? <details key={g.tier} className="tk-tier"><summary className="tk-head">{head}<Icon name="down" size={14} /></summary>{rows}</details>
                  : <div key={g.tier} className="tk-tier"><header className="tk-head">{head}</header>{rows}</div>;
              })}
            </section>
          </div>
        )}
        {tab === 'list' && (
          <div className="hzb" key={`${venue}-${coin}`} style={{ '--cols': groups.length || 3 } as CSSProperties}>
            {failed && <div className="hzb-wide"><StateBox compact title={t.errAgents} text={t.agFailed} retry={t.retry} onRetry={onRetry} /></div>}
            {!list && !failed && HORIZONS.map((h) => (
              <section key={h} className={`hz-col hz-${h}`} aria-hidden>
                <header className="hz-head"><b>{t.hz[h]}</b><p>{t.hzSub[h]}</p></header>
                {[0, 1, 2].map((i) => <div key={i} className="hzr skel-block" />)}
              </section>
            ))}
            {groups.map((g) => (
              <section key={g.h} className={`hz-col hz-${g.h} stagger`} aria-label={t.hz[g.h]}>
                <header className="hz-head" data-tip={t.hzOrder}><b>{t.hz[g.h]}<small>{g.rows.length}</small></b><em>{t.hzLegend}</em><p>{t.hzSub[g.h]}</p><em>{t.hzHold(pct(g.rows[0].hold))}</em>{g.h === 'short' && <p className="hz-fee">{t.hzShortFee}</p>}</header>
                {g.rows.map((a, i) => <AgentCard key={a.id} agent={a} size="cell" rank={i + 1} picked={sel?.id === a.id} best={a.id === pickOf(g.h)} onPick={() => { onSelect(a); setTab('bt'); }} />)}
              </section>
            ))}
            {fold && <button className="frow-more hzb-wide" onClick={() => setMore((v) => !v)}>{more ? t.dkLess : t.dkMore(all.length - classics.length)}<Icon name="down" size={14} /></button>}
          </div>
        )}
        {tab === 'bt' && sel && shown && <Backtest a={shown} year={sel} ranked={ranked} period={period} cursor={cursor} onSelect={onSelect} onHire={onHire} onAsk={onAsk} />}
        {tab === 'spread' && (ASSETS as string[]).includes(coin) && <SpreadPanel key={coin} asset={coin as Asset} onHire={onHire} />}
        {tab === 'chain' && coin === 'HSK' && <OnchainPanel />}
        {tab === 'swaps' && swaps}
      </div>
    </section>
  );
}
