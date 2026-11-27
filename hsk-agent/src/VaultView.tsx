// A read-only page for any Moa vault, opened as ?vault=0x…: what it holds, the limits and stop-loss its owner set,
// and everything it has done, read from HSK Chain and its explorer with no login. Without an address it lists every
// vault Moa's factories have made. Nothing on this page comes from the app's own records.
import { useEffect, useState } from 'react';
import { useT } from './i18n.ts';
import type { Quote } from './market.ts';
import { Icon } from './Icons.tsx';
import { CopyAddress, StateBox } from './ui.tsx';
import RunnerPanel from './RunnerPanel.tsx';
import { useHired } from './store.ts';
import { asVault, EXPLORER, listVaults, readVault, vaultHistory, vaultLink, type VaultEvent, type VaultListing, type VaultSnapshot } from './vaultRead.ts';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: v >= 1000 ? 0 : 2, maximumFractionDigits: 2 })}`;
const qty = (v: number) => (v >= 1 ? Number(v.toFixed(4)).toString() : Number(v.toPrecision(4)).toString());
const loc = () => (document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR');
const when = (t: number) => new Date(t).toLocaleString(loc(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const txLink = (tx: string) => `${EXPLORER}/tx/${tx}`;
const addrLink = (a: string) => `${EXPLORER}/address/${a}`;

export default function VaultView({ address, quotes }: { address: string | null; quotes: Quote[] }) {
  const v = asVault(address);
  return v ? <OneVault address={v} quotes={quotes} /> : <AllVaults bad={!!address} />;
}

function AllVaults({ bad }: { bad: boolean }) {
  const { t } = useT();
  const [list, setList] = useState<VaultListing[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => { listVaults().then(setList, () => setFailed(true)); }, []);
  const go = (a: string) => { window.location.search = `?vault=${a}`; };
  return (
    <div className="page vv-page">
      <header className="page-head"><h1>{t.vvTitle}</h1></header>
      <p className="page-sub">{t.vvSub}</p>
      {bad && <p className="vv-warn">{t.vvBad}</p>}
      <form className="vv-find" onSubmit={(e) => { e.preventDefault(); const a = asVault(text); if (a) go(a); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="0x…" aria-label={t.vvFind} spellCheck={false} />
        <button className="btn-primary" disabled={!asVault(text)}>{t.vvOpen}</button>
      </form>
      <section className="vv-card">
        <header className="vv-head"><b>{t.vvAll}</b><small>{t.vvAllSub}</small></header>
        {failed && <StateBox compact title={t.vvFailed} />}
        {!list && !failed && <div className="vv-skel skel-block" />}
        {list && (
          <ol className="vv-list">
            {list.map((x) => (
              <li key={x.vault}>
                <a href={`?vault=${x.vault}`}>
                  <span className="vv-mono">{short(x.vault)}</span>
                  <small>{t.vvOwner} {short(x.owner)} · {t.vvMade(when(x.at))} · {t.vvFactory(x.factory)}</small>
                  <Icon name="chevron" size={16} />
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function OneVault({ address, quotes }: { address: `0x${string}`; quotes: Quote[] }) {
  const { t } = useT();
  const { hired } = useHired();
  const [snap, setSnap] = useState<VaultSnapshot | null>(null);
  const [events, setEvents] = useState<VaultEvent[] | null>(null);
  const [failed, setFailed] = useState<'' | 'vault' | 'history'>('');
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    readVault(address).then((s) => {
      if (!alive) return;
      setSnap(s);
      vaultHistory(address, s.owner).then((e) => alive && setEvents(e), () => alive && setFailed('history'));
    }, () => alive && setFailed('vault'));
    return () => { alive = false; };
  }, [address, n]);

  if (failed === 'vault') return <div className="page vv-page"><header className="page-head"><h1>{t.vvTitle}</h1></header><StateBox title={t.vvNotVault} text={address} retry={t.retry} onRetry={() => { setFailed(''); setN((x) => x + 1); }} /></div>;

  // Coins at the vault's own pool value (version 2+), or at the live pool price for a first-version vault.
  const valueOf = (h: VaultSnapshot['holdings'][number]) => h.valueUsdt ?? (quotes.find((q) => q.asset === h.asset)?.pool ?? 0) * h.qty;
  const total = snap ? snap.usdt + snap.holdings.reduce((s, h) => s + valueOf(h), 0) : 0;
  const limits = snap && (snap.maxTradeUsdt !== undefined || snap.maxDailyUsdt !== undefined);
  const trades = events?.filter((e) => e.k === 'trade') ?? [];

  return (
    <div className="page vv-page">
      <header className="page-head">
        <h1>{t.vvTitle}</h1>
        <button className="btn" onClick={() => { setSnap(null); setEvents(null); setN((x) => x + 1); }}><Icon name="undo" size={14} />{t.vvRefresh}</button>
      </header>
      <p className="page-sub">{t.vvReadOnly}</p>

      <section className="vv-card vv-top">
        <div className="vv-id">
          <span className="vv-ic" aria-hidden><Icon name="shield" size={20} /></span>
          <span>
            <b className="vv-mono">{short(address)}</b>
            <small>{snap ? `${t.vvVersion(snap.version)} · ${t.vvOwner} ${short(snap.owner)}` : '…'}</small>
          </span>
          <span className="vv-links">
            <CopyAddress value={address} label={t.copyAddress} done={t.addressCopied} />
            <a href={addrLink(address)} target="_blank" rel="noreferrer">{t.vcExplorer} ↗</a>
          </span>
        </div>
        <dl className="vv-nums">
          <div className="lead"><dt>{t.vvTotal}</dt><dd>{snap ? usd(total) : <i className="skel" style={{ width: 90 }} />}</dd></div>
          <div><dt>USDT</dt><dd>{snap ? usd(snap.usdt) : <i className="skel" style={{ width: 60 }} />}</dd></div>
          {snap?.holdings.map((h) => (
            <div key={h.symbol}>
              <dt>{h.symbol}</dt>
              <dd>{usd(valueOf(h))}</dd>
              <small>{qty(h.qty)} {h.symbol}{h.costUsdt ? ` · ${t.vvCost(usd(h.costUsdt))}` : ''}</small>
            </div>
          ))}
          {snap && !snap.holdings.length && <div><dt>{t.vvCoins}</dt><dd className="muted-dd">{t.vvNoCoins}</dd></div>}
        </dl>
      </section>

      <section className="vv-card">
        <header className="vv-head"><b>{t.vvSafety}</b><small>{t.vvSafetySub}</small></header>
        {!snap ? <div className="vv-skel skel-block" /> : (
          <ul className="vv-rules">
            <li className={limits ? 'ok' : 'warn'}>
              <span>{t.vvLimits}</span>
              <b>{limits ? [snap.maxTradeUsdt !== undefined ? t.limTrade(String(snap.maxTradeUsdt)) : '', snap.maxDailyUsdt !== undefined ? t.limDay(String(snap.maxDailyUsdt)) : ''].filter(Boolean).join(' · ') : t.vvNoLimit}</b>
              {snap.remainingToday !== undefined && <small>{t.vcSide(String(snap.remainingToday))}</small>}
            </li>
            <li className={snap.stopLossBps ? 'ok' : 'off'}>
              <span>{t.vvStop}</span>
              <b>{snap.stopLossBps === undefined ? t.vvStopNone : snap.stopLossBps ? `−${snap.stopLossBps / 100}%` : t.vvOff}</b>
            </li>
            {snap.slippageBps !== undefined && <li className="ok"><span>{t.vvSlip}</span><b>{(snap.slippageBps / 100).toFixed(1)}%</b></li>}
            <li className={snap.paused ? 'warn' : 'ok'}><span>{t.vvTrading}</span><b>{snap.paused ? t.vvPaused : t.vvOpenNow}</b></li>
            <li className="ok"><span>{t.vvWithdraw}</span><b>{t.vvOwnerOnly}</b><a href={addrLink(snap.owner)} target="_blank" rel="noreferrer">{short(snap.owner)} ↗</a></li>
            {snap.agent && <li className="ok"><span>{t.vvAgent}</span><b>{t.vvAgentCan}</b><a href={addrLink(snap.agent)} target="_blank" rel="noreferrer">{short(snap.agent)} ↗</a></li>}
          </ul>
        )}
      </section>

      {snap && <RunnerPanel hired={hired} owner={snap.owner} />}

      <section className="vv-card">
        <header className="vv-head"><b>{t.vvHistory}</b><small>{events ? t.vvHistorySub(events.length, trades.length) : ''}</small></header>
        {failed === 'history' && <StateBox compact title={t.vvFailed} />}
        {!events && failed !== 'history' && <div className="vv-skel skel-block" />}
        {events && !events.length && <p className="vv-empty">{t.vvNone}</p>}
        {events && events.length > 0 && (
          <ol className="vv-events">
            {events.map((e, i) => <EventRow key={`${e.tx}-${i}`} e={e} />)}
          </ol>
        )}
      </section>
      <p className="muted small">{t.vvFoot} <a href={vaultLink(address)}>{vaultLink(address)}</a></p>
    </div>
  );
}

function EventRow({ e }: { e: VaultEvent }) {
  const { t } = useT();
  let icon: 'plus' | 'trend' | 'dip' | 'stop' | 'shield' | 'pause' | 'play' | 'bot' | 'coin' = 'shield', title = '', detail = '', cls = '';
  switch (e.k) {
    case 'trade':
      icon = e.side === 'buy' ? 'trend' : 'dip'; cls = e.side;
      title = e.side === 'buy' ? t.vvBuy(qty(e.qty), e.symbol, usd(e.usdt)) : t.vvSell(qty(e.qty), e.symbol, usd(e.usdt));
      detail = e.agent ? t.vvByAgent(e.agent.name, e.agent.why, e.agent.auto) : e.note;
      break;
    case 'stopOut': icon = 'stop'; cls = 'sell'; title = t.vvStopOut(qty(e.qty), e.symbol, usd(e.usdt)); break;
    case 'deposit': icon = 'plus'; title = t.vvDeposit(qty(e.amount), e.symbol); break;
    case 'withdraw': icon = 'coin'; title = t.vvWithdrew(qty(e.amount), e.symbol); break;
    case 'limits': title = t.vvLimitsSet; detail = [e.maxTradeUsdt !== undefined ? t.limTrade(String(e.maxTradeUsdt)) : t.vvNoTradeLimit, e.maxDailyUsdt !== undefined ? t.limDay(String(e.maxDailyUsdt)) : t.vvNoDayLimit, `${t.vvSlip} ${(e.slippageBps / 100).toFixed(1)}%`].join(' · '); break;
    case 'stopSet': title = e.bps ? t.vvStopSet(String(e.bps / 100)) : t.vvStopOff; break;
    case 'paused': icon = e.on ? 'pause' : 'play'; title = e.on ? t.vvLocked : t.vvUnlocked; break;
    case 'agentSet': icon = 'bot'; title = t.vvAgentSet; detail = short(e.agent); break;
    case 'creatorPaid': icon = 'coin'; title = t.vvCreatorPaid(usd(e.usdt)); detail = short(e.creator); break;
  }
  return (
    <li className={`vv-ev ${e.k} ${cls}`}>
      <span className="vv-ev-ic" aria-hidden><Icon name={icon} size={16} /></span>
      <span className="vv-ev-main"><b>{title}</b>{detail && <small>{detail}</small>}</span>
      <time>{when(e.at)}</time>
      <a href={txLink(e.tx)} target="_blank" rel="noreferrer">{t.viewTx} ↗</a>
    </li>
  );
}
