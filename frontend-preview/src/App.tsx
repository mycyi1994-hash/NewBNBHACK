import { useEffect, useReducer, useRef, useState, type Dispatch } from 'react';
import { ASSETS, contributionCents, demoReducer, initialState, money, progress, remaining, type Action, type DemoState, type Receipt } from './model';
import { AssetBadge, CheckBadge, Dialog, Icon, InterestChart, Ledger, MoneyFlow, Panel, Process, ProgressStrip, ReceiptCard, Status } from './components';
import { AnimatedText, useMotion, useNavIndicator, usePageMotion } from './motion';

const tabs = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'earn', label: 'Earn', icon: 'earn' },
  { id: 'invest', label: 'Invest', icon: 'invest' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
] as const;
type Tab = typeof tabs[number]['id'];
function readRoute() {
  const value = window.location.hash.replace(/^#\/?/, '');
  return /^(overview|earn|invest|activity|receipt\/\d+)$/.test(value) ? value : 'overview';
}
const navigate = (route: string) => { window.location.hash = '/' + route; };

function Navigation({ active, mobile = false }: { active: string; mobile?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useNavIndicator(ref, active, mobile);
  return <nav ref={ref} aria-label={mobile ? 'Mobile navigation' : 'Main navigation'} className={mobile ? 'mobile-nav' : 'desktop-nav'}>
    {tabs.map(tab => <a key={tab.id} href={'#/' + tab.id} className={active === tab.id ? 'active' : ''} aria-current={active === tab.id ? 'page' : undefined}>
      {mobile && <Icon name={tab.icon} size={22} />}<span>{tab.label}</span>
    </a>)}<i className="nav-indicator" aria-hidden="true" />
  </nav>;
}
function Stats({ tab, state }: { tab: Tab; state: DemoState }) {
  const values = tab === 'activity' ? [
    ['Example purchases', String(state.receipts.length)],
    ['Total invested', money(state.receipts.reduce((sum, receipt) => sum + receipt.investedCents, 0)) + ' USDT'],
    ['Last carried forward', money(state.receipts[0].carriedCents) + ' USDT'],
  ] : [
    [tab === 'invest' ? 'Funding mode' : 'USDT supplied', tab === 'invest' ? (state.funding === 'interest' ? 'Interest only' : 'Contribution') : '1,000.00 USDT'],
    ['Interest available', money(state.availableCents) + ' USDT'],
    [tab === 'overview' ? 'Next purchase' : 'Purchase threshold', '0.25 USDT'],
  ];
  return <section className="summary-strip" aria-label="Account summary">{values.map(([label, value]) => <div className="summary-stat" key={label}><span>{label}</span><strong><AnimatedText value={value} /></strong></div>)}
    <div className="summary-status">{tab === 'activity' ? <span className="demo-pill">Sample data</span> : <Status>{tab === 'invest' && state.funding === 'contribution' ? 'Contribution mode' : remaining(state.availableCents) ? (tab === 'earn' ? 'Accruing interest' : 'Waiting for interest') : 'Ready for review'}</Status>}</div>
  </section>;
}
function Overview({ state }: { state: DemoState }) {
  const receipt = state.receipts[0];
  const open = () => navigate('receipt/' + receipt.id);
  return <><div className="workspace-grid">
    <section className="visual-workspace">
      <div className="section-heading"><h2>See where your interest goes.</h2><p>{receipt.funding === 'interest' ? 'Previous cycle' : 'Latest contribution'} <span className="separator">·</span> Example</p></div>
      <MoneyFlow receipt={receipt} onOpen={open} />
      <div className="visual-footnote"><Icon name="info" size={16} /><span>{receipt.funding === 'interest' ? 'Only earned interest funds this purchase.' : 'This example purchase uses a separate contribution.'}</span></div>
    </section>
    <ReceiptCard receipt={receipt} onOpen={open} />
  </div><ProgressStrip available={state.availableCents} ticker={state.ticker} onPlan={() => navigate('invest')} /></>;
}
function Earn({ state }: { state: DemoState }) {
  return <><div className="workspace-grid"><section className="visual-workspace">
    <div className="section-heading"><h2>Small interest. Next investment.</h2><p>Current cycle <span className="separator">·</span> Example</p></div>
    <InterestChart available={state.availableCents} carried={state.carriedCents} />
  </section><Panel eyebrow="Earning details" title={remaining(state.availableCents) ? 'Ready at 0.25.' : 'Ready to review.'} waiting>
    <Ledger rows={[
      ['Protocol', 'Venus'], ['Asset', 'USDT'],
      ['New interest', money(state.availableCents - state.carriedCents) + ' USDT'],
      ['Carried forward', money(state.carriedCents) + ' USDT'],
    ]} />
    <div className="panel-total"><span>Available</span><strong>{money(state.availableCents)} USDT</strong></div>
    <p className="panel-note">{remaining(state.availableCents) ? money(remaining(state.availableCents)) + ' USDT more to reach the purchase threshold.' : 'The example has reached its purchase threshold.'}</p>
    <button className="button dark wide" onClick={() => navigate('activity')}>View earning activity<Icon name="arrow" size={18} /></button>
  </Panel></div><ProgressStrip available={state.availableCents} ticker={state.ticker} onPlan={() => navigate('invest')} /></>;
}
function Invest({ state, dispatch, contribution, setContribution, onPreview }: { state: DemoState; dispatch: Dispatch<Action>; contribution: string; setContribution: (value: string) => void; onPreview: () => void }) {
  const isInterest = state.funding === 'interest';
  const amount = contributionCents(contribution);
  return <><div className="workspace-grid"><section className="visual-workspace investment-workspace">
    <div className="section-heading"><h2>{isInterest ? 'Choose what your interest buys.' : 'Choose your next investment.'}</h2><p>Tokenized stocks on BNB Chain</p></div>
    <div className="segmented-control" aria-label="Funding mode">
      <button aria-pressed={isInterest} onClick={() => dispatch({ type: 'funding', funding: 'interest' })}>Interest only</button>
      <button aria-pressed={!isInterest} onClick={() => dispatch({ type: 'funding', funding: 'contribution' })}>Contribution</button>
    </div>
    <div className="asset-options" role="group" aria-label="Choose a stock">{ASSETS.map(asset =>
      <button className={'asset-option ' + (state.ticker === asset.ticker ? 'selected' : '')} key={asset.ticker} aria-pressed={state.ticker === asset.ticker} onClick={() => dispatch({ type: 'asset', ticker: asset.ticker })}>
        {state.ticker === asset.ticker && <span className="asset-selected"><Icon name="check" size={14} /></span>}
        <AssetBadge ticker={asset.ticker} /><strong>{asset.ticker}</strong><span>{asset.name}</span>
      </button>,
    )}</div>
    {isInterest ? <div className="funding-progress">
      <div className="funding-labels"><span>Current cycle</span><div><strong>{money(state.availableCents)} USDT</strong><span>Available now</span></div><div><strong>0.25 USDT</strong><span>Buy threshold</span></div></div>
      <div className="funding-track"><span style={{ transform: 'scaleX(' + progress(state.availableCents) / 100 + ')' }} /><div className="funding-marker" style={{ transform: 'translateX(' + progress(state.availableCents) + '%)' }}><i /></div></div>
      <p>{remaining(state.availableCents) ? money(remaining(state.availableCents)) + ' USDT to go' : 'Threshold reached · Review before execution'}</p>
    </div> : <div className="contribution-field"><label htmlFor="contribution">Example contribution</label><div className="amount-input"><input id="contribution" inputMode="decimal" value={contribution} onChange={event => setContribution(event.target.value)} aria-invalid={amount === null} aria-describedby="contribution-help" /><span>USDT</span></div><p id="contribution-help" className={amount === null ? 'field-error' : ''}>{amount === null ? 'Enter 0.25–1,000.00 USDT, with up to two decimals.' : 'Separate example funds. Your earned interest stays as it is.'}</p></div>}
  </section><Panel eyebrow="Plan preview" title={(isInterest ? 'Interest' : 'Contribution') + ' → ' + state.ticker} waiting>
    <Ledger rows={[
      ['Funding', isInterest ? 'Earned interest' : 'Contribution'], ['Target', state.ticker],
      ['Minimum buy', '0.25 USDT'], [isInterest ? 'Available now' : 'Example amount', (isInterest ? money(state.availableCents) : amount === null ? '—' : money(amount)) + ' USDT'],
      ['Chain', 'BNB Smart Chain'],
    ]} />
    <p className="panel-note">Network fee is estimated before a real execution.</p>
    <button className="button dark wide" disabled={!isInterest && amount === null} onClick={onPreview}>Preview example<Icon name="arrow" size={18} /></button>
    <p className="panel-caption">Illustrative plan · No funds moved</p>
  </Panel></div><Process /></>;
}
type EventItem = { key: string; cycle: number; label: string; amount: number; kind: 'waiting' | 'purchase' | 'earned' | 'carried'; receipt?: Receipt };
function Activity({ state }: { state: DemoState }) {
  const [filter, setFilter] = useState<'all' | 'purchases' | 'waiting'>('all');
  const [selected, setSelected] = useState('purchase-' + state.receipts[0].id);
  const events: EventItem[] = [
    { key: 'current', cycle: state.receipts[0].id + 1, label: remaining(state.availableCents) ? 'Interest accumulating' : 'Threshold reached', amount: state.availableCents, kind: 'waiting' },
    ...state.receipts.flatMap(receipt => [
      { key: 'purchase-' + receipt.id, cycle: receipt.id, label: receipt.ticker + ' purchased', amount: receipt.investedCents, kind: 'purchase' as const, receipt },
      { key: 'earned-' + receipt.id, cycle: receipt.id, label: receipt.funding === 'interest' ? 'Interest collected' : 'Contribution added', amount: receipt.sourceCents, kind: 'earned' as const, receipt },
      { key: 'carried-' + receipt.id, cycle: receipt.id, label: 'Remainder carried', amount: receipt.carriedCents, kind: 'carried' as const, receipt },
    ]),
  ];
  const visible = events.filter(event => filter === 'all' || (filter === 'purchases' ? event.kind === 'purchase' : event.kind === 'waiting'));
  const active = visible.find(event => event.key === selected) || visible[0];
  return <><div className="workspace-grid"><section className="visual-workspace">
    <div className="section-heading"><h2>Every step, accounted for.</h2><p>Trace interest from earning to ownership.</p></div>
    <div className="filter-group" aria-label="Filter activity">{(['all', 'purchases', 'waiting'] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All events' : value === 'purchases' ? 'Purchases' : 'Waiting'}</button>)}</div>
    <div className="activity-table">
      <div className="activity-table-heading" aria-hidden="true"><span>Cycle</span><span>Event</span><span>Amount</span><span>Status</span></div>
      <div className="activity-list" aria-label="Example activity">{visible.map(event => <button className={'activity-row ' + (event.key === active?.key ? 'selected' : '')} aria-pressed={event.key === active?.key} onClick={() => setSelected(event.key)} key={event.key}>
        <span className="cycle-number">{String(event.cycle).padStart(2, '0')}</span>
        <span className="event-label"><span className={'event-icon ' + event.kind}><Icon name={event.kind === 'waiting' ? 'clock' : event.kind === 'earned' ? 'plus' : event.kind === 'carried' ? 'back' : 'check'} /></span><span>{event.label}{event.kind === 'waiting' && <small>Current cycle</small>}</span></span>
        <strong className="event-amount">{money(event.amount)} <small>USDT</small></strong><span className={'event-status ' + (event.kind === 'waiting' ? 'pending' : '')}>{event.kind === 'waiting' ? (remaining(state.availableCents) ? 'Waiting' : 'Ready') : <><Icon name="check" size={16} />Completed</>}</span>
      </button>)}</div>
      <p className="list-caption">Showing {visible.length} example {visible.length === 1 ? 'event' : 'events'}</p>
    </div>
  </section>{active?.receipt ? <ReceiptCard receipt={active.receipt} title={active.kind === 'purchase' ? undefined : active.label} onOpen={() => navigate('receipt/' + active.receipt!.id)} /> : <Panel eyebrow="Current cycle" title={remaining(state.availableCents) ? 'Building toward ' + state.ticker : 'Ready for ' + state.ticker} waiting>
    <Ledger rows={[['Available interest', money(state.availableCents) + ' USDT'], ['Purchase threshold', '0.25 USDT'], ['Remaining', money(remaining(state.availableCents)) + ' USDT'], ['Target asset', state.ticker]]} />
    <p className="panel-note">An example purchase can be reviewed once its funding threshold is reached.</p>
    <button className="button dark wide" onClick={() => navigate('invest')}>View investment plan<Icon name="arrow" size={18} /></button>
  </Panel>}</div><ProgressStrip available={state.availableCents} ticker={state.ticker} onPlan={() => navigate('invest')} /></>;
}
function ReceiptDetails({ receipt }: { receipt?: Receipt }) {
  if (!receipt) return <section className="empty-state"><Icon name="activity" size={36} /><h2>This receipt isn’t in the demo.</h2><p>Example receipts created during a session reset when you reload.</p><button className="button primary" onClick={() => navigate('activity')}>Go to activity</button></section>;
  const trace = [
    [receipt.funding === 'interest' ? 'Collect interest' : 'Add contribution', money(receipt.sourceCents) + ' USDT available for this cycle'],
    ['Simulate purchase', 'Review the expected transaction'],
    ['Review and confirm', 'Approval in the wallet workflow'],
    ['Record outcome', money(receipt.investedCents) + ' reinvested · ' + money(receipt.carriedCents) + ' carried forward'],
  ];
  return <div className="receipt-detail-grid"><section className="receipt-document">
    <div className="document-meta"><span>Sample receipt</span><span>Example cycle {String(receipt.id).padStart(2, '0')}</span></div>
    <div className="document-title"><h2>{receipt.funding === 'interest' ? 'Interest invested.' : 'Contribution invested.'}</h2><CheckBadge /></div>
    <p className="document-subtitle">{money(receipt.investedCents)} USDT used to buy tokenized {receipt.ticker}.</p>
    <div className="document-totals">{[[receipt.funding === 'interest' ? 'Earned' : 'Contributed', receipt.sourceCents], ['Reinvested', receipt.investedCents], ['Carried forward', receipt.carriedCents]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{money(value as number)} <small>USDT</small></strong></div>)}</div>
    <MoneyFlow receipt={receipt} compact />
    <Ledger rows={[['Source', receipt.funding === 'interest' ? 'Venus interest' : 'Example contribution'], ['Purchased asset', receipt.ticker + ' · Tokenized stock'], ['Network', 'BNB Smart Chain'], ['Network fee', 'Quoted separately in BNB']]} />
    <div className="receipt-disclaimer"><Icon name="info" /><span>Illustrative receipt. No live transaction was submitted.</span></div>
    <button className="text-button document-back" onClick={() => navigate('activity')}><Icon name="back" size={18} />Back to activity</button>
  </section><aside className="execution-trace"><p className="eyebrow">Example execution trace</p><h3>From interest to ownership.</h3><ol>{trace.map(([title, body], i) => <li key={title}><CheckBadge /><div><span className="trace-title"><small>{String(i + 1).padStart(2, '0')}</small>{title}</span><p>{body}</p></div></li>)}</ol><p className="trace-caption">Example lifecycle · For design preview</p></aside></div>;
}

export default function App() {
  const [state, dispatch] = useReducer(demoReducer, initialState);
  const [route, setRoute] = useState(readRoute);
  const [contribution, setContribution] = useState('5.00');
  const [modal, setModal] = useState<'intro' | 'preview' | null>(null);
  const [stage, setStage] = useState<'quote' | 'simulating' | 'review' | 'done'>('quote');
  const [expectedCount, setExpectedCount] = useState(1);
  const [notice, setNotice] = useState('');
  const firstRoute = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const pageContent = useRef<HTMLDivElement>(null);
  const motion = useMotion();
  usePageMotion(pageContent, route);
  const details = route.startsWith('receipt/');
  const activeTab = (details ? 'activity' : route) as Tab;
  const amount = state.funding === 'interest' ? 25 : contributionCents(contribution);
  const ready = amount !== null && (state.funding === 'contribution' || state.availableCents >= 25);

  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    document.title = (details ? 'Receipt details' : tabs.find(tab => tab.id === activeTab)?.label) + ' · Yieldvest';
    if (firstRoute.current) { firstRoute.current = false; return; }
    window.scrollTo({ top: 0, behavior: 'instant' });
    heading.current?.focus({ preventScroll: true });
  }, [route, activeTab, details]);
  useEffect(() => {
    if (stage !== 'simulating' || modal !== 'preview') return;
    const timeout = window.setTimeout(() => setStage('review'), 650);
    return () => window.clearTimeout(timeout);
  }, [stage, modal]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  const openPreview = () => { setExpectedCount(state.receipts.length); setStage('quote'); setModal('preview'); };
  const reset = () => { dispatch({ type: 'reset' }); setContribution('5.00'); setNotice('Demo reset. Your sample account is ready.'); navigate('overview'); };
  const confirmExample = () => {
    dispatch({ type: 'purchase', expectedReceiptCount: expectedCount, contribution: amount ?? undefined });
    setStage('done');
  };
  const motionLabel = motion.reduced ? 'Animations disabled by your system preference' : motion.paused ? 'Play animations' : 'Pause animations';
  return <>
    <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
    <div className="app-shell">
      <header className="app-header">
        <a className="brand-lockup" href="#/overview" aria-label="Yieldvest overview">
          <span className="yieldvest-logo"><img className="yieldvest-mark" src={import.meta.env.BASE_URL + 'yieldvest-mark.svg'} alt="" width="44" height="44" /><span className="wordmark">Yieldvest</span></span>
          <span className="brand-divider" aria-hidden="true" />
          <span className="chain-lockup"><span className="built-on">Built on</span><img src={import.meta.env.BASE_URL + 'bnb-chain.svg'} alt="BNB Chain" width="174" height="31" /></span>
        </a>
        <Navigation active={activeTab} />
      </header>
      <main id="main" tabIndex={-1}>
        <div className="page-toolbar"><div>{details && <a className="back-link" href="#/activity"><Icon name="back" size={16} />Activity</a>}<h1 ref={heading} tabIndex={-1}>{details ? 'Receipt details' : tabs.find(tab => tab.id === activeTab)?.label}</h1></div><div className="toolbar-actions"><span className="demo-pill"><span />Illustrative demo</span><button className="icon-button motion-toggle" onClick={motion.toggle} disabled={motion.reduced} aria-label={motionLabel} title={motionLabel} aria-pressed={motion.enabled}><Icon name={motion.enabled ? 'pause' : 'play'} size={17} /></button><button className="icon-button reset-button" onClick={reset} aria-label="Reset demo" title="Reset demo"><Icon name="reset" size={17} /></button><button className="button primary" onClick={() => setModal('intro')}>Explore demo<Icon name="right" size={17} /></button></div></div>
        {!details && <Stats tab={activeTab} state={state} />}
        <div ref={pageContent} className="page-content" key={route}>
          {details ? <ReceiptDetails receipt={state.receipts.find(receipt => receipt.id === Number(route.split('/')[1]))} /> :
            activeTab === 'overview' ? <Overview state={state} /> :
            activeTab === 'earn' ? <Earn state={state} /> :
            activeTab === 'invest' ? <Invest state={state} dispatch={dispatch} contribution={contribution} setContribution={setContribution} onPreview={openPreview} /> :
            <Activity state={state} />}
        </div>
      </main>
      <footer className="app-footer"><span>Principal tracked separately.</span><span>Network fee shown before execution.</span><span>Capital at risk.</span></footer>
    </div>
    <Navigation active={activeTab} mobile />
    {notice && <div className="toast" role="status"><Icon name="check" size={18} />{notice}</div>}
    {modal === 'intro' && <Dialog onClose={() => setModal(null)} titleId="demo-title">
      <span className="dialog-symbol"><Icon name="invest" size={28} /></span><p className="eyebrow">Interactive example</p><h2 id="demo-title">Interest becomes ownership.</h2><p className="dialog-lead">Follow one sample cycle from earning interest to a stock purchase.</p>
      <ol className="demo-steps"><li><span>1</span><div><strong>Build your interest</strong><p>Start with {money(state.availableCents)} USDT. Add a little sample interest to reach the 0.25 USDT threshold.</p></div></li><li><span>2</span><div><strong>Review a stock purchase</strong><p>Choose a stock and step through an example simulation.</p></div></li><li><span>3</span><div><strong>Inspect your receipt</strong><p>See exactly what was invested and what carried forward.</p></div></li></ol>
      <div className="demo-balance"><span>Available interest</span><strong>{money(state.availableCents)} USDT</strong></div>
      <div className="dialog-actions"><button className="button secondary" onClick={() => dispatch({ type: 'accrue' })}><Icon name="plus" size={18} />Add 0.10 USDT</button><button className="button primary" onClick={() => { setModal(null); navigate('invest'); }}>Choose a stock<Icon name="right" size={18} /></button></div>
      <p className="dialog-caption">Sample data only. No wallet connection or funds moved.</p>
    </Dialog>}
    {modal === 'preview' && <Dialog onClose={() => setModal(null)} titleId="preview-title">
      {stage === 'done' ? <>
        <span className="dialog-symbol"><Icon name="check" size={30} /></span><p className="eyebrow">Example complete</p><h2 id="preview-title">{state.receipts[0].ticker} purchased.</h2><p className="dialog-lead">Your sample receipt is ready. No live transaction was submitted.</p>
        <Ledger rows={[['Reinvested', money(state.receipts[0].investedCents) + ' USDT'], ['Carried forward', money(state.receipts[0].carriedCents) + ' USDT'], ['Network', 'BNB Smart Chain']]} />
        <button className="button primary wide" onClick={() => { setModal(null); navigate('receipt/' + state.receipts[0].id); }}>View sample receipt<Icon name="arrow" size={18} /></button>
      </> : <>
        <AssetBadge ticker={state.ticker} /><p className="eyebrow">Sample purchase</p><h2 id="preview-title">Review {state.ticker}.</h2><p className="dialog-lead">A walkthrough of the purchase flow, using example funds.</p>
        <Ledger rows={[['Funding', state.funding === 'interest' ? 'Earned interest' : 'Contribution'], ['Purchase amount', amount === null ? 'Invalid amount' : money(amount) + ' USDT'], ['Asset', state.ticker + ' · Tokenized stock'], ['Network fee', 'Not estimated in this demo']]} />
        <Process current={stage === 'quote' ? 0 : stage === 'simulating' ? 1 : 2} />
        <div className="preview-state" role="status">{!ready ? <><Icon name="clock" /><span>Add {money(remaining(state.availableCents))} USDT of sample interest to reach the threshold.</span></> : stage === 'simulating' ? <><span className="spinner" /><span>Running the example simulation…</span></> : stage === 'review' ? <><Icon name="check" /><span>Example simulation complete. Ready for your review.</span></> : <><Icon name="info" /><span>Simulate the example before confirming it.</span></>}</div>
        <button className="button primary wide" disabled={stage === 'simulating' || amount === null} onClick={() => !ready ? dispatch({ type: 'accrue' }) : stage === 'review' ? confirmExample() : setStage('simulating')}>
          {!ready ? 'Add 0.10 USDT of sample interest' : stage === 'simulating' ? 'Simulating example' : stage === 'review' ? 'Confirm example purchase' : 'Simulate example'}{stage !== 'simulating' && <Icon name="right" size={18} />}
        </button>
        <p className="dialog-caption">Frontend demo only. Confirmation does not move funds.</p>
      </>}
    </Dialog>}
  </>;
}
