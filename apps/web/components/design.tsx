'use client';
/**
 * The approved design's moving parts (frontend-preview/src/components.tsx), fed with real values:
 * the interest flow, the progress toward the next buy, the interest chart and the dialog. Every
 * number arrives as display text from the server; these components only draw and animate it.
 * Nothing here computes, estimates or fills in a value.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { AnimatedText, animateElement, canAnimate, useInView, useMotion } from './motion';

export function AssetBadge({ ticker, small = false }: { ticker: string; small?: boolean }) {
  const usdt = ticker === 'USDT';
  return (
    <span
      className={`asset-badge ${usdt ? 'usdt' : ''} ${small ? 'small' : ''}`}
      aria-hidden="true"
    >
      {usdt ? (
        <svg viewBox="0 0 48 48" fill="none">
          <path d="M12 11h24v6h-9v23h-6V17h-9Z" fill="currentColor" />
          <ellipse cx="24" cy="24" rx="17" ry="4" stroke="currentColor" strokeWidth="2.5" />
        </svg>
      ) : (
        ticker.slice(0, 1)
      )}
    </span>
  );
}

const TRUNK = 'M99 170H420';
const BRANCH = 'M420 170C565 170 557 83 704 83H772';
const MAIN = `${TRUNK}C565 170 557 83 704 83H772`;
const REMAINDER_LINE = 'M417 180C571 180 561 271 704 271H772';
const REMAINDER_PATH = 'M99 170H395C571 170 561 271 704 271H772';

export interface FlowValue {
  /** Display text ("0.46"), or null when it cannot be read (the flow then shows "—"). */
  text: string | null;
  label: string;
  /** Whether anything flowed this way (draws the ribbon; a zero keeps only its outline). */
  flows: boolean;
}

/**
 * Where the interest went: earned → reinvested into the stock, with what is carried forward.
 * The shape is the approved one; a branch with nothing in it is drawn as an outline.
 */
export function MoneyFlow({
  title,
  unit,
  ticker,
  source,
  destination,
  remainder,
  href,
  compact = false,
}: {
  title: string;
  unit: string;
  ticker: string;
  source: FlowValue;
  destination: FlowValue;
  /** What is carried forward; left out for a single purchase, whose remainder is not recorded. */
  remainder?: FlowValue;
  /** Where a click on the source or the stock leads (the receipt or the plan). */
  href?: string;
  compact?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const ribbon = useRef<SVGGElement>(null);
  const { enabled, visible } = useMotion();
  const inView = useInView(ref);
  const flowing = enabled && visible && inView && !compact && destination.flows;
  const empty = !source.flows && !destination.flows && !remainder?.flows;
  useLayoutEffect(() => {
    if (!ribbon.current || !canAnimate() || compact) return;
    const animation = animateElement(
      ribbon.current,
      [
        { clipPath: 'inset(0 100% 0 0)', opacity: 0.45 },
        { clipPath: 'inset(0 0% 0 0)', opacity: 1 },
      ],
      1400,
    );
    animation.id = 'yieldvest-flow-reveal';
    return () => animation.cancel();
  }, [compact, destination.text, remainder?.text]);
  const value = (v: FlowValue) =>
    v.text === null ? (
      <strong>—</strong>
    ) : (
      <strong>
        {v.text} <small>{unit}</small>
      </strong>
    );
  const node = (className: string, label: string, children: ReactNode) =>
    href ? (
      <Link className={`flow-node ${className}`} href={href} aria-label={label}>
        {children}
      </Link>
    ) : (
      <div className={`flow-node ${className}`}>{children}</div>
    );
  return (
    <div
      ref={ref}
      className={`money-flow ${compact ? 'compact' : ''} ${empty ? 'empty' : ''}`}
      data-flowing={flowing}
    >
      <svg
        className="flow-lines"
        viewBox="0 0 900 320"
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={id}
      >
        <title id={id}>{title}</title>
        <path d={MAIN} fill="none" stroke="var(--yellow)" strokeOpacity="0.12" strokeWidth="26" />
        <g ref={ribbon}>
          {source.flows ? (
            <path d={TRUNK} fill="none" stroke="var(--yellow)" strokeWidth="26" />
          ) : null}
          {destination.flows ? (
            <>
              <path
                className="flow-main"
                d={BRANCH}
                fill="none"
                stroke="var(--yellow)"
                strokeWidth="26"
              />
              <path d={MAIN} fill="none" stroke="#fff9cf" strokeOpacity="0.2" strokeWidth="1" />
            </>
          ) : (
            <path
              d={BRANCH}
              fill="none"
              stroke="var(--yellow)"
              strokeOpacity="0.55"
              strokeWidth="1.5"
              strokeDasharray="6 7"
            />
          )}
          {remainder?.flows ? (
            <path d={REMAINDER_LINE} fill="none" stroke="var(--yellow)" strokeWidth="3" />
          ) : null}
        </g>
        {flowing ? (
          <g className="flow-particles" aria-hidden="true">
            {[0, 1.8, 3.6].map((delay) => (
              <g key={delay} opacity="0">
                <circle r="12" fill="#fff" opacity="0.07" />
                <circle r="5" fill="#fff8ce" opacity="0.8" />
                <circle r="2" fill="#fff" />
                <animateMotion
                  path={MAIN}
                  dur="5.4s"
                  begin={`${delay}s`}
                  repeatCount="indefinite"
                  calcMode="paced"
                />
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.12;0.82;1"
                  dur="5.4s"
                  begin={`${delay}s`}
                  repeatCount="indefinite"
                />
              </g>
            ))}
            {remainder?.flows ? (
              <g opacity="0">
                <circle r="3" fill="#fff8ce" />
                <animateMotion
                  path={REMAINDER_PATH}
                  dur="6s"
                  begin="1.2s"
                  repeatCount="indefinite"
                  calcMode="paced"
                />
                <animate
                  attributeName="opacity"
                  values="0;0.9;0.9;0"
                  keyTimes="0;0.12;0.8;1"
                  dur="6s"
                  begin="1.2s"
                  repeatCount="indefinite"
                />
              </g>
            ) : null}
          </g>
        ) : null}
      </svg>
      {node(
        'source',
        source.label,
        <>
          <AssetBadge ticker="USDT" />
          <span className="flow-label">
            {value(source)}
            <span>{source.label}</span>
          </span>
        </>,
      )}
      {node(
        'destination',
        destination.label,
        <>
          <AssetBadge ticker={ticker} />
          <span className="flow-label">
            {value(destination)}
            <span>{destination.label}</span>
          </span>
        </>,
      )}
      {remainder ? (
        <div className="flow-node remainder">
          <span className="hollow-node" />
          <span className="flow-label">
            {value(remainder)}
            <span>{remainder.label}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Progress toward the next buy: interest now against the minimum buy, as the server read it. */
export function ProgressStrip({
  label,
  amount,
  percent,
  action,
  href,
  aria,
}: {
  label: string;
  /** e.g. "0.18 of 0.25 USDT", or the reason it cannot be read. */
  amount: string;
  /** 0–100, or null when the interest cannot be read. */
  percent: number | null;
  action: string;
  href: string;
  aria: string;
}) {
  const shown = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <section className="progress-strip" aria-label={aria}>
      <span className="progress-orbit" aria-hidden="true" />
      <div className="progress-description">
        <span>{label}</span>
        <strong>
          <AnimatedText value={amount} />
        </strong>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={aria}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(shown)}
      >
        <span style={{ transform: `scaleX(${shown / 100})` }} />
      </div>
      <Link className="text-button progress-action" href={href}>
        {action}
        <Icon name="right" size={18} />
      </Link>
    </section>
  );
}

/**
 * Interest in this cycle: what was carried forward when it started and what is there now — two
 * readings, joined by a straight line (interest accrues about evenly between them). No point in
 * between is drawn or labelled, because none was read.
 */
export function InterestChart({
  title,
  carried,
  available,
  min,
  labels,
}: {
  title: string;
  /** Numbers for drawing only; the text beside them comes from `labels`. */
  carried: number;
  available: number;
  min: number;
  labels: {
    start: string;
    now: string;
    threshold: string;
    value: string;
    carried: string;
    fresh: string;
  };
}) {
  const id = useId();
  const plot = useRef<SVGLineElement>(null);
  useLayoutEffect(() => {
    if (!plot.current || !canAnimate()) return;
    const animation = animateElement(
      plot.current,
      [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
      1000,
    );
    animation.id = 'yieldvest-chart-reveal';
    return () => animation.cancel();
  }, []);
  const ceiling = Math.max(min, available, 0.000001);
  const y = (value: number) => 298 - (Math.max(0, value) / ceiling) * 248;
  const tipX = Math.min(620, Math.max(38, 743 - 110));
  const tipY = Math.max(65, y(available) - 51);
  return (
    <div className="interest-chart">
      <svg viewBox="0 0 810 348" role="img" aria-labelledby={id}>
        <title id={id}>{title}</title>
        <line x1="38" y1={y(min)} x2="780" y2={y(min)} className="chart-rule target" />
        <text x="779" y={y(min) - 15} textAnchor="end" className="chart-label">
          {labels.threshold}
        </text>
        <line x1="38" y1="298" x2="780" y2="298" className="chart-rule" />
        <line x1="38" y1={y(available)} x2="780" y2={y(available)} className="chart-rule subtle" />
        <line
          ref={plot}
          x1="38"
          y1={y(carried)}
          x2="743"
          y2={y(available)}
          stroke="var(--yellow)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle cx="38" cy={y(carried)} r="6" fill="var(--yellow)" />
        <circle cx="743" cy={y(available)} r="7" fill="var(--yellow)" />
        <rect x={tipX} y={tipY} width="160" height="34" rx="7" fill="#1c2227" stroke="#343c43" />
        <text x={tipX + 80} y={tipY + 22} textAnchor="middle" className="chart-tooltip">
          {labels.value}
        </text>
        <text x="38" y="333" className="chart-label">
          {labels.start}
        </text>
        <text x="743" y="333" textAnchor="end" className="chart-label">
          {labels.now}
        </text>
      </svg>
      <div className="chart-legend">
        <span>
          <i />
          {labels.carried}
        </span>
        <span>
          <i />
          {labels.fresh}
        </span>
      </div>
    </div>
  );
}

/** The approved step strip; `current` is the step in progress, the ones before it are done. */
export function Process({
  steps,
  current = -1,
  caption,
}: {
  steps: string[];
  current?: number;
  caption?: string;
}) {
  return (
    <div className="process-strip">
      {caption ? <span className="process-caption">{caption}</span> : null}
      {steps.map((step, i) => (
        <div
          className={`process-step ${i <= current ? 'active' : ''} ${i === current ? 'current' : ''}`}
          key={step}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="process-node">
            {i < current ? <Icon name="check" size={12} /> : null}
          </span>
          <span className="process-label">{step}</span>
        </div>
      ))}
    </div>
  );
}

/** Native modal dialog with the approved entry and exit motion; Escape and the backdrop close it. */
export function Dialog({
  children,
  onClose,
  titleId,
  closeLabel,
  dismissable = true,
  returnFocusId,
}: {
  children: ReactNode;
  onClose: () => void;
  titleId: string;
  closeLabel: string;
  /** False while work is in flight: the dialog stays until the answer is in. */
  dismissable?: boolean;
  /** Where focus goes on close when the control that opened the dialog is gone. */
  returnFocusId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const animation = useRef<Animation | null>(null);
  const closing = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    if (canAnimate()) {
      animation.current = animateElement(
        dialog,
        [
          { opacity: 0, transform: 'translateY(12px) scale(0.97)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        250,
      );
    }
    return () => {
      mounted.current = false;
      animation.current?.cancel();
      dialog.close();
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
      else if (returnFocusId)
        document.getElementById(returnFocusId)?.focus({ preventScroll: true });
    };
    // The opener and the fallback are read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => {
    if (closing.current || !dismissable) return;
    if (!ref.current || !canAnimate()) {
      onClose();
      return;
    }
    closing.current = true;
    const style = getComputedStyle(ref.current);
    const from = { opacity: style.opacity, transform: style.transform };
    animation.current?.cancel();
    animation.current = animateElement(
      ref.current,
      [from, { opacity: 0, transform: 'translateY(12px) scale(0.97)' }],
      160,
    );
    const finish = () => {
      if (mounted.current) onClose();
    };
    void animation.current.finished.then(finish, finish);
  };
  return (
    <dialog
      ref={ref}
      className="demo-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissable) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="dialog-content">
        {dismissable ? (
          <button
            type="button"
            className="icon-button dialog-close"
            onClick={close}
            aria-label={closeLabel}
          >
            <Icon name="close" />
          </button>
        ) : null}
        {children}
      </div>
    </dialog>
  );
}

/** Reads the page again from the server now and then (never while the tab is hidden). */
export function AutoRefresh({ everyMs = 30_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
