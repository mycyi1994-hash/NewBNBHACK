// Agents people made and shared: the market's "Made by people" tab, the page a share link opens, the sheet that
// shares one of your own, and the creator's own list with what it has earned.
// Every number is real: the backtest runs in this browser on the same candles and code as every agent, the hire
// count is the server's (one per hiring wallet), and the fees received are read from the vaults' events on-chain.
// Shared agents are labelled for what they are: a person's rule, not verified by anyone.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Agent } from './agents.ts';
import { pct, ruleLines, Face } from './AgentCard.tsx';
import { Icon } from './Icons.tsx';
import { markColor } from './Mark.tsx';
import { Modal, StateBox, useToast } from './ui.tsx';
import { useT, type Lang, type Strings } from './i18n.ts';
import { nickOf, shortAddress, useSession } from './account.ts';
import * as cex from './cex.ts';
import { FEE_CHOICES, feeOn, feeText, shareLink, type SharedAgent, type SharedRef } from './share.ts';
import { getShared, publishShared, scoreShared, unpublishShared, useFeesLive, useFeesShared, useMineShared, useShared, type PublishWhy, type Scored } from './shareClient.ts';
import { money } from './hiredText.ts';
import type { MadeSpec } from './spec.ts';

const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const baseOf = (market: string) => cex.MARKETS.find((m) => m.symbol === market)?.base ?? '';
/** "Calm Otter · 0x12ab…9f0c": the name the creator shared under, and the wallet the fee goes to. */
export const whoText = (lang: Lang, s: Pick<SharedRef, 'creator' | 'nick'>) => `${s.nick || nickOf(s.creator, lang)} · ${shortAddress(s.creator)}`;
const feeLabel = (t: Strings, bps: number) => (bps > 0 ? t.shFee(feeText(bps)) : t.shFeeNone);
const linkOf = (id: string) => shareLink(location.origin, id);

function copy(text: string, done: () => void) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { if (document.execCommand('copy')) done(); } finally { ta.remove(); }
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}

/** The agent's money line over just holding the coin (dashed), from the same start. */
function Duo({ a }: { a: Agent }) {
  const W = 200, H = 72;
  const thin = <T,>(xs: T[]) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / 64)) === 0 || i === xs.length - 1);
  const eq = thin(a.equity), bn = thin(a.bench);
  if (eq.length < 2) return null;
  const ev = eq.map((p) => p.value / (eq[0].value || 1)), bv = bn.map((p) => p.value / (bn[0]?.value || 1));
  const lo = Math.min(...ev, ...bv), span = Math.max(...ev, ...bv) - lo || 1;
  const line = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${((i / (vs.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - lo) / span) * (H - 8)).toFixed(1)}`).join('');
  const d = line(ev);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className={a.total >= a.hold ? 'up' : 'down'}>
      {bv.length > 1 && <path className="hold" d={line(bv)} fill="none" vectorEffect="non-scaling-stroke" />}
      <path className="area" d={`${d}L${W},${H}L0,${H}Z`} />
      <path className="draw line" pathLength={1} d={d} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The backtest box: the one number against just holding, over its curve; or what is happening instead. */
function Result({ a }: { a: Agent | null | 'fail' | undefined }) {
  const { t } = useT();
  if (a === undefined) return <div className="mp-result sh-wait" role="status"><span className="spin" aria-hidden />{t.shScoring}</div>;
  if (a === null || a === 'fail') return <div className="mp-result sh-wait">{t.shNoScore}</div>;
  const edge = a.total - a.hold;
  return (
    <div className="mp-result">
      <div className="mp-num"><small>{t.mpVsHold}</small><b className={sign(edge)}>{pct(edge)}</b><span>{t.mpOver(a.days)}</span></div>
      <figure className="mp-chart"><Duo a={a} /><figcaption><i aria-hidden />{t.mpHoldLine}</figcaption></figure>
    </div>
  );
}

/** One shared agent: its mark, name and maker, the label, its rule, the backtest, the fee and the real hire count. */
export function SharedCard({ s, a, onOpen, onHire, flat }: { s: SharedAgent; a: Scored['a']; onOpen?: (a: Agent) => void; onHire?: (a: Agent) => void; flat?: boolean }) {
  const { t, lang } = useT();
  const ready = a && a !== 'fail' ? a : null;
  const base = baseOf(s.spec.market);
  return (
    <article className={`mp-card sh-card${flat ? ' flat' : ''}`} style={{ '--fam': markColor('made') } as CSSProperties}>
      <header className="mp-top">
        <button className="mp-title" onClick={() => ready && onOpen?.(ready)} disabled={!ready || !onOpen}>
          <Face rule="made" base={base} size="xl" />
          <span className="mp-name">
            <b>{s.spec.name}</b>
            <span className="sh-by"><Icon name="user" size={14} />{t.shBy(whoText(lang, s))}</span>
          </span>
        </button>
      </header>
      <p className="sh-label"><Icon name="info" size={14} />{t.shLabel}</p>
      <p className="mp-plain sh-rule">{ruleLines(t, { rule: 'made', made: s.spec }).join(' · ')}</p>
      <Result a={a} />
      <ul className="sh-facts">
        <li className={s.feeBps ? 'fee' : ''}><Icon name="coin" size={14} />{feeLabel(t, s.feeBps)}</li>
        <li><Icon name="bot" size={14} />{t.shHires(s.hires)}</li>
      </ul>
      {(onOpen || onHire) && (
        <footer className="mp-foot">
          <button className="mp-run ghost" disabled={!ready} onClick={() => ready && onOpen?.(ready)}>{t.mpMore}</button>
          <button className="mp-run" disabled={!ready || !!s.removedAt} onClick={() => ready && onHire?.(ready)}>{t.acHire}</button>
        </footer>
      )}
    </article>
  );
}

/** The market's "Made by people" tab. */
export function SharedMarket({ onOpen, onHire, onBuild }: { onOpen: (a: Agent) => void; onHire: (a: Agent) => void; onBuild: () => void }) {
  const { t } = useT();
  const { list, reload } = useShared();
  return (
    <section className="sh-market" aria-label={t.shHead}>
      <p className="sh-intro">{t.shSub}</p>
      {list === 'fail' && <StateBox title={t.shFail} retry={t.retry} onRetry={reload} />}
      {list === null && <div className="mp-grid">{[0, 1, 2].map((i) => <div key={i} className="mp-card mp-skel skel-block" />)}</div>}
      {Array.isArray(list) && !list.length && (
        <div className="sh-empty"><Face rule="made" size="xl" /><b>{t.shEmpty}</b><button className="btn-primary" onClick={onBuild}><Icon name="plus" size={16} />{t.shMake}</button></div>
      )}
      {Array.isArray(list) && list.length > 0 && <div className="mp-grid stagger">{[...list].sort((x, y) => y.s.hires - x.s.hires || y.s.createdAt - x.s.createdAt).map((x) => <SharedCard key={x.s.id} s={x.s} a={x.a} onOpen={onOpen} onHire={onHire} />)}</div>}
    </section>
  );
}

/** What a share link (`/?agent=<id>`) opens: that agent's backtest card, with "Hire" when it is still shared. */
export function SharedLink({ id, onClose, onOpen, onHire }: { id: string; onClose: () => void; onOpen: (a: Agent) => void; onHire: (a: Agent) => void }) {
  const { t } = useT();
  const [s, setS] = useState<SharedAgent | null | 'fail' | undefined>(undefined);
  const [a, setA] = useState<Scored['a']>(undefined);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setS(undefined); setA(undefined);
    getShared(id).then((x) => {
      if (!alive) return;
      setS(x);
      if (x) scoreShared(x).then((v) => alive && setA(v), () => alive && setA('fail'));
    }, () => alive && setS('fail'));
    return () => { alive = false; };
  }, [id, n]);
  const ready = a && a !== 'fail' ? a : null;
  const live = s && s !== 'fail' && !s.removedAt;
  return (
    <Modal title={t.shLinkTitle} onClose={onClose} actions={<>
      <button className="btn-text" onClick={onClose}>{t.close}</button>
      {ready && <button className="btn" onClick={() => onOpen(ready)}>{t.mpMore}</button>}
      {live && <button className="btn-primary hire" disabled={!ready} onClick={() => ready && onHire(ready)}>{t.acHire}</button>}
    </>}>
      <div className="sh-link">
        {s === undefined && <p className="sh-wait" role="status"><span className="spin" aria-hidden />{t.shScoring}</p>}
        {s === 'fail' && <StateBox title={t.shFail} retry={t.retry} onRetry={() => setN((x) => x + 1)} compact />}
        {s === null && <p className="hire-sub warn">{t.shMissing}</p>}
        {s && s !== 'fail' && (
          <>
            {s.removedAt && <p className="bd-alert warn">{t.shGone}</p>}
            <SharedCard s={s} a={a} flat />
          </>
        )}
      </div>
    </Modal>
  );
}

const why = (t: Strings, w: PublishWhy) => t.shWhy[w];

/** Share one of your own agents: pick a fee, see the name it goes under, then copy the link. */
export function ShareSheet({ spec, onClose }: { spec: MadeSpec; onClose: () => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const session = useSession();
  const { mine, reload } = useMineShared();
  const had = mine && mine !== 'fail' ? mine.agents.find((x) => x.sourceId === spec.id && !x.removedAt) : undefined;
  // A fee can be picked only where a vault can pay it: the server says so (version-3 vaults). Unknown means no picker.
  const feesLive = useFeesLive();
  const [picked, setFee] = useState<number | null>(null);
  const fee = feesLive ? picked ?? 50 : 0;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<SharedAgent | null>(null);
  const shared = done ?? had ?? null;
  const pool = ['BTC', 'ETH', 'HSK'].includes(baseOf(spec.market));
  const nick = session ? nickOf(session.address, lang) : '';
  const go = async () => {
    setBusy(true); setErr('');
    const r = await publishShared(spec, fee, nick);
    setBusy(false);
    if (!r.ok) { setErr(why(t, r.why)); return; }
    setDone(r.agent); toast(t.shDone); reload();
  };
  const stop = async () => {
    if (!shared) return;
    setBusy(true);
    const ok = await unpublishShared(shared.id);
    setBusy(false);
    if (!ok) { setErr(t.shWhy.failed); return; }
    toast(t.shStopped); setDone(null); reload(); onClose();
  };
  const link = shared ? linkOf(shared.id) : '';
  return (
    <Modal title={t.shSheetTitle(spec.name)} onClose={onClose} actions={shared ? <>
      <button className="btn-text danger" disabled={busy} onClick={() => void stop()}>{t.shStop}</button>
      <button className="btn-primary" onClick={() => copy(link, () => toast(t.copied))}>{t.shCopyLink}</button>
    </> : <>
      <button className="btn-text" onClick={onClose}>{t.cancel}</button>
      <button className="btn-primary" disabled={!session || !pool || busy || mine === null && !!session} onClick={() => void go()}>{busy ? <span className="spin" aria-hidden /> : <Icon name="share" size={16} />}{t.shGo}</button>
    </>}>
      <div className="sh-sheet">
        <div className="hire-who"><Face rule="made" base={baseOf(spec.market)} size="lg" /><p>{spec.name}<small>{ruleLines(t, { rule: 'made', made: spec })[0]}</small></p></div>
        {shared ? (
          <>
            <p className="sh-ok"><Icon name="check" size={16} />{t.shDone}</p>
            <label className="field"><span>{t.shLink}</span>
              <div className="sh-linkbox"><input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t.shLink} /><button className="btn" onClick={() => copy(link, () => toast(t.copied))}>{t.copy}</button></div>
            </label>
            <ul className="sh-facts"><li className={shared.feeBps ? 'fee' : ''}><Icon name="coin" size={14} />{feeLabel(t, shared.feeBps)}</li><li><Icon name="bot" size={14} />{t.shHires(shared.hires)}</li></ul>
          </>
        ) : (
          <>
            <p className="sh-lead">{t.shSheetSub}</p>
            {feesLive ? (
              <div className="field">
                <span>{t.shPickFee}</span>
                <div className="sh-fees" role="radiogroup" aria-label={t.shPickFee}>
                  {FEE_CHOICES.map((f) => <button key={f} type="button" role="radio" aria-checked={fee === f} className={fee === f ? 'on' : ''} onClick={() => setFee(f)}>{f ? feeText(f) : t.shFeeNone}</button>)}
                </div>
                <p className="sh-note">{fee ? `${t.shFeeEx(money(feeOn(100, fee)))} ` : ''}{t.shFeeHow}</p>
              </div>
            ) : <p className="sh-note">{t.shFeeLater}</p>}
            {session && <p className="sh-as"><span>{t.shAs}</span><b>{whoText(lang, { creator: session.address, nick })}</b></p>}
            <p className="sh-label"><Icon name="info" size={14} />{t.shLabel}</p>
            {!session && <p className="bd-alert warn">{t.shLogin}</p>}
            {!pool && <p className="bd-alert warn">{t.shOnlyPool}</p>}
          </>
        )}
        {err && <p className="hire-sub warn" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}

/** "Agents I shared": each with its real hire count and fee, and what the vaults have paid this wallet on-chain. */
export function MyShared({ onBuild }: { onBuild: () => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const session = useSession();
  const { mine, reload } = useMineShared();
  const list = mine && mine !== 'fail' ? mine.agents : [];
  const fees = useFeesShared();
  const live = useMemo(() => list.filter((x) => !x.removedAt).length, [list]);
  const when = (ms: number) => new Date(ms).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  return (
    <section className="sh-mine" aria-labelledby="sh-mine-title">
      <header className="sh-mine-head">
        <h2 id="sh-mine-title">{t.shMineTitle}</h2>
        {list.length > 0 && <span className="bd-count">{live}</span>}
      </header>
      {!session ? <p className="muted">{t.shMineLogin}</p> : mine === 'fail' ? <StateBox title={t.shFail} retry={t.retry} onRetry={reload} compact /> : (
        <>
          <div className="sh-earned">
            <span className="sh-earned-k">{t.shEarned}</span>
            {fees === null ? <b className="wait"><span className="spin" aria-hidden />{t.shChecking}</b>
              : fees.state === 'ok' ? <><b>${money(Number(fees.totalUsdt))} <small>USDT</small></b><small>{t.shEarnedSub(fees.payments, fees.vaults)}</small></>
              : <small className="warn">{t.shUnavail[fees.reason]}</small>}
          </div>
          {mine === null ? <div className="sh-mine-skel skel-block" /> : !list.length ? (
            <p className="sh-mine-empty">{t.shMineEmpty} <button className="btn-text" onClick={onBuild}>{t.navBuild} →</button></p>
          ) : (
            <ul className="sh-mine-list">
              {list.map((s) => (
                <li key={s.id} className={s.removedAt ? 'off' : ''}>
                  <Face rule="made" base={baseOf(s.spec.market)} size="sm" />
                  <span className="sh-mine-name"><b>{s.spec.name}</b><small>{baseOf(s.spec.market)} · {when(s.createdAt)}{s.removedAt ? ` · ${t.shStoppedTag}` : ''}</small></span>
                  <span className="sh-mine-num"><b>{s.hires}</b><small>{t.shHiresK}</small></span>
                  <span className="sh-mine-num"><b>{s.feeBps ? feeText(s.feeBps) : '0%'}</b><small>{t.shPickFee}</small></span>
                  <span className="sh-mine-act">
                    {!s.removedAt && <button className="btn" onClick={() => copy(linkOf(s.id), () => toast(t.copied))}><Icon name="copy" size={16} />{t.shCopyLink}</button>}
                    {!s.removedAt && <button className="btn-text danger" onClick={() => void unpublishShared(s.id).then((ok) => { toast(ok ? t.shStopped : t.shWhy.failed); reload(); })}>{t.shStop}</button>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
