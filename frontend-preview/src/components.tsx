import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { money, progress, remaining, type Receipt, type Ticker } from './model';
import { AnimatedText, animateElement, canAnimate, useInView, useMotion } from './motion';

type IconName = 'check' | 'arrow' | 'right' | 'back' | 'close' | 'home' | 'earn' | 'invest' | 'activity' | 'info' | 'reset' | 'plus' | 'clock' | 'pause' | 'play';
const iconPaths: Record<IconName, ReactNode> = {
  check: <path d="m5 12 4 4L19 6" />,
  arrow: <><path d="M6 18 18 6M6 6h12v12" /></>,
  right: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
  back: <path d="M20 12H4m6-6-6 6 6 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  home: <path d="m3 10 9-7 9 7v11h-6v-8H9v8H3Z" />,
  earn: <path d="M4 20V12m5 8V5m6 15V9m5 11V2" />,
  invest: <><path d="M12 3v9h9A9 9 0 1 1 12 3Z" /><path d="M16 3.9A9 9 0 0 1 20.1 8H16Z" /></>,
  activity: <><path d="M5 3h10l4 4v14H5Z" /><path d="M14 3v5h5M8 12h8M8 16h6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></>,
  reset: <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" /></>,
  plus: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M7 12h10" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  pause: <><path d="M8 5v14M16 5v14" strokeWidth="2.5" /></>,
  play: <path d="m8 4 12 8-12 8Z" />,
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>;
}
export function AssetBadge({ ticker, small = false }: { ticker: Ticker | 'USDT'; small?: boolean }) {
  return <span className={'asset-badge ' + (ticker === 'USDT' ? 'usdt ' : '') + (small ? 'small' : '')} aria-hidden="true">
    {ticker === 'USDT' ? <svg viewBox="0 0 48 48" fill="none"><path d="M12 11h24v6h-9v23h-6V17h-9Z" fill="currentColor" /><ellipse cx="24" cy="24" rx="17" ry="4" stroke="currentColor" strokeWidth="2.5" /></svg> : ticker === 'NVDA' ? 'N' : ticker === 'TSLA' ? 'T' : ticker === 'MSFT' ? 'M' : 'Q'}
  </span>;
}
export function Status({ children, complete = false }: { children: ReactNode; complete?: boolean }) {
  return <span className={'status ' + (complete ? 'complete' : '')}><span className="status-dot" />{children}</span>;
}
export function CheckBadge({ waiting = false }: { waiting?: boolean }) {
  return <span className={'check-badge ' + (waiting ? 'waiting' : '')}>{!waiting && <Icon name="check" size={24} />}</span>;
}
export function Ledger({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="ledger">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === 'string' ? <AnimatedText value={value} /> : value}</dd></div>)}</dl>;
}
export function Panel({ eyebrow, title, children, waiting = false, className = '' }: { eyebrow: string; title: string; children: ReactNode; waiting?: boolean; className?: string }) {
  return <aside className={'receipt-panel ' + className}><div className="panel-heading"><div><p className="eyebrow">{eyebrow}</p><h3>{title}</h3></div><CheckBadge waiting={waiting} /></div>{children}</aside>;
}
export function ReceiptCard({ receipt, onOpen, title }: { receipt: Receipt; onOpen: () => void; title?: string }) {
  return <Panel eyebrow="Sample receipt" title={title || receipt.ticker + ' purchased'}>
    <p className="panel-cycle">Example cycle {String(receipt.id).padStart(2, '0')}</p>
    <Ledger rows={[
      ['Source', receipt.funding === 'interest' ? 'Venus interest' : 'Contribution'],
      [receipt.funding === 'interest' ? 'Interest earned' : 'Contributed', money(receipt.sourceCents) + ' USDT'],
      ['Reinvested', money(receipt.investedCents) + ' USDT'],
      ['Carried forward', money(receipt.carriedCents) + ' USDT'],
      ['Chain', 'BNB Smart Chain'],
    ]} />
    <p className="panel-note">Illustrative cycle. No live transaction submitted.</p>
    <button className="button dark wide" onClick={onOpen}>Inspect sample receipt<Icon name="arrow" size={18} /></button>
  </Panel>;
}
export function MoneyFlow({ receipt, onOpen, compact = false }: { receipt: Receipt; onOpen?: () => void; compact?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const ribbon = useRef<SVGGElement>(null);
  const { enabled, visible } = useMotion();
  const inView = useInView(ref);
  const flowing = enabled && visible && inView && !compact;
  const mainPath = 'M99 170H420C565 170 557 83 704 83H772';
  const remainderPath = 'M99 170H395C571 170 561 271 704 271H772';
  useLayoutEffect(() => {
    if (!ribbon.current || !canAnimate() || compact) return;
    const animation = animateElement(ribbon.current, [
      { clipPath: 'inset(0 100% 0 0)', opacity: 0.45 },
      { clipPath: 'inset(0 0% 0 0)', opacity: 1 },
    ], 1400);
    animation.id = 'ijaro-flow-reveal';
    return () => animation.cancel();
  }, [receipt.id, compact]);
  return <div ref={ref} className={'money-flow ' + (compact ? 'compact' : '')} data-flowing={flowing}>
    <svg className="flow-lines" viewBox="0 0 900 320" preserveAspectRatio="none" role="img" aria-labelledby={id}>
      <title id={id}>{money(receipt.sourceCents)} USDT split into {money(receipt.investedCents)} USDT for {receipt.ticker} and {money(receipt.carriedCents)} USDT carried forward.</title>
      <path d={mainPath} fill="none" stroke="var(--yellow)" strokeOpacity="0.12" strokeWidth="26" />
      <g ref={ribbon}>
        <path className="flow-main" d={mainPath} fill="none" stroke="var(--yellow)" strokeWidth="26" />
        <path d={mainPath} fill="none" stroke="#fff9cf" strokeOpacity="0.2" strokeWidth="1" />
        {receipt.carriedCents > 0 && <path d="M417 180C571 180 561 271 704 271H772" fill="none" stroke="var(--yellow)" strokeWidth="3" />}
      </g>
      {flowing && <g className="flow-particles" aria-hidden="true">
        {[0, 1.8, 3.6].map(delay => <g key={delay} opacity="0">
          <circle r="12" fill="#fff" opacity="0.07" /><circle r="5" fill="#fff8ce" opacity="0.8" /><circle r="2" fill="#fff" />
          <animateMotion path={mainPath} dur="5.4s" begin={delay + 's'} repeatCount="indefinite" calcMode="paced" />
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.82;1" dur="5.4s" begin={delay + 's'} repeatCount="indefinite" />
        </g>)}
        {receipt.carriedCents > 0 && <g opacity="0">
          <circle r="3" fill="#fff8ce" />
          <animateMotion path={remainderPath} dur="6s" begin="1.2s" repeatCount="indefinite" calcMode="paced" />
          <animate attributeName="opacity" values="0;0.9;0.9;0" keyTimes="0;0.12;0.8;1" dur="6s" begin="1.2s" repeatCount="indefinite" />
        </g>}
      </g>}
    </svg>
    <button className="flow-node source" onClick={onOpen} disabled={!onOpen} aria-label="Inspect the funding source">
      <AssetBadge ticker="USDT" />
      <span className="flow-label"><strong>{money(receipt.sourceCents)} <small>USDT</small></strong><span>{receipt.funding === 'interest' ? 'Interest earned' : 'Contributed'}</span></span>
    </button>
    <button className="flow-node destination" onClick={onOpen} disabled={!onOpen} aria-label={'Inspect the ' + receipt.ticker + ' purchase'}>
      <AssetBadge ticker={receipt.ticker} />
      <span className="flow-label"><strong>{money(receipt.investedCents)} <small>USDT</small></strong><span>Reinvested into {receipt.ticker}</span></span>
    </button>
    <div className="flow-node remainder"><span className="hollow-node" /><span className="flow-label"><strong>{money(receipt.carriedCents)} <small>USDT</small></strong><span>Carried forward</span></span></div>
  </div>;
}
export function ProgressStrip({ available, ticker, onPlan }: { available: number; ticker: Ticker; onPlan: () => void }) {
  const ready = !remaining(available);
  return <section className="progress-strip" aria-label="Progress toward the next purchase">
    <span className="progress-orbit" aria-hidden="true" />
    <div className="progress-description"><span>Next cycle · {ticker}</span><strong><AnimatedText value={money(available)} /> <span>of 0.25 USDT</span></strong></div>
    <div className="progress-track" role="progressbar" aria-label="Purchase threshold" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress(available))}><span style={{ transform: 'scaleX(' + progress(available) / 100 + ')' }} /></div>
    <button className="text-button progress-action" onClick={onPlan}>{ready ? 'Ready to review' : money(remaining(available)) + ' USDT to go'}<Icon name="right" size={18} /></button>
  </section>;
}
export function InterestChart({ available, carried }: { available: number; carried: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const plot = useRef<SVGPolylineElement>(null);
  useLayoutEffect(() => {
    if (!plot.current || !canAnimate()) return;
    const animation = animateElement(plot.current, [
      { clipPath: 'inset(0 100% 0 0)' },
      { clipPath: 'inset(0 0 0 0)' },
    ], 1000);
    animation.id = 'ijaro-chart-reveal';
    return () => animation.cancel();
  }, []);
  const ceiling = Math.max(25, available);
  const points = [0, 0.06, 0.24, 0.47, 0.72, 1].map((ratio, index) => ({
    x: 38 + index * 141,
    cents: Math.round(carried + (available - carried) * ratio),
  }));
  const y = (value: number) => 298 - value / ceiling * 248;
  const selected = points[hover ?? 5];
  return <div className="interest-chart">
    <svg viewBox="0 0 810 348" role="img" aria-labelledby={id} onMouseLeave={() => setHover(null)} onMouseMove={(event) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      setHover(Math.max(0, Math.min(5, Math.round(((event.clientX - bounds.left) / bounds.width * 810 - 38) / 141))));
    }}>
      <title id={id}>Example interest rises from {money(carried)} to {money(available)} USDT. Purchase threshold is 0.25 USDT.</title>
      <line x1="38" y1={y(25)} x2="780" y2={y(25)} className="chart-rule target" />
      <text x="779" y={y(25) - 15} textAnchor="end" className="chart-label">0.25 USDT · Buy threshold</text>
      <line x1="38" y1="298" x2="780" y2="298" className="chart-rule" />
      <line x1="38" y1={y(available)} x2="780" y2={y(available)} className="chart-rule subtle" />
      <polyline ref={plot} points={points.map(point => point.x + ',' + y(point.cents)).join(' ')} fill="none" stroke="var(--yellow)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="38" cy={y(carried)} r="6" fill="var(--yellow)" />
      <circle cx={selected.x} cy={y(selected.cents)} r="7" fill="var(--yellow)" />
      <rect x={Math.min(620, Math.max(38, selected.x - 110))} y={Math.max(65, y(selected.cents) - 51)} width="160" height="34" rx="7" fill="#1c2227" stroke="#343c43" />
      <text x={Math.min(620, Math.max(38, selected.x - 110)) + 80} y={Math.max(65, y(selected.cents) - 51) + 22} textAnchor="middle" className="chart-tooltip">{money(selected.cents)} USDT</text>
      <text x="38" y="333" className="chart-label">Cycle start</text>
      <text x="743" y="333" textAnchor="end" className="chart-label">Now</text>
    </svg>
    <div className="chart-legend"><span><i />Carried forward · {money(carried)} USDT</span><span><i />New interest · {money(available - carried)} USDT</span></div>
  </div>;
}
export function Process({ current = -1 }: { current?: number }) {
  return <div className="process-strip"><span className="process-caption">When ready</span>{['Quote', 'Simulate', 'Review', 'Confirm'].map((step, i) => <div className={'process-step ' + (i <= current ? 'active' : '')} key={step}><span className="process-node">{i < current && <Icon name="check" size={12} />}</span><span>{step}</span></div>)}</div>;
}
export function Dialog({ children, onClose, titleId }: { children: ReactNode; onClose: () => void; titleId: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const animation = useRef<Animation | null>(null);
  const closing = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    if (canAnimate()) animation.current = animateElement(dialog, [
      { opacity: 0, transform: 'translateY(12px) scale(0.97)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ], 250);
    return () => {
      mounted.current = false;
      animation.current?.cancel();
      dialog.close();
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, []);
  const close = () => {
    if (closing.current) return;
    if (!ref.current || !canAnimate()) { onClose(); return; }
    closing.current = true;
    const style = getComputedStyle(ref.current);
    const from = { opacity: style.opacity, transform: style.transform };
    animation.current?.cancel();
    animation.current = animateElement(ref.current, [from, { opacity: 0, transform: 'translateY(12px) scale(0.97)' }], 160);
    const finish = () => { if (mounted.current) onClose(); };
    void animation.current.finished.then(finish, finish);
  };
  return <dialog ref={ref} className="demo-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-content"><button className="icon-button dialog-close" onClick={close} aria-label="Close dialog"><Icon name="close" /></button>{children}</div>
  </dialog>;
}
