// The block editor, laid out like a DLMM liquidity editor: the shapes as cards with a small picture each, then one
// column per order across the full width (USDT under the price on the left, the coin over it on the right, a dotted
// line at today's price), each column a stack of ten cells. Clicking a cell sets that column's height, dragging across
// columns paints them, right-click or clicking the top cell again lowers it, arrows work on a focused column.
// Heights are the plan's custom weights; the amounts follow them.
import { useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useT } from './i18n.ts';
import { Icon } from './Icons.tsx';
import { SPACING, shapeWeight, type Bin, type Goal, type Shape } from './lp.ts';
import { priceText } from './lpAmount.ts';

const ROWS = 10;
export const SHAPES: Shape[] = ['spot', 'curve', 'spotCurve', 'bidask', 'custom'];
const COUNTS = [0, 5, 10, 20];
const CUSTOM_PICTURE = [0.5, 0.9, 0.35, 0.7, 0.6, 0.3, 0.85, 0.5];

/** A small picture of a shape: four bars under the price, four over it. */
export function ShapePicture({ shape }: { shape: Shape }) {
  const hs = shape === 'custom' ? CUSTOM_PICTURE : [4, 3, 2, 1, 1, 2, 3, 4].map((d) => shapeWeight(shape, d, 4));
  const top = Math.max(...hs);
  return (
    <svg className="lpb-pic" viewBox="0 0 46 18" aria-hidden>
      {hs.map((h, i) => { const y = 18 - Math.max(2, (h / top) * 18); return <rect key={i} x={i * 5.75 + (i > 3 ? 1.5 : 0)} y={y} width={4} height={18 - y} rx={1} className={i < 4 ? 'b' : 's'} />; })}
    </svg>
  );
}

export interface BlocksProps {
  bins: Bin[]; heights: number[]; goal: Goal; price: number; at: (tick: number) => number;
  shape: Shape; onShape: (s: Shape) => void;
  /** Called once before a change (a stroke, a key, a right-click), so it can be undone. */
  onBegin: () => void;
  /** The new heights for every bin. */
  onHeights: (h: number[]) => void;
  step: number; onStep: (step: number) => void;
  down: number; up: number; onCounts: (down: number, up: number) => void;
  canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onClose: () => void;
  symbol: string;
}

export default function LpBlocks(pr: BlocksProps) {
  const { t } = useT();
  const { bins, heights, goal, price, at } = pr;
  const work = useRef(heights); work.current = heights;
  const painting = useRef(false);
  const grid = useRef<HTMLDivElement>(null);

  const showBuy = goal !== 'sell', showSell = goal !== 'buy';
  const buyIdx = bins.map((b, i) => (b.side === 'usdt' && showBuy ? i : -1)).filter((i) => i >= 0);
  const sellIdx = bins.map((b, i) => (b.side === 'coin' && showSell ? i : -1)).filter((i) => i >= 0);

  const apply = (i: number, h: number) => {
    const v = Math.max(0, Math.min(ROWS, h));
    if (work.current[i] === v) return;
    const next = [...work.current]; next[i] = v;
    work.current = next;
    pr.onHeights(next);
  };
  /** The column under the pointer and the height that point means. */
  const hit = (e: PointerEvent<HTMLDivElement>) => {
    const cols = [...(grid.current?.querySelectorAll<HTMLElement>('[data-i]') ?? [])];
    let best: { i: number; h: number; dx: number } | null = null;
    for (const c of cols) {
      const r = c.getBoundingClientRect(), dx = e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0;
      if (!best || dx < best.dx) best = { i: Number(c.dataset.i), h: Math.ceil(((r.bottom - e.clientY) / r.height) * ROWS), dx };
    }
    return best;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const x = hit(e);
    if (!x) return;
    e.preventDefault();
    pr.onBegin();
    const h = Math.max(1, Math.min(ROWS, x.h));
    apply(x.i, h === work.current[x.i] ? h - 1 : h);   // the top cell again: one lower
    painting.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!painting.current) return;
    const x = hit(e);
    if (x) apply(x.i, x.h);
  };
  const up = () => { painting.current = false; };
  const key = (i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    pr.onBegin();
    apply(i, work.current[i] + by);
  };
  const lower = (i: number) => (e: MouseEvent<HTMLDivElement>) => { e.preventDefault(); pr.onBegin(); apply(i, work.current[i] - 1); };

  const col = (i: number) => {
    const b = bins[i], h = heights[i] ?? 0, tip = t.lpsBlockTip(priceText(at(b.lower)), priceText(at(b.upper)), h);
    return (
      <div key={i} data-i={i} className={`lpb-col ${b.side === 'usdt' ? 'buy' : 'sell'}`} tabIndex={0} role="slider" aria-label={tip} title={tip}
        aria-valuemin={0} aria-valuemax={ROWS} aria-valuenow={h} onKeyDown={key(i)} onContextMenu={lower(i)}>
        {Array.from({ length: ROWS }, (_, r) => <i key={r} className={ROWS - r <= h ? 'on' : ''} />)}
      </div>
    );
  };
  const nb = buyIdx.length, ns = sellIdx.length;
  const template = `${nb ? `repeat(${nb}, minmax(0, 1fr)) ` : ''}14px${ns ? ` repeat(${ns}, minmax(0, 1fr))` : ''}`;
  const lo = nb ? at(bins[buyIdx[0]].lower) : price, hi = ns ? at(bins[sellIdx[ns - 1]].upper) : price;
  const stepPct = (x: number) => `${(Math.pow(1.0001, x) * 100 - 100).toFixed(1)}%`;
  const seg = (label: string, value: number, other: number, set: (v: number) => void) => (
    <span className="lpb-ctl"><em>{label}</em><span className="seg" role="group" aria-label={label}>
      {[...new Set([...COUNTS, value])].sort((x, y) => x - y).map((x) => <button key={x} className={value === x ? 'on' : ''} aria-pressed={value === x} disabled={x === 0 && other === 0} onClick={() => set(x)}>{x}</button>)}
    </span></span>
  );

  return (
    <section className="lpb" aria-label={t.lpsBlocks}>
      <header className="lpb-head">
        <b>{t.lpsBlocks}</b>
        <span className="lpb-legend">
          {showBuy && <span><i className="lg-buy" />USDT</span>}
          {showSell && <span><i className="lg-sell" />{pr.symbol}</span>}
        </span>
        <span className="lpb-tools">
          <button className="icon-btn" disabled={!pr.canUndo} onClick={pr.onUndo} aria-label={t.lpsUndo} data-tip={t.lpsUndo}><Icon name="undo" size={16} /></button>
          <button className="icon-btn" disabled={!pr.canRedo} onClick={pr.onRedo} aria-label={t.lpsRedo} data-tip={t.lpsRedo}><Icon name="redo" size={16} /></button>
          <button className="icon-btn" onClick={pr.onClose} aria-label={t.lpClose}><Icon name="close" size={16} /></button>
        </span>
      </header>

      <div className="lpb-shapes" role="radiogroup" aria-label={t.lpShape}>
        {SHAPES.map((x) => (
          <button key={x} role="radio" aria-checked={pr.shape === x} className={pr.shape === x ? 'on' : ''} onClick={() => pr.onShape(x)}>
            <span className="lpb-shape-top"><ShapePicture shape={x} /><b>{t.lpShapes[x]}</b></span>
            <small>{t.lpShapeSub[x]}</small>
          </button>
        ))}
      </div>

      <div className="lpb-scroll">
        <div className="lpb-area" style={{ '--cols': nb + ns, '--gap': nb + ns > 24 ? '4px' : '7px' } as CSSProperties}>
          <div ref={grid} className="lpb-grid" style={{ gridTemplateColumns: template }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            {buyIdx.map(col)}
            <div className={`lpb-now${ns === 0 ? ' end' : nb === 0 ? ' start' : ''}`} aria-hidden><span>{t.lpsNowPrice(priceText(price))}</span></div>
            {sellIdx.map(col)}
          </div>
          <div className="lpb-axis" style={{ gridTemplateColumns: template }} aria-hidden>
            {nb > 0 && <span style={{ gridColumn: '1', justifySelf: 'start' }}>{priceText(lo)}</span>}
            {nb > 5 && <span style={{ gridColumn: `${Math.ceil(nb / 2)}` }}>{priceText(at(bins[buyIdx[Math.floor(nb / 2)]].lower))}</span>}
            <span style={{ gridColumn: `${nb + 1}`, justifySelf: ns === 0 ? 'end' : nb === 0 ? 'start' : 'center' }}>{priceText(price)}</span>
            {ns > 5 && <span style={{ gridColumn: `${nb + 1 + Math.ceil(ns / 2)}` }}>{priceText(at(bins[sellIdx[Math.floor(ns / 2)]].upper))}</span>}
            {ns > 0 && <span style={{ gridColumn: `${nb + 1 + ns}`, justifySelf: 'end' }}>{priceText(hi)}</span>}
          </div>
        </div>
      </div>

      <div className="lpb-foot">
        <span className="lpb-ctl"><em>{t.lpsGapShort}</em><span className="seg" role="group" aria-label={t.lpStep}>
          {[SPACING, SPACING * 2, SPACING * 4].map((x) => <button key={x} className={pr.step === x ? 'on' : ''} aria-pressed={pr.step === x} onClick={() => pr.onStep(x)}>{stepPct(x)}</button>)}
        </span></span>
        {seg(t.lpsDownShort, pr.down, pr.up, (v) => pr.onCounts(v, pr.up))}
        {seg(t.lpsUpShort, pr.up, pr.down, (v) => pr.onCounts(pr.down, v))}
        <p className="lpb-hint">{t.lpsBlocksHint}</p>
      </div>
    </section>
  );
}
