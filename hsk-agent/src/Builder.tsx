// "Make an agent": four steps, one short question each, with the agent taking shape on the right as you go.
//  1. Coin. 2. Where to start: a published strategy (shown with how it did on that coin), your own words, or an
//  empty rule. 3. The rule: when to buy and when to sell, each "this is above/below that". 4. Name it and save.
// Few words, big type: each step is one friendly question; anything needed only sometimes sits behind an (i).
// The right-hand card is the agent so far, drawn against the line it has to beat: the coin bought three years ago
// and simply held. Before a rule exists that line is all it shows; after, it is the same backtest every other agent
// gets (scoreMade), rerun on every change. Saving puts the agent in the maker's account (madeStore); from there it
// shows up under its coin's chart with the full backtest and replay, and is hired through the same sheet as any other.
// Nothing here decides with a model: the sentence reader is a fixed set of patterns, and the rule is plain data.
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import * as cex from './cex.ts';
import { HORIZON, HORIZONS, SIGNAL_MARKETS, dailyHistory, isRunnable, scoreMade, type Agent, type RuleId } from './agents.ts';
import { MAX_CONDS, TEMPLATE_IDS, TERM_KINDS, TERM_N, fromTemplate, parse, problems, scaleOf, type Cond, type MadeSpec, type Term, type TermKind } from './spec.ts';
import { MADE_PREFIX, newMadeId, removeMade, saveMade, useMade } from './madeStore.ts';
import { useSession } from './account.ts';
import { useT, type Lang, type Strings } from './i18n.ts';
import { Face, condText, drop, pct } from './AgentCard.tsx';
import { moneyText } from './Dock.tsx';
import { CoinMark } from './CoinMark.tsx';
import { Icon, type IconName } from './Icons.tsx';
import { RollNum } from './motion.tsx';
import { useToast } from './ui.tsx';

/** What the builder is asked to open with: a sentence already read, a coin, or a saved agent to change. */
export interface BuildDraft { n: number; text?: string; coin?: string; editId?: string }

type Draft = Pick<MadeSpec, 'buy' | 'sell' | 'name' | 'market'> & { id?: string; from?: MadeSpec['from'] };
type Mode = 'classic' | 'words' | 'blank';
type Step = 0 | 1 | 2 | 3;
type Pt = { time: number; value: number };
const P: Term = { k: 'price' };
const T = (k: TermKind, n: number): Term => ({ k, n });
const blank = (market: string): Draft => ({ market, name: '', buy: [{ a: P, op: 'above', b: T('sma', 200) }], sell: [] });
const marketFor = (coin?: string) => SIGNAL_MARKETS.find((m) => m.base === coin) ?? SIGNAL_MARKETS[0];
const RUNNABLE = SIGNAL_MARKETS.filter((m) => isRunnable(m.base));
/** The published strategies this builder can start from, grouped by how long they are built to hold. */
const GROUPS = HORIZONS.map((key) => ({ key, ids: TEMPLATE_IDS.filter((r) => r !== 'made' && HORIZON[r] === key) })).filter((g) => g.ids.length);
const MODE_ICON: Record<Mode, IconName> = { classic: 'medal', words: 'chat', blank: 'edit' };
/** One-tap conditions, in the order of their friendly names (bqQuickBuy / bqQuickSell). */
const QUICK_BUY: Cond[] = [
  { a: P, op: 'above', b: T('sma', 200) },
  { a: T('rsi', 14), op: 'below', b: T('num', 30) },
  { a: P, op: 'above', b: T('high', 20) },
  { a: T('ret', 28), op: 'above', b: T('num', 0) },
];
const QUICK_SELL: Cond[] = [
  { a: P, op: 'below', b: T('sma', 50) },
  { a: T('rsi', 14), op: 'above', b: T('num', 70) },
  { a: P, op: 'below', b: T('low', 10) },
];
const sameCond = (x: Cond, y: Cond) => JSON.stringify(x) === JSON.stringify(y);
/** The line to beat on a coin: buying at the start of the three-year window and holding. Read off the same backtest
 *  every agent gets (its `bench` and `hold`), so the numbers match what the agent is later compared with. */
const lineToBeat = (m: cex.Market, bars: cex.Candle[]): Agent | null => {
  const x = fromTemplate('trend200');
  return x ? scoreMade({ id: 'hold', name: '', market: m.symbol, ...x, createdAt: 0 }, m, bars) : null;
};
const thin = (pts: Pt[], n: number) => pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / n)) === 0 || i === pts.length - 1);

/** A condition as a plain sentence ("200일 평균선이 가격보다…"), with its two things in bold. */
function Say({ c }: { c: Cond }) {
  const { t } = useT();
  const a = t.bqTerm(c.a.k, c.a.n), b = t.bqTerm(c.b.k, c.b.n, c.a.k === 'ret');
  const s = t.bqSay(a, c.op === 'above', b);
  const at = s.indexOf(b, a.length);
  if (!s.startsWith(a) || at < 0) return <span className="bd-say">{s}</span>;
  return <span className="bd-say"><b>{a}</b>{s.slice(a.length, at)}<b>{b}</b>{s.slice(at + b.length)}</span>;
}
const usesRsi = (cs: Cond[]) => cs.some((c) => c.a.k === 'rsi' || c.b.k === 'rsi');

/** A small (i): the words that are needed only sometimes. */
function Info({ text }: { text: string }) {
  return (
    <span className="bd-i" tabIndex={0} role="img" aria-label={text} data-tip={text}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7.2v3.6M8 5.2v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    </span>
  );
}

/** The agent's money against just holding over the same days. */
function Duo({ eq, bench, lang }: { eq?: Pt[]; bench: Pt[]; lang: Lang }) {
  const gid = `bd${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const W = 600, H = 200;
  if (bench.length < 2) return null;
  const t0 = bench[0].time, t1 = bench[bench.length - 1].time, span = t1 - t0 || 1;
  const e = eq ? thin(eq, 240) : [], b = thin(bench, 240);
  const vals = [...e, ...b].map((p) => p.value);
  const lo = Math.min(1, ...vals), hi = Math.max(1, ...vals), r = hi - lo || 1;
  const x = (tm: number) => ((tm - t0) / span) * W;
  const y = (v: number) => H - 8 - ((v - lo) / r) * (H - 16);
  const line = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const date = (tm: number) => new Date(tm * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'short' });
  const sig = e.length ? `${e.length}:${e[e.length - 1].value.toFixed(4)}` : 'hold';
  const solo = e.length < 2;
  return (
    <figure className={`bd-duo${solo ? ' solo' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".16" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient>
        </defs>
        <line className="bd-duo-base" x1={0} x2={W} y1={y(1)} y2={y(1)} vectorEffect="non-scaling-stroke" />
        {solo && <path className="bd-duo-area" d={`${line(b)}L${W},${H}L0,${H}Z`} fill={`url(#${gid})`} />}
        <path className="bd-duo-hold" d={line(b)} vectorEffect="non-scaling-stroke" />
        {!solo && <path key={`a${sig}`} className="bd-duo-area" d={`${line(e)}L${W},${H}L0,${H}Z`} fill={`url(#${gid})`} />}
        {!solo && <path key={sig} className="bd-duo-eq draw" pathLength={1} d={line(e)} vectorEffect="non-scaling-stroke" />}
      </svg>
      <figcaption><span>{date(t0)}</span><span>{date(t1)}</span></figcaption>
    </figure>
  );
}

/** A small curve for a coin card. */
function Spark({ pts }: { pts: Pt[] }) {
  const W = 96, H = 28;
  if (pts.length < 2) return null;
  const xs = thin(pts, 60), v = xs.map((p) => p.value), lo = Math.min(...v), r = Math.max(...v) - lo || 1;
  const d = xs.map((p, i) => `${i ? 'L' : 'M'}${((i / (xs.length - 1)) * W).toFixed(1)},${(H - 2 - ((p.value - lo) / r) * (H - 4)).toFixed(1)}`).join('');
  return <svg className="bd-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden><path d={d} vectorEffect="non-scaling-stroke" /></svg>;
}

/** One side of a condition, as one token: what kind of thing, and its number of days (or the number itself). */
function TermEdit({ value, onChange, other }: { value: Term; onChange: (t: Term) => void; other?: Term }) {
  const { t } = useT();
  const range = TERM_N[value.k];
  // Only things measured the same way as the other side are offered (a price against a price, RSI against a number…).
  const fits = (k: TermKind) => { if (!other) return k !== 'num'; const left = scaleOf(other.k); return left === 'price' ? scaleOf(k) === 'price' : k === 'num' || scaleOf(k) === left; };
  const bad = range && !(Number.isFinite(value.n) && value.n! >= range.min && value.n! <= range.max);
  return (
    <span className={`bd-tok${value.k === 'num' ? ' num' : ''}${bad ? ' bad' : ''}`}>
      {/* The select sizes to the chosen label (a hidden copy under it), not to its longest option. */}
      <span className="bd-tok-k">
        <span aria-hidden>{t.bqKind[value.k]}</span>
        <select value={value.k} aria-label={t.bqKind[value.k]} onChange={(e) => { const k = e.target.value as TermKind; onChange({ k, n: TERM_N[k]?.dflt }); }}>
          {TERM_KINDS.filter((k) => k === value.k || fits(k)).map((k) => <option key={k} value={k}>{t.bqKind[k]}</option>)}
        </select>
      </span>
      {range && (
        <label className="bd-tok-n">
          <input type="number" inputMode="decimal" value={Number.isFinite(value.n) ? value.n : ''} min={range.min} max={range.max} step={value.k === 'num' ? 'any' : 1}
            style={{ width: `${Math.max(2, String(Number.isFinite(value.n) ? value.n : '').length) + 1.6}ch` }}
            onChange={(e) => onChange({ ...value, n: e.target.value === '' ? NaN : Number(e.target.value) })} aria-label={t.bqKind[value.k]} />
          {value.k !== 'num' && <span>{t.cuDays}</span>}
        </label>
      )}
    </span>
  );
}

/** One side of the rule: its sentences, one-tap additions, and (when asked for) the detailed editor. */
function RuleSide({ list, onChange, side, adv, quick, quickNames, t, lang }: {
  list: Cond[]; onChange: (cs: Cond[]) => void; side: 'buy' | 'sell'; adv: boolean; quick: Cond[]; quickNames: string[]; t: Strings; lang: Lang;
}) {
  const set = (i: number, c: Cond) => onChange(list.map((x, k) => (k === i ? c : x)));
  const offer = quick.map((q, i) => ({ q, name: quickNames[i] })).filter(({ q }) => !list.some((c) => sameCond(c, q)));
  return (
    <section className={`bd-side ${side}`}>
      <h3><span className={`wz-tag ${side}`}>{side === 'buy' ? t.cuBuy : t.cuSell}</span>{usesRsi(list) && <Info text={t.bqRsiTip} />}</h3>
      {list.length > 0 && (
        <ol className="bd-conds">
          {list.map((c, i) => {
            const a = <TermEdit key="a" value={c.a} onChange={(a) => { const keep = scaleOf(a.k) === scaleOf(c.b.k) || scaleOf(c.b.k) === 'any'; set(i, { ...c, a, b: keep ? c.b : scaleOf(a.k) === 'price' ? T('sma', 50) : T('num', a.k === 'rsi' ? 30 : 0) }); }} />;
            const b = <TermEdit key="b" value={c.b} other={c.a} onChange={(b) => set(i, { ...c, b })} />;
            const op = (
              <button key="op" type="button" className="bd-op" onClick={() => set(i, { ...c, op: c.op === 'above' ? 'below' : 'above' })}>
                {c.op === 'above' ? t.bqAbove : t.bqBelow}
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M4 2v8M2 4l2-2 2 2M8 10V2M6 8l2 2 2-2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            );
            return (
              <li key={i} className="bd-cond">
                {i > 0 && <span className="bd-join">{side === 'buy' ? t.cuAnd : t.cuOr}</span>}
                <div className={`bd-cond-box${adv ? ' adv' : ''}`}>
                  {adv
                    ? <div className="bd-cond-line">{a}<span className="bd-cond-tail">{lang === 'ko' ? [b, op] : [op, b]}</span></div>
                    : <Say c={c} />}
                  <button type="button" className="icon-btn bd-cond-x" onClick={() => onChange(list.filter((_, k) => k !== i))} aria-label={t.buRemove} data-tip={t.buRemove}><Icon name="close" size={16} /></button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {!list.length && side === 'sell' && <p className="bd-side-empty">{t.bqSellAuto}</p>}
      {list.length < MAX_CONDS && (
        <div className="bd-quick">
          {offer.map(({ q, name }) => <button type="button" key={name} className="bd-chip" onClick={() => onChange([...list, structuredClone(q)])}><Icon name="plus" size={14} />{name}</button>)}
          {adv && <button type="button" className="bd-chip ghost" onClick={() => onChange([...list, { a: P, op: side === 'buy' ? 'above' : 'below', b: T('sma', 50) }])}><Icon name="plus" size={14} />{t.buAdd}</button>}
        </div>
      )}
    </section>
  );
}

export default function Builder({ draft, onOpen }: { draft: BuildDraft | null; onOpen: (a: Agent) => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const mine = useMade();
  const signedIn = !!useSession();
  const [d, setD] = useState<Draft>(() => blank(marketFor(draft?.coin).symbol));
  const [step, setStep] = useState<Step>(0);
  const [mode, setMode] = useState<Mode>('classic');
  /** The detailed editor of the rule step, folded away until asked for. */
  const [adv, setAdv] = useState(false);
  /** True once there is a rule worth previewing: a strategy was picked, a sentence was read, or the user chose to start empty. */
  const [started, setStarted] = useState(false);
  const [words, setWords] = useState('');
  const [read, setRead] = useState<{ ok: number; unknown: string[] } | null>(null);
  const market = cex.MARKETS.find((m) => m.symbol === d.market) ?? SIGNAL_MARKETS[0];

  const readWords = (text: string, into: Draft) => {
    const p = parse(text);
    setRead({ ok: p.buy.length + p.sell.length, unknown: p.unknown });
    if (!p.buy.length) return into;
    setStarted(true);
    return { ...into, buy: p.buy, sell: p.sell, from: undefined };
  };
  const reset = (symbol: string) => { setD(blank(symbol)); setWords(''); setRead(null); setStarted(false); setMode('classic'); setAdv(false); setStep(0); };
  // Opened from somewhere else: with a sentence Moa was given, on the coin on screen, or to change a saved agent.
  useEffect(() => {
    if (!draft) return;
    const saved = draft.editId ? mine.find((s) => s.id === draft.editId) : undefined;
    if (saved) { setD({ ...saved }); setWords(''); setRead(null); setStarted(true); setStep(2); return; }
    let next = blank(marketFor(draft.coin).symbol);
    if (draft.text) {
      setWords(draft.text); setMode('words');
      const p = parse(draft.text);
      next = readWords(draft.text, next);
      setStep(p.buy.length ? 2 : 1);
    } else { setWords(''); setRead(null); setStarted(false); setMode('classic'); setStep(draft.coin ? 1 : 0); }
    setD(next);
  }, [draft?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // The backtest, rerun whenever the rule or the coin changes. A failed load is told apart from too little history.
  const [tries, setTries] = useState(0);
  const [bars, setBars] = useState<{ symbol: string; list: cex.Candle[]; failed?: boolean } | null>(null);
  useEffect(() => { let alive = true; dailyHistory(market).then((list) => alive && setBars({ symbol: market.symbol, list }), () => alive && setBars({ symbol: market.symbol, list: [], failed: true })); return () => { alive = false; }; }, [market.symbol, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = bars?.symbol === market.symbol ? bars.list : null;
  const failed = bars?.symbol === market.symbol && !!bars.failed;
  const issues = useMemo(() => problems(d), [d]);
  const blocking = issues.filter((x) => x !== 'name');
  const result = useMemo(() => {
    if (!ready || blocking.length) return null;
    return scoreMade({ id: d.id ?? 'draft', name: d.name, market: d.market, buy: d.buy, sell: d.sell, createdAt: 0 }, market, ready);
  }, [ready, d.buy, d.sell, d.market, blocking.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const beat = useMemo(() => (ready ? lineToBeat(market, ready) : null), [ready, market.symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  /** How each published strategy did on this coin, so the choice in step 2 is made with numbers in view. */
  const shelf = useMemo(() => {
    const out: Partial<Record<RuleId, Agent | null>> = {};
    if (!ready) return out;
    for (const id of TEMPLATE_IDS) {
      const x = fromTemplate(id);
      out[id] = x ? scoreMade({ id: 'shelf', name: '', market: market.symbol, ...x, createdAt: 0 }, market, ready) : null;
    }
    return out;
  }, [ready, market.symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  // The coins on the first step each show their own line to beat.
  const [lines, setLines] = useState<Record<string, Agent | null | 'fail'>>({});
  useEffect(() => {
    if (step !== 0) return;
    for (const m of RUNNABLE) {
      if (lines[m.symbol] && lines[m.symbol] !== 'fail') continue;
      dailyHistory(m).then((list) => setLines((c) => ({ ...c, [m.symbol]: lineToBeat(m, list) })), () => setLines((c) => ({ ...c, [m.symbol]: 'fail' })));
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoName = `${market.base} ${d.from ? `${t.agNick[d.from]}+` : t.wzMineName}`;
  const top = () => window.scrollTo({ top: 0 });
  const pickCoin = (symbol: string) => { setD((cur) => ({ ...cur, market: symbol })); setStep(1); top(); };
  const pickTemplate = (r: RuleId) => { const x = fromTemplate(r); if (!x) return; setD((cur) => ({ ...cur, ...x, from: r, name: cur.id ? cur.name : '' })); setRead(null); setStarted(true); };
  const startBlank = () => { setMode('blank'); setD((cur) => ({ ...blank(cur.market), id: cur.id, name: cur.name })); setRead(null); setStarted(true); setStep(2); top(); };
  const go = (n: Step) => { if (n === 3 && !d.name.trim()) setD((cur) => ({ ...cur, name: autoName })); setStep(n); top(); };
  const canNext = step === 0 ? true : step === 1 ? started && !blocking.length : step === 2 ? !blocking.length : false;
  const reach = (n: Step) => n <= step || (n === 1) || (started && !blocking.length);

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
  const name = d.name.trim() || autoName;
  const retry = () => setTries((n) => n + 1);
  const detail = result ? `${t.bqDetail(drop(result.maxDd), result.trades, `${(result.fee * 100).toFixed(1)}%`)}. ${t.bqPast}` : '';

  const nav = (
    <footer className="bd-nav">
      {step > 0 ? <button type="button" className="btn bd-back" aria-label={t.wzBack} onClick={() => go((step - 1) as Step)}><Icon name="chevron" size={16} /><span>{t.wzBack}</span></button> : <span />}
      {step < 3 && <button type="button" className="btn-primary" disabled={!canNext} onClick={() => go((step + 1) as Step)}>{t.wzNext}<Icon name="chevron" size={16} /></button>}
      {step === 3 && (
        <div className="bd-nav-save">
          <button type="button" className="btn-text" disabled={!!issues.length} onClick={() => save(false)} data-tip={signedIn ? t.wzAccountIn : t.wzAccountGuest}>{t.bqSaveOnly}</button>
          <button type="button" className="btn-primary" disabled={!!issues.length} onClick={() => save(!!result)}>{d.id ? t.buUpdate : t.bqSave}</button>
        </div>
      )}
    </footer>
  );
  const panel = (title: string, body: ReactNode) => (
    <section className="bd-panel" key={step} aria-labelledby="bd-step-title">
      <h2 id="bd-step-title">{title}</h2>
      <div className="bd-body">{body}</div>
      {nav}
    </section>
  );

  /* ---------- the agent so far: name, one big number, the chart, one line ---------- */
  const busy = <div className="bd-proof-wait" role="status"><span className="bd-skel" aria-hidden /><p><span className="spin" aria-hidden />{t.bqWorking}</p></div>;
  const failBox = <div className="bd-proof-fail" role="alert"><p>{t.bqLoadFail}</p><button type="button" className="btn" onClick={retry}>{t.retry}</button></div>;
  const big = (v: number, tot: number) => (
    <div className="bd-big">
      <small>{t.bqIf(moneyText(lang, amount))}</small>
      <div><b><RollNum text={moneyText(lang, amount * (1 + v))} /></b><em className={tot >= 0 ? 'pos' : 'neg'}>{pct(tot)}</em></div>
    </div>
  );
  const proofBody = !started ? (
    failed ? failBox : !beat ? (ready ? <p className="bd-verdict warn">{t.bqNoData}</p> : busy) : (
      <>
        {big(beat.hold, beat.hold)}
        <Duo bench={beat.bench} lang={lang} />
        <p className="bd-verdict beat">{t.bqBeatLine}</p>
      </>
    )
  ) : failed ? failBox : !ready ? busy : blocking.length ? <p className="bd-verdict warn">{t.buProblem[blocking[0]]}</p> : !result ? <p className="bd-verdict warn">{t.bqNoData}</p> : (
    <>
      {big(result.total, result.total)}
      <Duo eq={result.equity} bench={result.bench} lang={lang} />
      <div className="bd-legend"><span className="me"><i aria-hidden />{t.btAgent}</span><span className="hold"><i aria-hidden />{t.bqHoldLegend(pct(result.hold))}</span></div>
      <p className={`bd-verdict ${edge >= 0 ? 'ahead' : 'behind'}`}><span>{edge >= 0 ? t.bqAhead(pct(edge)) : t.bqBehind}</span><Info text={detail} /></p>
    </>
  );
  const proof = (
    <aside className={`bd-proof${started ? '' : ' is-beat'}`} aria-label={t.wzPreview} aria-live="polite">
      {!started && <span className="bd-eyebrow">{t.wzBeat}</span>}
      <div className="bd-who">
        {started ? <Face rule={d.from ?? 'made'} base={market.base} size="lg" /> : <CoinMark base={market.base} big />}
        <b>{started ? name : market.base}</b>
      </div>
      {proofBody}
    </aside>
  );
  // On a narrow screen the card sits under the step; this strip keeps its answer in view while the rule is edited.
  const strip = (
    <div className="bd-strip" aria-hidden>
      {started ? <Face rule={d.from ?? 'made'} base={market.base} size="sm" /> : <CoinMark base={market.base} />}
      <b>{started ? name : market.base}</b>
      {result && started && !blocking.length
        ? <><em className={result.total >= 0 ? 'pos' : 'neg'}>{pct(result.total)}</em><span className={`bd-strip-edge ${edge >= 0 ? 'ahead' : 'behind'}`}>{t.bqHoldLegend(pct(result.hold))}</span></>
        : <small>{failed ? t.bqLoadFail : !ready ? t.bqWorking : blocking.length ? t.buProblem[blocking[0]] : started ? t.bqNoData : ''}</small>}
    </div>
  );

  return (
    <div className="page build-page">
      <div className="bd-top">
        <ol className="bd-steps" aria-label={t.buTitle}>
          {t.wzSteps.map((label, i) => (
            <li key={label} className={i === step ? 'now' : i < step ? 'done' : ''}>
              <button type="button" disabled={!reach(i as Step)} onClick={() => go(i as Step)} aria-current={i === step ? 'step' : undefined}>
                <span className="bd-steps-bar" aria-hidden />
                <span className="bd-steps-k">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
                <b>{label}</b>
              </button>
            </li>
          ))}
        </ol>
        {(started || d.id) && <button type="button" className="btn bd-new" onClick={() => reset(d.market)}><Icon name="plus" size={16} />{t.buNew}</button>}
      </div>

      {step > 0 && strip}

      <div className="bd-grid">
        {step === 0 && panel(t.bqCoin, (
          <>
            <div className="bd-coins" role="radiogroup" aria-label={t.buCoin}>
              {RUNNABLE.map((m) => {
                const l = lines[m.symbol];
                const on = m.symbol === d.market;
                return (
                  <button type="button" key={m.symbol} role="radio" aria-checked={on} className={`bd-coin${on ? ' on' : ''}`} onClick={() => pickCoin(m.symbol)}>
                    <span className="bd-coin-top"><CoinMark base={m.base} big /><b>{m.base}</b><span className="bd-radio" aria-hidden /></span>
                    <span className="bd-coin-chart">{l && l !== 'fail' ? <Spark pts={l.bench} /> : l === undefined ? <span className="bd-skel thin" aria-hidden /> : null}</span>
                    <span className="bd-coin-foot">
                      <small>{t.bqHeld}</small>
                      {l && l !== 'fail' ? <b className={l.hold >= 0 ? 'pos' : 'neg'}>{pct(l.hold)}</b> : l === undefined ? <span className="spin" aria-hidden /> : <b>—</b>}
                    </span>
                  </button>
                );
              })}
            </div>
            <details className="bd-others" open={!isRunnable(market.base)}>
              <summary>{t.bqOthers}<Icon name="down" size={16} /></summary>
              <div className="bd-chips">
                {SIGNAL_MARKETS.filter((m) => !isRunnable(m.base)).map((m) => <button type="button" key={m.symbol} className={`bd-chip${m.symbol === d.market ? ' on' : ''}`} aria-pressed={m.symbol === d.market} onClick={() => pickCoin(m.symbol)}><CoinMark base={m.base} />{m.base}</button>)}
                <Info text={t.wzOtherSub} />
              </div>
            </details>
          </>
        ))}

        {step === 1 && panel(t.bqStart, (
          <>
            <div className="bd-modes">
              {(['classic', 'words', 'blank'] as Mode[]).map((m) => (
                <button type="button" key={m} aria-pressed={mode === m} className={mode === m ? 'on' : ''} onClick={() => (m === 'blank' ? startBlank() : setMode(m))}>
                  <span className="bd-modes-ic"><Icon name={MODE_ICON[m]} size={20} /></span>
                  <b>{t.bqModes[m]}</b>
                </button>
              ))}
            </div>
            {!isRunnable(market.base) && <p className="bd-alert warn">{t.buDemo(market.base)}</p>}

            {mode !== 'words' && (
              <div className="bd-shelf">
                {GROUPS.map((g, gi) => (
                  <div key={g.key} className="bd-group" role="radiogroup" aria-label={t.hz[g.key]}>
                    <h3><span>{t.hz[g.key]}</span>{gi === 0 && <small>{t.bq3y}</small>}</h3>
                    <div className="bd-cards">
                      {g.ids.map((r) => {
                        const s = shelf[r];
                        const on = d.from === r && started;
                        return (
                          <button type="button" key={r} role="radio" aria-checked={on} className={`bd-card${on ? ' on' : ''}`} onClick={() => pickTemplate(r)}>
                            <span className="bd-card-top">
                              <Face rule={r} size="sm" />
                              <b>{t.agNick[r]}</b>
                              <span className="bd-card-num">{!ready ? (failed ? '—' : <span className="spin" aria-hidden />) : s ? <em className={s.total >= 0 ? 'pos' : 'neg'}>{pct(s.total)}</em> : '—'}</span>
                            </span>
                            {on && <span className="bd-card-line">{t.agLine[r]}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {mode === 'words' && (
              <div className="bd-words">
                <form className="bd-compose" onSubmit={(e) => { e.preventDefault(); setD(readWords(words, d)); }}>
                  <textarea value={words} onChange={(e) => setWords(e.target.value)} placeholder={t.bqWordsPh} aria-label={t.bqModes.words} rows={3}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && words.trim()) { e.preventDefault(); setD(readWords(words, d)); } }} />
                  <div className="bd-compose-bar"><button className="btn-primary" type="submit" disabled={!words.trim()}>{t.bqRead}</button></div>
                </form>
                <div className="bd-quick">
                  {t.wzExamples.map((x) => <button type="button" key={x} className="bd-chip" onClick={() => { setWords(x); setD(readWords(x, d)); }}>{x}</button>)}
                </div>
                {read && <p className={`bd-alert${read.ok ? ' ok' : ' warn'}`}>{read.ok ? t.bqReadOk(read.ok) : t.bqReadNo}{read.ok > 0 && read.unknown.length > 0 && <Info text={read.unknown.map((x) => t.buReadPart(x)).join(' ')} />}</p>}
                {read && read.ok > 0 && (
                  <ul className="bd-reads">
                    {d.buy.map((c, i) => <li key={`b${i}`}><span className="wz-tag buy">{t.cuBuy}</span><Say c={c} /></li>)}
                    {d.sell.map((c, i) => <li key={`s${i}`}><span className="wz-tag sell">{t.cuSell}</span><Say c={c} /></li>)}
                  </ul>
                )}
              </div>
            )}
          </>
        ))}

        {step === 2 && panel(t.bqRule, (
          <>
            <RuleSide side="buy" list={d.buy} onChange={(buy) => setD({ ...d, buy })} adv={adv} quick={QUICK_BUY} quickNames={t.bqQuickBuy} t={t} lang={lang} />
            <RuleSide side="sell" list={d.sell} onChange={(sell) => setD({ ...d, sell })} adv={adv} quick={QUICK_SELL} quickNames={t.bqQuickSell} t={t} lang={lang} />
            {blocking.map((x) => <p key={x} className="bd-alert warn" role="alert">{t.buProblem[x]}</p>)}
            <button type="button" className={`bd-adv${adv ? ' on' : ''}`} aria-expanded={adv} onClick={() => setAdv((v) => !v)}><Icon name={adv ? 'check' : 'edit'} size={16} />{adv ? t.bqSimple : t.bqAdvanced}</button>
          </>
        ))}

        {step === 3 && panel(t.bqName, (
          <>
            <label className="bd-name">
              <Face rule={d.from ?? 'made'} base={market.base} />
              <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value.slice(0, 40) })} placeholder={autoName} maxLength={40} aria-label={t.buName} />
            </label>
            <p className="bd-review">
              <CoinMark base={market.base} /><b>{market.base}</b><span>·</span><span>{t.wzCondCount(d.buy.length + d.sell.length)}</span>
              <button type="button" className="btn-text" onClick={() => go(2)}>{t.buEdit}</button>
            </p>
            {result && result.trades < 5 && <p className="bd-alert warn">{t.bqFew(result.trades)}</p>}
          </>
        ))}

        {proof}
      </div>

      <section className="bd-mine" aria-labelledby="bd-mine-title">
        <header><h2 id="bd-mine-title">{t.buMine}</h2>{mine.length > 0 && <span className="bd-count">{mine.length}</span>}</header>
        {!mine.length ? <p className="bd-mine-empty">{t.buMineEmpty}</p> : (
          <ul className="bd-mine-list">
            {mine.map((s) => {
              const m = cex.MARKETS.find((x) => x.symbol === s.market);
              return (
                <li key={s.id} className={d.id === s.id ? 'on' : ''}>
                  <Face rule={s.from ?? 'made'} size="sm" />
                  <span className="bd-mine-name"><b>{s.name}</b><small>{m && <CoinMark base={m.base} />}{m?.base} · {s.buy.map((c) => condText(t, c)).join(` ${t.cuAnd} `)}</small></span>
                  <span className="bd-mine-act">
                    <button type="button" className="btn" onClick={() => { setD({ ...s }); setWords(''); setRead(null); setStarted(true); setStep(2); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{t.buEdit}</button>
                    <button type="button" className="btn" onClick={async () => { if (!m) return; const a = scoreMade(s, m, await dailyHistory(m)); if (a) onOpen(a); }}>{t.buOpen}</button>
                    <button type="button" className="icon-btn" onClick={() => { removeMade(s.id); if (d.id === s.id) setD({ ...d, id: undefined }); }} aria-label={t.buDelete} data-tip={t.buDelete}><Icon name="trash" size={18} /></button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
