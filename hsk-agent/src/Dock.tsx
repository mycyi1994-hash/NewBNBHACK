// The panel under the chart. One screen does the whole job:
//  - "Agents for this market": the agents from agents.ts for the market on the chart (same numbers as the agent
//    market and Moa's cards). Picking one does not move money; it opens its backtest right here.
//  - "Backtest": what that agent would have done over the last year: the result against just holding, the two
//    curves, and every buy and sell (the chart above shows the same buys and sells on the candles).
//  - "Recent swaps" (HSKSwap view only).
// Hiring happens from the backtest, after the evidence, through the same hire sheet as everywhere else.
import { useEffect, useState, type ReactNode } from 'react';
import type { Asset } from './intent.ts';
import type * as cex from './cex.ts';
import { collectAgents, isRunnable, positionAgents, type Agent, type Mark } from './agents.ts';
import { readLevel, recommend } from './recommend.ts';
import { AgentCard, agentName, drop, pct, sourceLine, statePill, RuleIcon } from './AgentCard.tsx';
import { fmtPrice } from './market.ts';
import { useT } from './i18n.ts';
import { Icon, Spark } from './Icons.tsx';
import { SlidePill } from './motion.tsx';

/** Price with sensible decimals for anything from BTC to DOGE. */
export const px = (v: number) => (v >= 1000 ? v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  : v >= 1 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : fmtPrice(v));

/** The agents for the market on the chart: five position agents (HashKey market) or four collect agents (HSKSwap coin). */
export function useMarketAgents(venue: 'cex' | 'dex', market: cex.Market, asset: Asset) {
  const [list, setList] = useState<Agent[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setList(null); setFailed(false);
    (venue === 'cex' ? positionAgents(market) : collectAgents(asset)).then((xs) => alive && setList(xs), () => alive && setFailed(true));
    return () => { alive = false; };
  }, [venue, market.symbol, asset]); // eslint-disable-line react-hooks/exhaustive-deps
  return { list, failed };
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

/** The agent's curve against just holding, both starting at 1. */
function Curves({ a }: { a: Agent }) {
  const W = 400, H = 100;
  const all = [...a.equity, ...a.bench];
  if (a.equity.length < 2) return null;
  const lo = Math.min(...all.map((p) => p.value)), hi = Math.max(...all.map((p) => p.value)), span = hi - lo || 1;
  const t0 = a.equity[0].time, t1 = a.equity[a.equity.length - 1].time;
  const d = (pts: { time: number; value: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${(((p.time - t0) / (t1 - t0 || 1)) * W).toFixed(1)},${(H - 3 - ((p.value - lo) / span) * (H - 6)).toFixed(1)}`).join('');
  const base = H - 3 - ((1 - lo) / span) * (H - 6);
  return (
    <svg className="bt-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <line x1="0" x2={W} y1={base} y2={base} className="bt-zero" vectorEffect="non-scaling-stroke" />
      <path d={d(a.bench)} className="bt-hold" fill="none" vectorEffect="non-scaling-stroke" />
      <path d={d(a.equity)} className="bt-agent" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Backtest({ a, onHire, onAsk }: { a: Agent; onHire: (a: Agent) => void; onAsk: (a: Agent) => void }) {
  const { t, lang } = useT();
  const pill = statePill(t, a);
  const edge = a.total - a.hold;
  const day = (s: number) => new Date(s * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-GB', { year: '2-digit', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).replace(/\.$/, '');
  const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const rounds = a.kind === 'position' ? trips(a) : [];
  const buys = a.kind === 'collect' ? [...a.marks].reverse().slice(0, 90) : [];
  return (
    <div className="bt" key={a.id}>
      <section className="bt-who">
        <div className="bt-title">
          <span className="frow-ic" aria-hidden><RuleIcon rule={a.rule} /></span>
          <div className="bt-name"><b>{agentName(t, a)}</b><small>{sourceLine(t, a)}</small></div>
          <span className={`badge ${pill.cls}`}><i />{pill.text}</span>
        </div>
        <ul className="bt-rules">{t.agRules[a.rule].map((r) => <li key={r}>{r}</li>)}</ul>
        {!a.runnable && <p className="bt-demo">{t.whyNot(a.base)}</p>}
        <div className="bt-cta">
          {a.runnable && <button className="btn-primary hire" onClick={() => onHire(a)}>{t.acHire}</button>}
          <button className="btn" onClick={() => onAsk(a)}><Spark size={14} />{t.acAsk}</button>
        </div>
      </section>

      <section className="bt-perf">
        <dl className="bt-stats">
          <div className="lead"><dt>{t.thEdge}</dt><dd className={sign(edge)}>{pct(edge)}</dd></div>
          <div><dt>{t.btAgent}</dt><dd className={sign(a.total)}>{pct(a.total)}</dd></div>
          <div><dt>{t.acHold}</dt><dd className={sign(a.hold)}>{pct(a.hold)}</dd></div>
          <div><dt>{t.thDd}</dt><dd>{drop(a.maxDd)}</dd></div>
          <div><dt>{t.thSharpe}</dt><dd>{a.sharpe.toFixed(2)}</dd></div>
          <div><dt>{a.kind === 'collect' ? t.acBuys : t.thTrades}</dt><dd>{t.btTimes(a.trades)}</dd></div>
        </dl>
        <Curves a={a} />
        <div className="bt-legend">
          <span><i className="lg-agent" />{t.btAgent}</span><span><i className="lg-hold" />{t.acHold}</span>
          <span className="bt-span">{day(a.from)} – {day(a.to)}</span>
        </div>
      </section>

      <section className="bt-log">
        {a.kind === 'position' ? (
          <>
            <div className="bt-log-head"><span>{t.btBuy}</span><span>{t.btSell}</span><span>{t.btRet}</span></div>
            <div className="bt-log-body">
              {rounds.map((r) => (
                <div key={r.buy.time} className="bt-log-row">
                  <span><b>{day(r.buy.time)}</b><small>{px(r.buy.price)}</small></span>
                  <span>{r.sell ? <><b>{day(r.sell.time)}</b><small>{px(r.sell.price)}</small></> : <span className="badge sig-good"><i />{t.acHolding}</span>}</span>
                  <span className={`bt-ret ${sign(r.ret)}`}>{pct(r.ret)}</span>
                </div>
              ))}
              {!rounds.length && <p className="bt-none">{t.btNoTrades}</p>}
            </div>
          </>
        ) : (
          <>
            <div className="bt-log-head"><span>{t.btDay}</span><span>{t.price}</span><span>{t.btSize}</span></div>
            <div className="bt-log-body">
              {buys.map((m) => (
                <div key={m.time} className="bt-log-row one">
                  <span><b>{day(m.time)}</b></span>
                  <span>{px(m.price)}</span>
                  <span className={`bt-ret ${(m.mult ?? 1) > 1 ? 'pos' : ''}`}>×{m.mult ?? 1}</span>
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

export default function Dock({ venue, coin, list, failed, sel, onSelect, onHire, onAsk, swaps }: {
  venue: 'cex' | 'dex'; coin: string; list: Agent[] | null; failed: boolean; sel: Agent | null;
  onSelect: (a: Agent | null) => void; onHire: (a: Agent) => void; onAsk: (a: Agent) => void; swaps?: ReactNode;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>(sel ? 'bt' : 'list');
  // Picking an agent opens its backtest; closing it goes back to the list.
  useEffect(() => { setTab((cur) => (sel ? 'bt' : cur === 'bt' ? 'list' : cur)); }, [sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const best = list ? recommend(list, { coin, level: readLevel() })?.pick.id : undefined;
  const hint = venue === 'dex' ? t.mkHintDex : isRunnable(coin) ? t.mkHintCex(coin) : t.mkHintSignal(coin);
  const note = tab === 'bt' && sel ? t.acFoot(`${(sel.fee * 100).toFixed(1)}%`, sel.days) : tab === 'list' ? hint : '';

  return (
    <section className="tdock" aria-label={t.mkTitle}>
      <header className="tdock-head">
        <div className="tdock-tabs has-line" role="tablist">
          <SlidePill dep={`${tab}-${sel?.id ?? ''}`} />
          <button role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>{t.mkTitle}</button>
          {sel && (
            <button role="tab" aria-selected={tab === 'bt'} className={tab === 'bt' ? 'on' : ''} onClick={() => setTab('bt')}>
              {t.btTab}<span className="tdock-tab-sub">{t.agRule[sel.rule]}</span>
            </button>
          )}
          {swaps && <button role="tab" aria-selected={tab === 'swaps'} className={tab === 'swaps' ? 'on' : ''} onClick={() => setTab('swaps')}>{t.recentSwaps}</button>}
        </div>
        <p className="tdock-note">{note}</p>
        {tab === 'bt' && sel && <button className="icon-btn sm" onClick={() => onSelect(null)} aria-label={t.btBack} data-tip={t.btBack}><Icon name="close" size={16} /></button>}
      </header>

      <div className="tdock-body">
        {tab === 'list' && (
          <div className="frows stagger" key={`${venue}-${coin}`}>
            <div className="frow-head" aria-hidden>
              <span>{t.thName}</span><span>{t.thState}</span><span>{t.thCurve}</span><span>{t.thEdge}</span><span>{t.thTotal}</span><span>{t.thDd}</span><span />
            </div>
            {failed && <p className="bt-none">{t.agFailed}</p>}
            {!list && !failed && [0, 1, 2, 3].map((i) => <div key={i} className="frow skel-block" aria-hidden />)}
            {list?.map((a) => <AgentCard key={a.id} agent={a} size="tile" picked={sel?.id === a.id} best={a.id === best} onPick={() => onSelect(a)} />)}
          </div>
        )}
        {tab === 'bt' && sel && <Backtest a={sel} onHire={onHire} onAsk={onAsk} />}
        {tab === 'swaps' && swaps}
      </div>
    </section>
  );
}
