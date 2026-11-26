// "Make an agent": one screen, three steps, and the result always in view.
//  1. Where to start: the coin, then a published strategy to change, or a sentence to read.
//  2. The rule: a few conditions, each "this is above/below that", edited in place.
//  3. What it would have done: the same backtest every other agent gets, rerun on every change.
// Saving puts the agent in the maker's account (madeStore); from there it shows up under its coin's chart with
// the full backtest and replay, and is hired through the same sheet as any other agent. Nothing here decides
// with a model: the sentence reader is a fixed set of patterns, and the rule is plain data run by spec.ts.
import { useEffect, useMemo, useState } from 'react';
import * as cex from './cex.ts';
import { SIGNAL_MARKETS, dailyHistory, isRunnable, scoreMade, type Agent } from './agents.ts';
import { MAX_CONDS, TEMPLATE_IDS, TERM_KINDS, TERM_N, fromTemplate, parse, problems, scaleOf, type Cond, type MadeSpec, type Term, type TermKind } from './spec.ts';
import { MADE_PREFIX, newMadeId, removeMade, saveMade, useMade } from './madeStore.ts';
import { useT } from './i18n.ts';
import { Equity, Face, condText, drop, pct } from './AgentCard.tsx';
import { moneyText } from './Dock.tsx';
import { CoinMark } from './CoinMark.tsx';
import { Icon } from './Icons.tsx';
import { useToast } from './ui.tsx';

/** What the builder is asked to open with: a sentence already read, a coin, or a saved agent to change. */
export interface BuildDraft { n: number; text?: string; coin?: string; editId?: string }

type Draft = Pick<MadeSpec, 'buy' | 'sell' | 'name' | 'market'> & { id?: string; from?: MadeSpec['from'] };
const P: Term = { k: 'price' };
const blank = (market: string): Draft => ({ market, name: '', buy: [{ a: P, op: 'above', b: { k: 'sma', n: 200 } }], sell: [] });
const marketFor = (coin?: string) => SIGNAL_MARKETS.find((m) => m.base === coin) ?? SIGNAL_MARKETS[0];

/** One side of a condition: what kind of thing, and its number of days (or the number itself). */
function TermEdit({ value, onChange, other }: { value: Term; onChange: (t: Term) => void; other?: Term }) {
  const { t } = useT();
  const range = TERM_N[value.k];
  // Only things measured the same way as the other side are offered (a price against a price, RSI against a number…).
  const fits = (k: TermKind) => { if (!other) return k !== 'num'; const left = scaleOf(other.k); return left === 'price' ? scaleOf(k) === 'price' : k === 'num' || scaleOf(k) === left; };
  return (
    <span className="term">
      <select value={value.k} aria-label={t.termKind[value.k]} onChange={(e) => { const k = e.target.value as TermKind; onChange({ k, n: TERM_N[k]?.dflt }); }}>
        {TERM_KINDS.filter((k) => k === value.k || fits(k)).map((k) => <option key={k} value={k}>{t.termKind[k]}</option>)}
      </select>
      {range && (
        <label className="term-n">
          <input type="number" value={Number.isFinite(value.n) ? value.n : ''} min={range.min} max={range.max} step={value.k === 'num' ? 'any' : 1}
            onChange={(e) => onChange({ ...value, n: e.target.value === '' ? NaN : Number(e.target.value) })} aria-label={t.termKind[value.k]} />
          {value.k !== 'num' && <span>{t.cuDays}</span>}
        </label>
      )}
    </span>
  );
}

function Conds({ list, onChange, head, empty }: { list: Cond[]; onChange: (cs: Cond[]) => void; head: string; empty?: string }) {
  const { t } = useT();
  const set = (i: number, c: Cond) => onChange(list.map((x, k) => (k === i ? c : x)));
  return (
    <div className="bu-conds">
      <h4>{head}</h4>
      {list.map((c, i) => (
        <div key={i} className="bu-cond">
          <TermEdit value={c.a} onChange={(a) => { const keep = scaleOf(a.k) === scaleOf(c.b.k) || scaleOf(c.b.k) === 'any'; set(i, { ...c, a, b: keep ? c.b : scaleOf(a.k) === 'price' ? { k: 'sma', n: 50 } : { k: 'num', n: a.k === 'rsi' ? 30 : 0 } }); }} />
          <select className="bu-op" value={c.op} onChange={(e) => set(i, { ...c, op: e.target.value as Cond['op'] })} aria-label={t.cuAbove}>
            <option value="above">{t.cuAbove}</option><option value="below">{t.cuBelow}</option>
          </select>
          <TermEdit value={c.b} other={c.a} onChange={(b) => set(i, { ...c, b })} />
          <button className="icon-btn sm" onClick={() => onChange(list.filter((_, k) => k !== i))} aria-label={t.buRemove} data-tip={t.buRemove}><Icon name="close" size={14} /></button>
        </div>
      ))}
      {!list.length && empty && <p className="bu-empty">{empty}</p>}
      {list.length < MAX_CONDS && <button className="btn-text bu-add" onClick={() => onChange([...list, { a: P, op: 'above', b: { k: 'sma', n: 50 } }])}><Icon name="plus" size={14} />{t.buAdd}</button>}
    </div>
  );
}

export default function Builder({ draft, onOpen }: { draft: BuildDraft | null; onOpen: (a: Agent) => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const mine = useMade();
  const [d, setD] = useState<Draft>(() => blank(marketFor(draft?.coin).symbol));
  const [words, setWords] = useState('');
  const [read, setRead] = useState<{ ok: number; unknown: string[] } | null>(null);
  const market = cex.MARKETS.find((m) => m.symbol === d.market) ?? SIGNAL_MARKETS[0];

  const readWords = (text: string, into: Draft) => {
    const p = parse(text);
    setRead({ ok: p.buy.length + p.sell.length, unknown: p.unknown });
    return p.buy.length ? { ...into, buy: p.buy, sell: p.sell, from: undefined } : into;
  };
  // Opened from somewhere else: with a sentence Moa was given, on the coin on screen, or to change a saved agent.
  useEffect(() => {
    if (!draft) return;
    const saved = draft.editId ? mine.find((s) => s.id === draft.editId) : undefined;
    if (saved) { setD({ ...saved }); setWords(''); setRead(null); return; }
    let next = blank(marketFor(draft.coin).symbol);
    if (draft.text) { setWords(draft.text); next = readWords(draft.text, next); } else { setWords(''); setRead(null); }
    setD(next);
  }, [draft?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // The backtest, rerun whenever the rule or the coin changes.
  const [bars, setBars] = useState<{ symbol: string; list: cex.Candle[] } | null>(null);
  useEffect(() => { let alive = true; dailyHistory(market).then((list) => alive && setBars({ symbol: market.symbol, list }), () => alive && setBars({ symbol: market.symbol, list: [] })); return () => { alive = false; }; }, [market.symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  const issues = useMemo(() => problems(d), [d]);
  const blocking = issues.filter((x) => x !== 'name');
  const result = useMemo(() => {
    if (!bars || bars.symbol !== market.symbol || blocking.length) return null;
    return scoreMade({ id: d.id ?? 'draft', name: d.name, market: d.market, buy: d.buy, sell: d.sell, createdAt: 0 }, market, bars.list);
  }, [bars, d.buy, d.sell, d.market, blocking.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (open: boolean) => {
    if (issues.length) return;
    const spec: MadeSpec = { id: d.id ?? newMadeId(), name: d.name.trim(), market: d.market, buy: d.buy, sell: d.sell, createdAt: Date.now(), from: d.from };
    saveMade(spec);
    setD({ ...spec });
    toast(t.buSaved(spec.name));
    if (open && result) onOpen({ ...result, id: MADE_PREFIX + spec.id, made: spec });
  };
  const amount = lang === 'ko' ? 1_000_000 : 1_000;
  const edge = result ? result.total - result.hold : 0;

  return (
    <div className="page build-page">
      <header className="page-head"><div><h1>{t.buTitle}</h1><p className="muted">{t.buSub}</p></div></header>

      <div className="bu-grid">
        <div className="bu-left">
          <section className="bu-card">
            <h3>{t.bu1}</h3>
            <div className="bu-row">
              <span className="bu-label">{t.buCoin}</span>
              <div className="bu-coins">
                {SIGNAL_MARKETS.map((m) => <button key={m.symbol} className={`fchip${m.symbol === d.market ? ' on' : ''}`} aria-pressed={m.symbol === d.market} onClick={() => setD({ ...d, market: m.symbol })}><CoinMark base={m.base} />{m.base}</button>)}
              </div>
            </div>
            {!isRunnable(market.base) && <p className="bu-note warn">{t.buDemo(market.base)}</p>}
            <div className="bu-row top">
              <span className="bu-label">{t.buStart}</span>
              <div className="bu-templates">
                {TEMPLATE_IDS.map((r) => <button key={r} className={`fchip${d.from === r ? ' on' : ''}`} onClick={() => { const x = fromTemplate(r); if (x) { setD({ ...d, ...x, from: r, name: d.name || `${market.base} ${t.agNick[r]}+` }); setRead(null); } }}>{t.agRule[r]}</button>)}
              </div>
            </div>
            <div className="bu-row top">
              <span className="bu-label">{t.buWords}</span>
              <form className="bu-words" onSubmit={(e) => { e.preventDefault(); setD(readWords(words, d)); }}>
                <input value={words} onChange={(e) => setWords(e.target.value)} placeholder={t.buWordsPh} aria-label={t.buWords} />
                <button className="btn" type="submit" disabled={!words.trim()}>{t.buRead}</button>
              </form>
            </div>
            {read && <p className={`bu-note${read.ok ? '' : ' warn'}`}>{read.ok ? t.buReadOk(read.ok) : t.buReadNo}{read.ok > 0 && read.unknown.map((x) => <span key={x}> {t.buReadPart(x)}</span>)}</p>}
          </section>

          <section className="bu-card">
            <h3>{t.bu2}{d.from && <span className="origin tier-1">{t.buFrom(t.agRule[d.from])}</span>}</h3>
            <Conds list={d.buy} onChange={(buy) => setD({ ...d, buy })} head={t.buBuyHead} />
            <Conds list={d.sell} onChange={(sell) => setD({ ...d, sell })} head={t.buSellHead} empty={t.buSellEmpty} />
            {blocking.map((x) => <p key={x} className="bu-note warn">{t.buProblem[x]}</p>)}
          </section>
        </div>

        <section className="bu-card bu-result">
          <h3>{t.bu3}</h3>
          {!bars ? <p className="bu-wait"><span className="spin" aria-hidden />{t.buWorking}</p>
            : blocking.length ? <p className="bu-wait">{t.buProblem[blocking[0]]}</p>
              : !result ? <p className="bu-wait">{t.buNoData}</p> : (
                <>
                  <div className="bu-money">
                    <div><small>{t.btIf(moneyText(lang, amount), false)}</small><b className={result.total >= 0 ? 'pos' : 'neg'}>{moneyText(lang, amount * (1 + result.total))}</b><em className={result.total >= 0 ? 'pos' : 'neg'}>{pct(result.total)}</em></div>
                    <div className="dim"><small>{t.btIfHold}</small><b>{moneyText(lang, amount * (1 + result.hold))}</b><em className={result.hold >= 0 ? 'pos' : 'neg'}>{pct(result.hold)}</em></div>
                  </div>
                  <Equity pts={result.equity} up={edge >= 0} wide />
                  <dl className="bu-stats">
                    <div><dt>{t.thEdge}</dt><dd className={edge >= 0 ? 'pos' : 'neg'}>{pct(edge)}</dd></div>
                    <div><dt>{t.thDd}</dt><dd>{drop(result.maxDd)}</dd></div>
                    <div><dt>{t.thTrades}</dt><dd>{t.btTimes(result.trades)}</dd></div>
                    <div><dt>{t.btHeldStat}</dt><dd>{Math.round(result.inMarket * 100)}%</dd></div>
                  </dl>
                  <p className="bu-note">{t.acFoot(`${(result.fee * 100).toFixed(1)}%`, result.days)}</p>
                  {result.trades < 5 && <p className="bu-note warn">{t.buFew(result.trades)}</p>}
                  <p className="bu-note warn">{t.buUnproven}</p>
                </>
              )}
          <div className="bu-save">
            <label className="bu-name"><span>{t.buName}</span><input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value.slice(0, 40) })} placeholder={t.buNamePh} /></label>
            <div className="bu-actions">
              <button className="btn-primary" disabled={!!issues.length || !result} onClick={() => save(true)}>{t.buSaveOpen}</button>
              <button className="btn" disabled={!!issues.length} onClick={() => save(false)}>{d.id ? t.buUpdate : t.buSave}</button>
              {d.id && <button className="btn-text" onClick={() => { setD(blank(d.market)); setWords(''); setRead(null); }}>{t.buNew}</button>}
            </div>
            <p className="bu-note">{t.buAccount}</p>
          </div>
        </section>
      </div>

      <section className="bu-mine">
        <h3>{t.buMine}</h3>
        {!mine.length && <p className="muted">{t.buMineEmpty}</p>}
        {mine.map((s) => {
          const m = cex.MARKETS.find((x) => x.symbol === s.market);
          return (
            <div key={s.id} className={`bu-mine-row${d.id === s.id ? ' on' : ''}`}>
              <Face rule="made" size="sm" />
              <span className="bu-mine-name"><b>{s.name}</b><small>{m?.base} · {s.buy.map((c) => condText(t, c)).join(` ${t.cuAnd} `)}</small></span>
              <button className="btn sm" onClick={() => { setD({ ...s }); setWords(''); setRead(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{t.buEdit}</button>
              <button className="btn sm" onClick={async () => { if (!m) return; const a = scoreMade(s, m, await dailyHistory(m)); if (a) onOpen(a); }}>{t.buOpen}</button>
              <button className="icon-btn sm" onClick={() => { removeMade(s.id); if (d.id === s.id) setD({ ...d, id: undefined }); }} aria-label={t.buDelete} data-tip={t.buDelete}><Icon name="trash" size={16} /></button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
