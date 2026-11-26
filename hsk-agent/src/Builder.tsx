// "Make an agent": four steps, one choice at a time, with the agent taking shape on the right as you go.
//  1. Coin. 2. Where to start: a published strategy (shown with how it did on that coin), your own words, or an
//  empty rule. 3. The rule: when to buy and when to sell, each "this is above/below that". 4. Name it and save.
// The right-hand card is the agent so far: what it reads as in a sentence, and the same backtest every other agent
// gets, rerun on every change. Saving puts the agent in the maker's account (madeStore); from there it shows up
// under its coin's chart with the full backtest and replay, and is hired through the same sheet as any other agent.
// Nothing here decides with a model: the sentence reader is a fixed set of patterns, and the rule is plain data.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as cex from './cex.ts';
import { HORIZON, HORIZONS, SIGNAL_MARKETS, dailyHistory, isRunnable, scoreMade, type Agent, type RuleId } from './agents.ts';
import { MAX_CONDS, TEMPLATE_IDS, TERM_KINDS, TERM_N, fromTemplate, parse, problems, scaleOf, type Cond, type MadeSpec, type Term, type TermKind } from './spec.ts';
import { MADE_PREFIX, newMadeId, removeMade, saveMade, useMade } from './madeStore.ts';
import { useSession } from './account.ts';
import { useT } from './i18n.ts';
import { Equity, Face, condText, drop, pct } from './AgentCard.tsx';
import { moneyText } from './Dock.tsx';
import { CoinMark } from './CoinMark.tsx';
import { Icon, type IconName } from './Icons.tsx';
import { useToast } from './ui.tsx';

/** What the builder is asked to open with: a sentence already read, a coin, or a saved agent to change. */
export interface BuildDraft { n: number; text?: string; coin?: string; editId?: string }

type Draft = Pick<MadeSpec, 'buy' | 'sell' | 'name' | 'market'> & { id?: string; from?: MadeSpec['from'] };
type Mode = 'classic' | 'words' | 'blank';
type Step = 0 | 1 | 2 | 3;
const P: Term = { k: 'price' };
const blank = (market: string): Draft => ({ market, name: '', buy: [{ a: P, op: 'above', b: { k: 'sma', n: 200 } }], sell: [] });
const marketFor = (coin?: string) => SIGNAL_MARKETS.find((m) => m.base === coin) ?? SIGNAL_MARKETS[0];
/** The published strategies this builder can start from, grouped by how long they are built to hold. */
const GROUPS = HORIZONS.map((key) => ({ key, ids: TEMPLATE_IDS.filter((r) => r !== 'made' && HORIZON[r] === key) })).filter((g) => g.ids.length);
const MODE_ICON: Record<Mode, IconName> = { classic: 'medal', words: 'chat', blank: 'edit' };
/** One-click conditions for the rule step. */
const QUICK: Cond[] = [
  { a: P, op: 'above', b: { k: 'sma', n: 200 } },
  { a: { k: 'rsi', n: 14 }, op: 'below', b: { k: 'num', n: 30 } },
  { a: P, op: 'above', b: { k: 'high', n: 20 } },
  { a: { k: 'ret', n: 28 }, op: 'above', b: { k: 'num', n: 0 } },
];
const sameCond = (x: Cond, y: Cond) => JSON.stringify(x) === JSON.stringify(y);

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

function Conds({ list, onChange, side, head, hint, empty, join }: { list: Cond[]; onChange: (cs: Cond[]) => void; side: 'buy' | 'sell'; head: string; hint: string; empty?: string; join: string }) {
  const { t } = useT();
  const set = (i: number, c: Cond) => onChange(list.map((x, k) => (k === i ? c : x)));
  return (
    <section className={`wz-side-block ${side}`}>
      <header><span className={`wz-tag ${side}`}>{side === 'buy' ? t.cuBuy : t.cuSell}</span><div><h4>{head}</h4><p>{hint}</p></div></header>
      <div className="bu-conds">
        {list.map((c, i) => (
          <div key={i} className="wz-cond-row">
            {i > 0 && <span className="wz-join">{join}</span>}
            <div className="bu-cond">
              <TermEdit value={c.a} onChange={(a) => { const keep = scaleOf(a.k) === scaleOf(c.b.k) || scaleOf(c.b.k) === 'any'; set(i, { ...c, a, b: keep ? c.b : scaleOf(a.k) === 'price' ? { k: 'sma', n: 50 } : { k: 'num', n: a.k === 'rsi' ? 30 : 0 } }); }} />
              <select className="bu-op" value={c.op} onChange={(e) => set(i, { ...c, op: e.target.value as Cond['op'] })} aria-label={t.cuAbove}>
                <option value="above">{t.cuAbove}</option><option value="below">{t.cuBelow}</option>
              </select>
              <TermEdit value={c.b} other={c.a} onChange={(b) => set(i, { ...c, b })} />
              <button className="icon-btn sm" onClick={() => onChange(list.filter((_, k) => k !== i))} aria-label={t.buRemove} data-tip={t.buRemove}><Icon name="close" size={14} /></button>
            </div>
          </div>
        ))}
        {!list.length && empty && <p className="bu-empty">{empty}</p>}
        {list.length < MAX_CONDS && <button className="btn-text bu-add" onClick={() => onChange([...list, { a: P, op: side === 'buy' ? 'above' : 'below', b: { k: 'sma', n: 50 } }])}><Icon name="plus" size={14} />{t.buAdd}</button>}
      </div>
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
  const reset = (symbol: string) => { setD(blank(symbol)); setWords(''); setRead(null); setStarted(false); setMode('classic'); setStep(0); };
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

  // The backtest, rerun whenever the rule or the coin changes.
  const [bars, setBars] = useState<{ symbol: string; list: cex.Candle[] } | null>(null);
  useEffect(() => { let alive = true; dailyHistory(market).then((list) => alive && setBars({ symbol: market.symbol, list }), () => alive && setBars({ symbol: market.symbol, list: [] })); return () => { alive = false; }; }, [market.symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = bars?.symbol === market.symbol ? bars.list : null;
  const issues = useMemo(() => problems(d), [d]);
  const blocking = issues.filter((x) => x !== 'name');
  const result = useMemo(() => {
    if (!ready || blocking.length) return null;
    return scoreMade({ id: d.id ?? 'draft', name: d.name, market: d.market, buy: d.buy, sell: d.sell, createdAt: 0 }, market, ready);
  }, [ready, d.buy, d.sell, d.market, blocking.length]); // eslint-disable-line react-hooks/exhaustive-deps
  /** How each published strategy did on this coin, so the choice in step 2 is made with numbers in view. */
  const shelf = useMemo(() => {
    const out: Partial<Record<RuleId, { total: number; maxDd: number; hold: number } | null>> = {};
    if (!ready) return out;
    for (const id of TEMPLATE_IDS) {
      const x = fromTemplate(id);
      const a = x ? scoreMade({ id: 'shelf', name: '', market: market.symbol, ...x, createdAt: 0 }, market, ready) : null;
      out[id] = a ? { total: a.total, maxDd: a.maxDd, hold: a.hold } : null;
    }
    return out;
  }, [ready, market.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoName = `${market.base} ${d.from ? `${t.agNick[d.from]}+` : t.wzMineName}`;
  const pickCoin = (symbol: string) => { setD((cur) => ({ ...cur, market: symbol })); setStep(1); };
  const pickTemplate = (r: RuleId) => { const x = fromTemplate(r); if (!x) return; setD((cur) => ({ ...cur, ...x, from: r, name: cur.id ? cur.name : '' })); setRead(null); setStarted(true); };
  const startBlank = () => { setD((cur) => ({ ...blank(cur.market), id: cur.id, name: cur.name })); setRead(null); setStarted(true); setStep(2); };
  const go = (n: Step) => { if (n === 3 && !d.name.trim()) setD((cur) => ({ ...cur, name: autoName })); setStep(n); window.scrollTo({ top: 0 }); };
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
  const buyText = d.buy.map((c) => condText(t, c)).join(` ${t.cuAnd} `);
  const sellText = d.sell.length ? d.sell.map((c) => condText(t, c)).join(` ${t.cuOr} `) : t.wzSellAuto;
  const origin = d.from ? t.buFrom(t.agRule[d.from]) : mode === 'words' && read?.ok ? t.wzFromWords : t.wzFromBlank;
  const stepSub = [market.base, started ? (d.from ? t.agNick[d.from] : mode === 'words' ? t.wzModes.words : t.wzModes.blank) : '', started ? t.wzCondCount(d.buy.length + d.sell.length) : '', d.id ? d.name : ''];

  const nav = (
    <footer className="wz-nav">
      {step > 0 ? <button className="btn" onClick={() => go((step - 1) as Step)}><Icon name="chevron" size={14} />{t.wzBack}</button> : <span />}
      {step < 3 && <button className="btn-primary" disabled={!canNext} onClick={() => go((step + 1) as Step)}>{step === 2 ? t.wzToSave : t.wzNext}<Icon name="chevron" size={14} /></button>}
    </footer>
  );
  const panel = (title: string, sub: string, body: ReactNode) => (
    <section className="wz-panel" key={step}>
      <header className="wz-head"><h2>{title}</h2><p>{sub}</p></header>
      {body}
      {nav}
    </section>
  );

  return (
    <div className="page build-page">
      <header className="page-head"><div><h1>{t.buTitle}</h1></div>
        {(started || d.id) && <button className="btn" onClick={() => reset(d.market)}><Icon name="plus" size={14} />{t.buNew}</button>}
      </header>

      <ol className="wz-steps" aria-label={t.buTitle}>
        {t.wzSteps.map((label, i) => (
          <li key={label} className={i === step ? 'now' : i < step ? 'done' : ''}>
            <button disabled={!reach(i as Step)} onClick={() => go(i as Step)} aria-current={i === step ? 'step' : undefined}>
              <span className="wz-dot">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
              <b>{label}</b>
              {i < step && stepSub[i] && <small>{stepSub[i]}</small>}
            </button>
          </li>
        ))}
      </ol>

      <div className="wz-grid">
        {step === 0 && panel(t.wzCoinTitle, t.wzCoinSub, (
          <>
            <div className="wz-coins">
              {SIGNAL_MARKETS.filter((m) => isRunnable(m.base)).map((m) => (
                <button key={m.symbol} className={`wz-coin${m.symbol === d.market ? ' on' : ''}`} aria-pressed={m.symbol === d.market} onClick={() => pickCoin(m.symbol)}>
                  <CoinMark base={m.base} big />
                  <b>{m.base}</b>
                </button>
              ))}
            </div>
            <details className="wz-others" open={!isRunnable(market.base)}>
              <summary>{t.wzOtherCoins}<Icon name="down" size={14} /></summary>
              <p>{t.wzOtherSub}</p>
              <div className="wz-chips">
                {SIGNAL_MARKETS.filter((m) => !isRunnable(m.base)).map((m) => <button key={m.symbol} className={`fchip${m.symbol === d.market ? ' on' : ''}`} aria-pressed={m.symbol === d.market} onClick={() => pickCoin(m.symbol)}><CoinMark base={m.base} />{m.base}</button>)}
              </div>
            </details>
          </>
        ))}

        {step === 1 && panel(t.wzStartTitle(market.base), t.wzStartSub, (
          <>
            <div className="seg wz-mode-seg" role="tablist">
              {(['classic', 'words', 'blank'] as Mode[]).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}><Icon name={MODE_ICON[m]} size={14} />{t.wzModes[m]}</button>
              ))}
            </div>
            {!isRunnable(market.base) && <p className="bu-note warn">{t.buDemo(market.base)}</p>}

            {mode === 'classic' && GROUPS.map((g) => (
              <div key={g.key} className="wz-group">
                <h3><span className={`hz-chip hz-${g.key}`}>{t.hz[g.key]}</span><small>{t.hzSub[g.key]}</small></h3>
                <div className="wz-cards">
                  {g.ids.map((r) => {
                    const s = shelf[r];
                    return (
                      <button key={r} className={`wz-card${d.from === r && started ? ' on' : ''}`} aria-pressed={d.from === r && started} onClick={() => pickTemplate(r)}>
                        <span className="wz-card-top">
                          <Face rule={r} size="sm" />
                          <b>{t.agNick[r]}</b>
                          <span className="wz-card-perf">{!ready ? <i className="spin" aria-hidden /> : s ? <b className={s.total >= 0 ? 'pos' : 'neg'}>{pct(s.total)}</b> : <small>—</small>}</span>
                        </span>
                        <span className="wz-card-line">{t.agLine[r]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {mode === 'classic' && <p className="bu-note">{t.wzPerfNote}</p>}

            {mode === 'words' && (
              <div className="wz-words">
                <form onSubmit={(e) => { e.preventDefault(); setD(readWords(words, d)); }}>
                  <textarea value={words} onChange={(e) => setWords(e.target.value)} placeholder={t.buWordsPh} aria-label={t.buWords} rows={3} />
                  <button className="btn-primary" type="submit" disabled={!words.trim()}>{t.buRead}</button>
                </form>
                <div className="wz-examples"><span>{t.wzTry}</span>{t.wzExamples.map((x) => <button key={x} className="fchip" onClick={() => { setWords(x); setD(readWords(x, d)); }}>{x}</button>)}</div>
                {read && <p className={`bu-note${read.ok ? '' : ' warn'}`}>{read.ok ? t.buReadOk(read.ok) : t.buReadNo}{read.ok > 0 && read.unknown.map((x) => <span key={x}> {t.buReadPart(x)}</span>)}</p>}
                {read && read.ok > 0 && (
                  <ul className="wz-reads">
                    <li><span className="wz-tag buy">{t.cuBuy}</span>{buyText}</li>
                    <li><span className="wz-tag sell">{t.cuSell}</span>{sellText}</li>
                  </ul>
                )}
              </div>
            )}

            {mode === 'blank' && (
              <div className="wz-blank">
                <span className="wz-mode-ic lg"><Icon name="edit" size={22} /></span>
                <div><b>{t.wzBlankTitle}</b><p>{t.wzBlankSub}</p></div>
                <button className="btn-primary" onClick={startBlank}>{t.wzBlankGo}<Icon name="chevron" size={14} /></button>
              </div>
            )}
          </>
        ))}

        {step === 2 && panel(t.wzRuleTitle, t.wzRuleSub, (
          <>
            <Conds side="buy" list={d.buy} onChange={(buy) => setD({ ...d, buy })} head={t.buBuyHead} hint={t.wzBuyHint} join={t.cuAnd} />
            {d.buy.length < MAX_CONDS && (
              <div className="wz-quick"><span>{t.wzQuick}</span>
                {QUICK.filter((q) => !d.buy.some((c) => sameCond(c, q))).map((q) => <button key={JSON.stringify(q)} className="fchip" onClick={() => setD({ ...d, buy: [...d.buy, structuredClone(q)] })}><Icon name="plus" size={12} />{condText(t, q)}</button>)}
              </div>
            )}
            <Conds side="sell" list={d.sell} onChange={(sell) => setD({ ...d, sell })} head={t.buSellHead} hint={t.wzSellHint} empty={t.buSellEmpty} join={t.cuOr} />
            {blocking.map((x) => <p key={x} className="bu-note warn">{t.buProblem[x]}</p>)}
          </>
        ))}

        {step === 3 && panel(t.wzSaveTitle, t.wzSaveSub, (
          <>
            <dl className="wz-review">
              <div><dt>{t.buCoin}</dt><dd><CoinMark base={market.base} />{market.base}<small className={isRunnable(market.base) ? 'real' : ''}>{isRunnable(market.base) ? t.wzCanTrade : t.wzSignalOnly}</small></dd><button className="link" onClick={() => go(0)}>{t.buEdit}</button></div>
              <div><dt>{t.wzSteps[1]}</dt><dd>{origin}</dd><button className="link" onClick={() => go(1)}>{t.buEdit}</button></div>
              <div><dt>{t.cuBuy}</dt><dd>{buyText}</dd><button className="link" onClick={() => go(2)}>{t.buEdit}</button></div>
              <div><dt>{t.cuSell}</dt><dd>{sellText}</dd><button className="link" onClick={() => go(2)}>{t.buEdit}</button></div>
            </dl>
            <label className="wz-name"><span>{t.buName}</span><input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value.slice(0, 40) })} placeholder={autoName} /></label>
            {result && result.trades < 5 && <p className="bu-note warn">{t.buFew(result.trades)}</p>}
            <p className="bu-note warn">{t.buUnproven}</p>
            {result && <p className="bu-note">{t.acFoot(`${(result.fee * 100).toFixed(1)}%`, result.days)}</p>}
            <div className="wz-save">
              <button className="btn-primary" disabled={!!issues.length || !result} onClick={() => save(true)}>{t.buSaveOpen}</button>
              <button className="btn" disabled={!!issues.length} onClick={() => save(false)}>{d.id ? t.buUpdate : t.buSave}</button>
            </div>
            <p className="bu-note">{signedIn ? t.wzAccountIn : t.wzAccountGuest}</p>
          </>
        ))}

        <aside className={`wz-side${started ? '' : ' empty'}`} aria-label={t.wzPreview}>
          <span className="wz-side-label">{t.wzPreview}</span>
          {!started ? (
            <div className="wz-side-empty">
              <span className="wz-ghost" aria-hidden><i /><i /><i /><i /><i /><i /><i /></span>
              <b>{market.base}</b>
              <p>{t.wzPreviewEmpty}</p>
            </div>
          ) : (
            <>
              <div className="wz-side-head">
                <Face rule={d.from ?? 'made'} />
                <div><b>{d.name.trim() || autoName}</b><small><CoinMark base={market.base} />{market.base} · {origin}</small></div>
              </div>
              <ul className="wz-reads">
                <li><span className="wz-tag buy">{t.cuBuy}</span>{buyText || '…'}</li>
                <li><span className="wz-tag sell">{t.cuSell}</span>{sellText}</li>
              </ul>
              {!ready ? <p className="bu-wait"><span className="spin" aria-hidden />{t.buWorking}</p>
                : blocking.length ? <p className="bu-wait">{t.buProblem[blocking[0]]}</p>
                  : !result ? <p className="bu-wait">{t.buNoData}</p> : (
                    <>
                      <div className="bu-money">
                        <div><small>{t.btIf(moneyText(lang, amount), false)}</small><b className={result.total >= 0 ? 'pos' : 'neg'}>{moneyText(lang, amount * (1 + result.total))}</b><em className={result.total >= 0 ? 'pos' : 'neg'}>{pct(result.total)}</em></div>
                        <div className="dim"><small>{t.btIfHold}</small><b>{moneyText(lang, amount * (1 + result.hold))}</b><em className={result.hold >= 0 ? 'pos' : 'neg'}>{pct(result.hold)}</em></div>
                      </div>
                      <Equity pts={result.equity} up={edge >= 0} wide />
                      <span className={`wz-side-trades${result.trades < 5 ? ' few' : ''}`}>{t.thTrades} {t.btTimes(result.trades)}</span>
                      <dl className="bu-stats">
                        <div><dt>{t.thEdge}</dt><dd className={edge >= 0 ? 'pos' : 'neg'}>{pct(edge)}</dd></div>
                        <div><dt>{t.thDd}</dt><dd>{drop(result.maxDd)}</dd></div>
                        <div><dt>{t.thTrades}</dt><dd>{t.btTimes(result.trades)}</dd></div>
                      </dl>
                    </>
                  )}
            </>
          )}
        </aside>
      </div>

      <section className="bu-mine">
        <h3>{t.buMine}{mine.length > 0 && <small>{mine.length}</small>}</h3>
        {!mine.length && <p className="muted">{t.buMineEmpty}</p>}
        {mine.map((s) => {
          const m = cex.MARKETS.find((x) => x.symbol === s.market);
          return (
            <div key={s.id} className={`bu-mine-row${d.id === s.id ? ' on' : ''}`}>
              <Face rule="made" size="sm" />
              <span className="bu-mine-name"><b>{s.name}</b><small>{m?.base} · {s.buy.map((c) => condText(t, c)).join(` ${t.cuAnd} `)}</small></span>
              <button className="btn sm" onClick={() => { setD({ ...s }); setWords(''); setRead(null); setStarted(true); setStep(2); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{t.buEdit}</button>
              <button className="btn sm" onClick={async () => { if (!m) return; const a = scoreMade(s, m, await dailyHistory(m)); if (a) onOpen(a); }}>{t.buOpen}</button>
              <button className="icon-btn sm" onClick={() => { removeMade(s.id); if (d.id === s.id) setD({ ...d, id: undefined }); }} aria-label={t.buDelete} data-tip={t.buDelete}><Icon name="trash" size={16} /></button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
