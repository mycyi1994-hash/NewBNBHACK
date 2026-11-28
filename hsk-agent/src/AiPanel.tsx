// Moa AI on screen: one card per coin in the market, and its decision log (the live track record).
// It shows only what the server recorded: each decision's time, the share it set, what the model asked for and which
// limit changed it, its reason, the inputs it named and its hash. The paper result is labelled as paper; there is no
// backtest, so it never appears in a "beats holding" list or a ranking.
import { useEffect, useState, type CSSProperties } from 'react';
import { useT, type Strings } from './i18n.ts';
import { aiAgent, aiFeed, verifyDecision, COINS, type AiDecision, type AiFeed } from './aiPilot.ts';
import type { Agent } from './agents.ts';
import type { Asset } from './intent.ts';
import { markColor } from './Mark.tsx';
import { Face, pct } from './AgentCard.tsx';

const P = (x: number) => `${Math.round(x * 100)}%`;
const sign = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

/** The three coins' feeds, read now and every five minutes. A coin that cannot be read is left out. */
export function useAiFeeds(): Partial<Record<Asset, AiFeed>> | null {
  const [feeds, setFeeds] = useState<Partial<Record<Asset, AiFeed>> | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all(COINS.map((c) => aiFeed(c).then((f) => [c, f] as const, () => null))).then((xs) => {
      if (alive) setFeeds(Object.fromEntries(xs.filter((x): x is readonly [Asset, AiFeed] => !!x)));
    });
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return feeds;
}

/** The one badge only Moa AI wears. */
export function AiBadge({ sm }: { sm?: boolean }) {
  const { t } = useT();
  return <span className={`aip-badge${sm ? ' sm' : ''}`}>{t.aiTag}</span>;
}

const when = (ms: number, lang: string) => new Date(ms).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const reasonOf = (d: AiDecision, lang: string) => (lang === 'ko' ? d.reasonKo : d.reason);
const stateLine = (t: Strings, f: AiFeed) => (f.state === 'noKey' ? t.aiNoKeySub : f.state === 'off' ? t.aiOffSub : '');

/** The share it held, decision by decision, as steps from 0% to 100%. */
function TargetSteps({ ds }: { ds: AiDecision[] }) {
  const xs = ds.slice(-30);
  if (xs.length < 2) return null;
  const W = 160, H = 56, n = xs.length - 1;
  const y = (v: number) => (H - 4 - v * (H - 8)).toFixed(1);
  const d = xs.map((x, i) => `${i ? `H${((i / n) * W).toFixed(1)}V` : 'M0 '}${y(x.target)}`).join('');
  return (
    <svg className="aip-steps" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={`M0 ${y(1)}H${W}M0 ${y(0)}H${W}`} className="grid" />
      <path d={`${d}H${W}`} className="line" />
    </svg>
  );
}

/** One coin's card in the market. */
export function AiCard({ f, onHire, onLog, open }: { f: AiFeed; onHire: (a: Agent) => void; onLog: () => void; open: boolean }) {
  const { t, lang } = useT();
  const a = aiAgent(f);
  const last = [...f.decisions].reverse().find((d) => !d.held) ?? f.decisions[f.decisions.length - 1];
  const decided = f.decisions.some((d) => !d.held);
  const p = f.paper;
  const off = f.state !== 'on';
  return (
    <article className={`mp-card aip-card${off ? ' off' : ''}`} style={{ '--fam': markColor('aiPilot') } as CSSProperties}>
      <header className="mp-top">
        <div className="mp-title">
          <Face rule="aiPilot" base={f.asset} size="xl" />
          <span className="mp-name">
            <b>{t.agNick.aiPilot} · {f.asset}</b>
            <span className="mp-sub"><AiBadge /><span className={`mp-live${!off ? ' on' : ''}`}><i aria-hidden />{f.state === 'on' ? t.ivTag['4h'] : f.state === 'noKey' ? t.aiNoKey : t.aiOff}</span></span>
          </span>
        </div>
      </header>
      <p className="aip-honest">{t.aiHonest}</p>
      <div className="mp-result aip-result">
        {decided && last ? (
          <div className="aip-now">
            <small>{t.aiNow}</small>
            <b>{P(last.target)}</b>
            <span>{last.proposed !== undefined && last.proposed !== last.target ? t.aiAsked(P(last.proposed)) : when(last.at, lang)}</span>
          </div>
        ) : <p className="aip-wait">{off ? stateLine(t, f) : t.aiWaiting}</p>}
        <TargetSteps ds={f.decisions} />
      </div>
      {decided && last && <p className="aip-reason"><span>{t.aiReason}</span>{reasonOf(last, lang)}</p>}
      <p className="aip-paper">
        {p ? <><b className={sign(p.total)}>{pct(p.total)}</b> {t.aiPaper} · {t.aiVsHold(pct(p.hold))}</> : t.aiPaperNone}
      </p>
      <footer className="mp-foot">
        <button className={`mp-run ghost${open ? ' on' : ''}`} onClick={onLog} aria-expanded={open}>{t.aiLog}{f.count ? ` · ${f.count}` : ''}</button>
        <button className="mp-run" onClick={() => onHire(a)} disabled={off}>{off ? (f.state === 'noKey' ? t.aiNoKey : t.aiOff) : t.acHire}</button>
      </footer>
    </article>
  );
}

/** Every recorded decision of one coin, newest first, with the paper result over all of them. */
export function AiLog({ f, onClose }: { f: AiFeed; onClose: () => void }) {
  const { t, lang } = useT();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const ds = [...f.decisions].reverse();
  const p = f.paper;
  return (
    <section className="aip-log" aria-label={t.aiLogTitle(f.asset)}>
      <header className="aip-log-head">
        <Face rule="aiPilot" base={f.asset} size="sm" />
        <b>{t.aiLogTitle(f.asset)}</b>
        <AiBadge sm />
        {f.model && <small>{t.aiModel(f.model)}</small>}
        <button type="button" className="btn-text" onClick={onClose}>{t.aiLogClose}</button>
      </header>
      <p className="aip-log-sub">{f.state !== 'on' ? `${stateLine(t, f)} ` : ''}{t.aiLogSub(f.count)}</p>
      {p && (
        <div className="aip-log-paper">
          <span><small>{t.aiPaper}</small><b className={sign(p.total)}>{pct(p.total)}</b></span>
          <span><small>{t.aiHold}</small><b className={sign(p.hold)}>{pct(p.hold)}</b></span>
          <p>{t.aiPaperNote(t.aiDays(Math.floor(p.days)))}</p>
        </div>
      )}
      {!ds.length && <p className="muted">{t.aiLogEmpty}</p>}
      <ol className="aip-list">
        {ds.map((d) => {
          const moved = d.prev !== null && d.prev !== d.target;
          return (
            <li key={d.hash} className={d.held ? 'held' : ''}>
              <div className="aip-row">
                <time dateTime={new Date(d.at).toISOString()}>{when(d.at, lang)}</time>
                <b className="aip-t">{d.prev !== null && moved ? <>{P(d.prev)} <i aria-hidden>→</i> {P(d.target)}</> : P(d.target)}</b>
                {d.held && <span className="aip-tag warn">{t.aiKept} · {t.aiHeld[d.held]}</span>}
                {!d.held && d.proposed !== undefined && d.proposed !== d.target && <span className="aip-tag">{t.aiAsked(P(d.proposed))}</span>}
                {d.guard && (Object.keys(d.guard) as ('clamped' | 'stepped' | 'banded')[]).map((g) => <span key={g} className="aip-tag">{t.aiGuard[g]}</span>)}
              </div>
              <p className="aip-why">{reasonOf(d, lang)}</p>
              {d.signals.length > 0 && <p className="aip-sigs"><span>{t.aiSignals}</span>{d.signals.map((s) => <i key={s}>{t.aiSig[s] ?? s}</i>)}</p>}
              <div className="aip-hash">
                <code title={d.hash}>{d.hash.slice(0, 10)}…{d.hash.slice(-6)}</code>
                <button type="button" className="btn sm" onClick={() => setChecked((c) => ({ ...c, [d.hash]: verifyDecision(d) }))}>{t.aiCheck}</button>
                {checked[d.hash] !== undefined && <span className={checked[d.hash] ? 'jr-ok' : 'jr-bad'}>{checked[d.hash] ? t.aiOk : t.aiBad}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The market's Moa AI section: one card per coin (only `coin`'s when given), and the log of the one opened. */
export function AiSection({ onHire, coin }: { onHire: (a: Agent) => void; coin?: string }) {
  const { t } = useT();
  const feeds = useAiFeeds();
  const [open, setOpen] = useState<Asset | null>(null);
  const list = COINS.filter((c) => !coin || c === coin).map((c) => feeds?.[c]).filter((f): f is AiFeed => !!f);
  if (feeds && !list.length) return null;   // this server does not serve Moa AI (or not for this coin): nothing to show
  return (
    <section className="mp-sec aip-sec" aria-label={t.aiSecTitle}>
      <h2 className="mp-h2">{t.aiSecTitle} <AiBadge sm /> <small>{t.aiSecSub}</small></h2>
      <div className={`mp-grid aip-grid${list.length === 1 || (!feeds && coin) ? ' one' : ''}`}>
        {!feeds && (coin ? [0] : [0, 1, 2]).map((i) => <div key={i} className="mp-card mp-skel skel-block" />)}
        {list.map((f) => <AiCard key={f.asset} f={f} open={open === f.asset} onHire={onHire} onLog={() => setOpen((o) => (o === f.asset ? null : f.asset))} />)}
      </div>
      {open && (!coin || open === coin) && feeds?.[open] && <AiLog f={feeds[open]!} onClose={() => setOpen(null)} />}
    </section>
  );
}
