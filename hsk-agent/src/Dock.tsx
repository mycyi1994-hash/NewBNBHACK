// The panel under the chart. One screen does the whole job:
//  - "Agents for this market": the agents from agents.ts for the market on the chart (same numbers as the agent
//    market and Moa's cards), ranked. The default order is Moa's own: published classics first, then the smaller
//    worst drop. Picking one does not move money; it opens its backtest right here.
//  - "Backtest": what that agent would have done: the result against just holding, its curve among the others,
//    and every buy and sell (the chart above shows the same buys and sells on the candles). One year by default,
//    so agents compare like for like; "All history" reruns it over everything the exchange has.
//  - "Recent swaps" (HSKSwap view only).
// Hiring happens from the backtest, after the evidence, through the same hire sheet as everywhere else.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Asset } from './intent.ts';
import type * as cex from './cex.ts';
import { byMerit, collectAgents, isRunnable, positionAgents, rescore, PROOF, type Agent, type Mark } from './agents.ts';
import { readLevel, recommend } from './recommend.ts';
import { AgentCard, agentName, drop, pct, sourceLine, statePill, Face } from './AgentCard.tsx';
import { fmtPrice } from './market.ts';
import { useT } from './i18n.ts';
import { Icon, Spark } from './Icons.tsx';
import { SlidePill } from './motion.tsx';
import { StateBox } from './ui.tsx';

/** Price with sensible decimals for anything from BTC to DOGE. */
export const px = (v: number) => (v >= 1000 ? v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  : v >= 1 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : fmtPrice(v));

/** The agents for the market on the chart: position agents (HashKey market) or collect agents (HSKSwap coin). */
export function useMarketAgents(venue: 'cex' | 'dex', market: cex.Market, asset: Asset) {
  const [list, setList] = useState<Agent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    let alive = true;
    setList(null); setFailed(false);
    (venue === 'cex' ? positionAgents(market) : collectAgents(asset)).then((xs) => alive && setList(xs), () => alive && setFailed(true));
    return () => { alive = false; };
  }, [venue, market.symbol, asset, again]); // eslint-disable-line react-hooks/exhaustive-deps
  return { list, failed, retry: () => setAgain((n) => n + 1) };
}

export type Period = 'year' | 'std' | 'all';
/** The backtest on screen: the standard three years from the list, or the same agent over one year or all its history. */
export function useBacktest(sel: Agent | null) {
  const [period, setPeriod] = useState<Period>('std');
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
  const perYear = a.trades / Math.max(1, a.days / 365);
  return {
    perYear,
    risk: (a.maxDd >= 0.45 ? 'hi' : a.maxDd >= 0.25 ? 'mid' : 'lo') as 'hi' | 'mid' | 'lo',
    freq: (a.kind === 'collect' && perYear >= 200 ? 'daily' : perYear >= 12 ? 'often' : perYear >= 3 ? 'some' : 'rare') as 'daily' | 'often' | 'some' | 'rare',
    hold: (a.inMarket >= 0.7 ? 'most' : a.inMarket >= 0.3 ? 'half' : 'cash') as 'most' | 'half' | 'cash',
  };
}

/**
 * The agent's curve against just holding, in money, with the market's other agents faint behind it (tap one to
 * open it). During a replay only the days up to the cursor are drawn, on the full backtest's scale.
 */
/** A thin bar: how far along a scale something is. */
function Meter({ frac, tone }: { frac: number; tone?: 'hi' | 'mid' | 'lo' }) {
  return <span className={`meter${tone ? ` risk-${tone}` : ''}`} aria-hidden><i style={{ width: `${Math.round(Math.max(0.04, Math.min(1, frac)) * 100)}%` }} /></span>;
}

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

function Backtest({ a, year, ranked, period, cursor, onSelect, onHire, onAsk }: {
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
  const at = ranked.findIndex((x) => x.id === year.id);
  const step = (n: number) => { const next = ranked[(at + n + ranked.length) % ranked.length]; if (next) onSelect(next); };
  // Money: what the amount put in would be worth, for the agent and for just holding, on the day shown.
  const cash = usePrincipal(lang);
  const now = standing(a, cursor);
  const total = now.eq - 1, hold = now.hold - 1, edge = total - hold;
  const m = (mult: number, short = false) => moneyText(lang, cash.amount * mult, short);
  const [pre, post] = t.btIf('\u0000', a.kind === 'collect').split('\u0000');
  const p = profile(a);
  // The right-hand column: what kind of strategy this is, or its trades. A replay opens the trades.
  const [side, setSide] = useState<'about' | 'log'>('about');
  useEffect(() => { if (live) setSide('log'); }, [live]);
  return (
    <div className="bt" key={a.id}>
      <section className="bt-who">
        <div className="bt-title">
          <Face rule={a.rule} size="lg" />
          <div className="bt-name"><b>{agentName(t, a)}</b><small>{t.agRule[a.rule]} · {sourceLine(t, a)}</small></div>
          {at >= 0 && ranked.length > 1 && (
            <span className="bt-step">
              <button className="icon-btn sm" onClick={() => step(-1)} aria-label={t.btPrev} data-tip={t.btPrev}><Icon name="chevron" size={14} /></button>
              <button className="icon-btn sm" onClick={() => step(1)} aria-label={t.btNext} data-tip={t.btNext}><Icon name="chevron" size={14} /></button>
            </span>
          )}
        </div>
        <div className="bt-badges">
          {at >= 0 && <span className="rank-chip">{t.btRank(at + 1, ranked.length)}</span>}
          <span className={`origin tier-${a.tier}`}>{t.agOrigin[a.rule]}</span>
        </div>
        {/* What it is doing right now, in one coloured line. */}
        <p className={`bt-state ${pill.cls}`}><i /><b>{pill.text}</b><span>{a.kind === 'collect' ? t.stCollect : year.live ? t.stHold : t.stWait}</span></p>
        {/* Its character, each with the number it comes from. */}
        <dl className="bt-meters" data-tip={t.tagNote}>
          <div><dt>{t.mRisk}</dt><dd><Meter frac={a.maxDd / 0.8} tone={p.risk} /></dd><dd className="m-val"><b className={`risk-${p.risk}`}>{t.tagRisk[p.risk]}</b><span>{t.mDd} {drop(a.maxDd)}</span></dd></div>
          <div><dt>{t.mFreq}</dt><dd><Meter frac={Math.sqrt(Math.min(1, p.perYear / 60))} /></dd><dd className="m-val"><b>{t.tagFreq[p.freq]}</b><span>{t.perYear(p.perYear >= 10 ? p.perYear.toFixed(0) : p.perYear.toFixed(1))}</span></dd></div>
          {a.kind === 'position' && <div><dt>{t.mHold}</dt><dd><Meter frac={a.inMarket} /></dd><dd className="m-val"><b>{t.tagHold[p.hold]}</b><span>{Math.round(a.inMarket * 100)}%</span></dd></div>}
        </dl>
        <ul className="bt-rules">{t.agRules[a.rule].slice(0, 2).map((r) => <li key={r}>{r}</li>)}</ul>
        <div className="bt-cta">
          {a.runnable && <button className="btn-primary hire" onClick={() => onHire(year)}>{t.acHire}</button>}
          <button className="btn" onClick={() => onAsk(year)}><Spark size={14} />{t.acAsk}</button>
        </div>
      </section>

      <section className="bt-perf">
        <div className="bt-hero">
          <div className="bt-big">
            <small>
              {pre}
              <select className="bt-amt" value={cash.at} onChange={(e) => cash.pick(Number(e.target.value))} aria-label={t.btAmount}>
                {cash.list.map((v, i) => <option key={v} value={i}>{moneyText(lang, v)}</option>)}
              </select>
              {post}
            </small>
            <span className="bt-sum"><b className={sign(total)}>{m(now.eq)}</b><em className={sign(total)}>{pct(total)}</em></span>
          </div>
          <div className="bt-big dim">
            <small>{t.btIfHold}</small>
            <span className="bt-sum"><b>{m(now.hold)}</b><em className={sign(hold)}>{pct(hold)}</em></span>
          </div>
          {live ? <span className="bt-edge live"><i />{t.rpAt(day(cursor))}</span> : <span className={`bt-edge ${sign(edge)}`}>{t.vsHold(pct(edge))}</span>}
        </div>
        <p className="bt-say">{t.btSay({ collect: a.kind === 'collect', better: a.total >= a.hold, trades: a.trades, hold: pct(a.hold), total: pct(a.total), held: `${Math.round(a.inMarket * 100)}%` })}{t.btFx && <span className="bt-fx"> {t.btFx}</span>}</p>
        <dl className="bt-stats">
          <div><dt>{t.thDd}</dt><dd>{drop(a.maxDd)}</dd></div>
          <div><dt>{t.thSharpe}</dt><dd>{a.sharpe.toFixed(2)}</dd></div>
          <div><dt>{a.kind === 'collect' ? t.acBuys : t.thTrades}</dt><dd>{t.btTimes(a.trades)}</dd></div>
          <div><dt>{t.btHeldStat}</dt><dd>{Math.round(a.inMarket * 100)}%</dd></div>
        </dl>
        <Curves a={a} peers={period === 'std' ? ranked.filter((x) => x.id !== year.id).slice(0, 5) : []} upto={cursor} label={(v) => m(v, true)} onPick={onSelect} />
        <div className="bt-legend">
          <span><i className="lg-agent" />{t.btAgent}</span><span><i className="lg-hold" />{t.acHold}</span>
          <span className="bt-span">{day(a.from)} – {day(a.to)}</span>
        </div>
      </section>

      <section className="bt-log">
        <div className="bt-side-tabs has-line" role="tablist">
          <SlidePill dep={side} />
          <button role="tab" aria-selected={side === 'about'} className={side === 'about' ? 'on' : ''} onClick={() => setSide('about')}>{t.tabAbout}</button>
          <button role="tab" aria-selected={side === 'log'} className={side === 'log' ? 'on' : ''} onClick={() => setSide('log')}>{t.tabLog}</button>
        </div>
        {side === 'about' ? (
          <div className="bt-about">
            <section className="ab-card">
              <h4>{t.abForYou}</h4>
              <p className="ab-fit">{t.agFit[a.rule]}</p>
              <div className="ab-two">
                <div className="ab-good"><b><Icon name="check" size={14} />{t.abGood}</b><p>{t.agGood[a.rule]}</p></div>
                <div className="ab-weak"><b><Icon name="close" size={14} />{t.abWeak}</b><p>{t.agRisk[a.rule]}</p></div>
              </div>
            </section>
            <section className="ab-card">
              <h4>{t.abTrust}<span className={`proof lv-${PROOF[a.rule]}`}>{t.agProofLv[PROOF[a.rule]]}</span></h4>
              <p>{t.agProof[a.rule]}</p>
              <p className="ab-line"><b>{t.abUsers}</b>{t.agUsers[a.rule]}</p>
              <p className="ab-line src"><b>{t.abSourceShow}</b>{t.agFrom[a.rule]}</p>
              {!a.runnable && <p className="bt-demo">{t.whyNot(a.base)}</p>}
            </section>
          </div>
        ) : a.kind === 'position' ? (
          <>
            <div className="bt-log-head"><span>{t.btBuy}</span><span>{t.btSell}</span><span>{t.btRet}</span></div>
            <div className="bt-log-body">
              {rounds.map((r) => {
                const sold = r.sell && seen(r.sell.time) ? r.sell : undefined;
                return (
                  <div key={r.buy.time} className="bt-log-row">
                    <span><b>{day(r.buy.time)}</b><small>{px(r.buy.price)}</small></span>
                    <span>{sold ? <><b>{day(sold.time)}</b><small>{px(sold.price)}</small></> : <span className="badge sig-good"><i />{t.acHolding}</span>}</span>
                    <span className={`bt-ret ${sold || !live ? sign(r.ret) : ''}`}>{sold || !live ? pct(r.ret) : t.scNone}</span>
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
      </section>
    </div>
  );
}

type Tab = 'list' | 'bt' | 'swaps';

export default function Dock({ venue, coin, list, failed, sel, shown, period, setPeriod, busy, cursor = null, onRetry, onSelect, onHire, onAsk, swaps }: {
  venue: 'cex' | 'dex'; coin: string; list: Agent[] | null; failed: boolean;
  /** The agent picked (its one-year numbers, as in the list) and the backtest on screen (one year or all history). */
  sel: Agent | null; shown: Agent | null; period: Period; setPeriod: (p: Period) => void; busy?: boolean; onRetry?: () => void;
  /** The replay's day, when one is open: the backtest then shows only what had happened by then. */
  cursor?: number | null;
  onSelect: (a: Agent | null) => void; onHire: (a: Agent) => void; onAsk: (a: Agent) => void; swaps?: ReactNode;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>(sel ? 'bt' : 'list');
  // Picking an agent opens its backtest; closing it goes back to the list.
  useEffect(() => { setTab((cur) => (sel ? 'bt' : cur === 'bt' ? 'list' : cur)); }, [sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // One order, Moa's: published classics first, then the smaller worst drop. (Other orders live in the agent market.)
  const all = useMemo(() => (list ? [...list].sort(byMerit) : []), [list]);
  // With enough published strategies for the market, the rules without a published source wait behind one row.
  const [more, setMore] = useState(false);
  const classics = all.filter((a) => a.tier === 1);
  const fold = classics.length >= 4 && classics.length < all.length;
  const ranked = fold && !more && !(sel && sel.tier !== 1) ? classics : all;
  const best = list ? recommend(list, { coin, level: readLevel() })?.pick.id : undefined;
  const top = ranked[0];
  const hint = venue === 'dex' ? t.mkHintDex : isRunnable(coin) ? t.mkHintCex(coin) : t.mkHintSignal(coin);
  const seamDay = shown?.seam ? new Date(shown.seam * 1000).toISOString().slice(0, 10) : '';
  const note = tab === 'bt' && shown ? `${seamDay ? `${t.btSeam(seamDay)} ` : ''}${t.acFoot(`${(shown.fee * 100).toFixed(1)}%`, shown.days)}` : tab === 'list' ? (top ? `${t.agNick[top.rule]}: ${t.rankWhy(top.tier === 1, drop(top.maxDd))}` : hint) : '';

  return (
    <section className="tdock" aria-label={t.mkTitle}>
      <header className="tdock-head">
        <div className="tdock-tabs has-line" role="tablist">
          <SlidePill dep={`${tab}-${sel?.id ?? ''}`} />
          <button role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>{t.mkTitle}</button>
          {sel && (
            <button role="tab" aria-selected={tab === 'bt'} className={tab === 'bt' ? 'on' : ''} onClick={() => setTab('bt')}>
              {t.btTab}<span className="tdock-tab-sub">{t.agNick[sel.rule]}</span>
            </button>
          )}
          {swaps && <button role="tab" aria-selected={tab === 'swaps'} className={tab === 'swaps' ? 'on' : ''} onClick={() => setTab('swaps')}>{t.recentSwaps}</button>}
        </div>
        <p className="tdock-note">{note}</p>
        {tab === 'bt' && sel && (
          <div className={`seg${busy ? ' busy' : ''}`} role="group" aria-label={t.thPeriod} aria-busy={busy}>
            {busy && <span className="spin" aria-hidden />}
            {(['year', 'std', 'all'] as Period[]).map((p) => <button key={p} className={period === p ? 'on' : ''} aria-pressed={period === p} onClick={() => setPeriod(p)}>{p === 'year' ? t.btYear : p === 'std' ? t.btStd : t.btAll}</button>)}
          </div>
        )}
        {tab === 'bt' && sel && <button className="icon-btn sm" onClick={() => onSelect(null)} aria-label={t.btBack} data-tip={t.btBack}><Icon name="close" size={16} /></button>}
      </header>

      <div className="tdock-body">
        {tab === 'list' && (
          <div className="frows stagger" key={`${venue}-${coin}`}>
            <div className="frow-head" aria-hidden>
              <span>{t.thRank}</span><span>{t.thName}</span><span>{t.thOrigin}</span><span>{t.thState}</span><span>{t.thCurve}</span><span>{t.thEdge}</span><span>{t.thTotal}</span><span>{t.thDd}</span><span />
            </div>
            {failed && <StateBox compact title={t.errAgents} text={t.agFailed} retry={t.retry} onRetry={onRetry} />}
            {!list && !failed && [0, 1, 2, 3].map((i) => <div key={i} className="frow skel-block" aria-hidden />)}
            {ranked.map((a, i) => <AgentCard key={a.id} agent={a} size="tile" rank={i + 1} picked={sel?.id === a.id} best={a.id === best} onPick={() => onSelect(a)} />)}
            {fold && <button className="frow-more" onClick={() => setMore((v) => !v)}>{more ? t.dkLess : t.dkMore(all.length - classics.length)}<Icon name="down" size={14} /></button>}
          </div>
        )}
        {tab === 'bt' && sel && shown && <Backtest a={shown} year={sel} ranked={ranked} period={period} cursor={cursor} onSelect={onSelect} onHire={onHire} onAsk={onAsk} />}
        {tab === 'swaps' && swaps}
      </div>
    </section>
  );
}
