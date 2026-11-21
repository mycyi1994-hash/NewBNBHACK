// Small motion primitives (Toss-style): rolling digits for every number that changes,
// and a pill that slides between the options of a segmented control.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DIGITS = '0123456789';
const num = (s: string) => { const v = Number(s.replace(/[^0-9.-]/g, '')); return Number.isFinite(v) && /\d/.test(s) ? v : null; };

/**
 * A number whose digits roll to their new value. On first show it rolls up from zeros.
 * When the value goes up or down it briefly tints green or red. Text that is not a number
 * ("—", "…") renders as is.
 */
export function RollNum({ text, className, flash = true }: { text: string; className?: string; flash?: boolean }) {
  const [shown, setShown] = useState(() => text.replace(/\d/g, '0'));
  const [tick, setTick] = useState<'' | 'up' | 'down'>('');
  const prev = useRef<string | null>(null);

  const shownRef = useRef(shown); shownRef.current = shown;
  useEffect(() => {
    // Coming from "—" or a different shape: lay the digits down as zeros first, then roll on the next frames.
    const zeros = text.replace(/\d/g, '0');
    const shape = (x: string) => x.replace(/\d/g, '0');
    let raf = 0, raf2 = 0;
    if (shape(shownRef.current) !== zeros) setShown(zeros);
    raf = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setShown(text)); });
    const a = prev.current !== null ? num(prev.current) : null, b = num(text);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (flash && a !== null && b !== null && a !== b) {
      setTick(b > a ? 'up' : 'down');
      timer = setTimeout(() => setTick(''), 900);
    }
    prev.current = text;
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); if (timer) clearTimeout(timer); };
  }, [text, flash]);

  if (!/\d/.test(text)) return <span className={className}>{text}</span>;
  // Align digits from the right so 99 → 100 rolls each place, not every character.
  const chars = [...shown];
  return (
    <span className={`rn${tick ? ` rn-${tick}` : ''}${className ? ` ${className}` : ''}`} aria-label={text} role="text">
      {chars.map((c, i) => {
        const key = chars.length - i;
        return DIGITS.includes(c)
          ? <span key={key} className="rn-d" aria-hidden><span className="rn-col" style={{ transform: `translateY(${-Number(c) * 10}%)` }}>{[...DIGITS].map((d) => <span key={d}>{d}</span>)}</span></span>
          : <span key={key} className="rn-c" aria-hidden>{c}</span>;
      })}
    </span>
  );
}

/**
 * Put inside a segmented control (position: relative). It finds the child marked `.on`
 * and glides a pill behind it. `dep` is the selected value, so it moves when that changes.
 */
export function SlidePill({ dep }: { dep: unknown }) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const pill = ref.current, box = pill?.parentElement;
    if (!pill || !box) return;
    const place = () => {
      const on = box.querySelector<HTMLElement>(':scope > .on');
      if (!on) { pill.style.opacity = '0'; return; }
      pill.style.opacity = '1';
      pill.style.width = `${on.offsetWidth}px`;
      pill.style.height = `${on.offsetHeight}px`;
      pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
    };
    if (first.current) { pill.style.transition = 'none'; place(); pill.getBoundingClientRect(); pill.style.transition = ''; first.current = false; } else place();
    const ro = new ResizeObserver(place);
    ro.observe(box);
    return () => ro.disconnect();
  }, [dep]);
  return <span ref={ref} className="slide-pill" aria-hidden />;
}
