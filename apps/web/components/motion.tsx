'use client';
/**
 * Motion from the approved design (frontend-preview/src/motion.tsx). It explains the flow and never
 * changes a value: numbers slide in when they change, they never count through made-up balances.
 * The viewer can pause it, it follows the system's reduced-motion setting, and looping effects stop
 * off screen and in a hidden tab. Server-safe: the system settings are read after hydration.
 */
import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { Icon } from './Icon';

export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const PREFIX = 'yieldvest-';
const REDUCED = '(prefers-reduced-motion: reduce)';

interface Motion {
  enabled: boolean;
  reduced: boolean;
  visible: boolean;
  paused: boolean;
  toggle: () => void;
}

const MotionContext = createContext<Motion>({
  enabled: true,
  reduced: false,
  visible: true,
  paused: false,
  toggle: () => undefined,
});

function subscribeReduced(onChange: () => void) {
  const media = matchMedia(REDUCED);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

export function MotionProvider({ children }: { children: ReactNode }) {
  const [paused, setPaused] = useState(false);
  const reduced = useSyncExternalStore(
    subscribeReduced,
    () => matchMedia(REDUCED).matches,
    () => false,
  );
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => !document.hidden,
    () => true,
  );
  const enabled = !paused && !reduced;
  useEffect(() => {
    const root = document.documentElement;
    const keyboard = () => {
      root.dataset.input = 'keyboard';
    };
    const pointer = () => {
      root.dataset.input = 'pointer';
    };
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('pointerdown', pointer, true);
    return () => {
      document.removeEventListener('keydown', keyboard, true);
      document.removeEventListener('pointerdown', pointer, true);
    };
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.motion = enabled ? 'on' : 'off';
    if (!enabled) {
      document.getAnimations().forEach((animation) => {
        if (animation.id.startsWith(PREFIX)) animation.cancel();
      });
    }
  }, [enabled]);
  const toggle = useCallback(() => setPaused((value) => !value), []);
  const value = useMemo(
    () => ({ enabled, reduced, visible, paused, toggle }),
    [enabled, reduced, visible, paused, toggle],
  );
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export const useMotion = () => useContext(MotionContext);

export const canAnimate = () =>
  !matchMedia(REDUCED).matches &&
  document.documentElement.dataset.motion !== 'off' &&
  document.documentElement.dataset.input !== 'keyboard';

export function animateElement(element: Element, frames: Keyframe[], duration = 220, delay = 0) {
  const animation = element.animate(frames, {
    duration,
    delay,
    easing: EASE_OUT,
    fill: 'backwards',
  });
  animation.id = `${PREFIX}ui`;
  return animation;
}

/** Keeps the real text: the changed value slides in, it never counts through other balances. */
export function AnimatedText({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    const element = ref.current;
    if (!element || !canAnimate()) {
      animation.current?.cancel();
      return;
    }
    const running = animation.current?.playState === 'running';
    const style = getComputedStyle(element);
    const first = {
      opacity: running ? style.opacity : 0,
      transform: running ? style.transform : 'translateY(25%)',
    };
    animation.current?.cancel();
    animation.current = animateElement(
      element,
      [first, { opacity: 1, transform: 'translateY(0)' }],
      200,
    );
  }, [value]);
  useEffect(() => () => animation.current?.cancel(), []);
  return (
    <span ref={ref} className="animated-value">
      {value}
    </span>
  );
}

const PAGE_BLOCKS =
  '.section-heading, .receipt-panel, .progress-strip, .process-strip, .receipt-document, .execution-trace, .page-block';

/**
 * Around each page: its blocks rise in on navigation, and focus moves to the new page title so a
 * keyboard or screen-reader user lands on it (not on the first visit).
 */
export function PageMotion({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (!ref.current || !canAnimate()) return;
    const blocks = ref.current.querySelectorAll(PAGE_BLOCKS);
    const animations = [...blocks].map((element, index) =>
      animateElement(
        element,
        [
          { opacity: 0, transform: 'translateY(10px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        220,
        Math.min(index, 2) * 35,
      ),
    );
    return () => animations.forEach((animation) => animation.cancel());
  }, [pathname]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById('page-title')?.focus({ preventScroll: true });
  }, [pathname]);
  return (
    <div ref={ref} className="page-content">
      {children}
    </div>
  );
}

export function useNavIndicator(
  ref: RefObject<HTMLElement | null>,
  active: string | null,
  mobile: boolean,
) {
  useLayoutEffect(() => {
    const nav = ref.current;
    const indicator = nav?.querySelector<HTMLElement>('.nav-indicator');
    const link = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !indicator) return;
    if (!link) {
      indicator.style.opacity = '0';
      return;
    }
    const update = () => {
      indicator.style.top = `${mobile ? 0 : link.offsetTop + link.offsetHeight - 3}px`;
      indicator.style.transform = `translateX(${link.offsetLeft}px) scaleX(${link.offsetWidth / 100})`;
      indicator.style.opacity = '1';
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    observer.observe(link);
    return () => observer.disconnect();
  }, [ref, active, mobile]);
}

export function useInView(ref: RefObject<Element | null>) {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? true),
      {
        threshold: 0.1,
      },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

/** The toolbar's play/pause control for every looping effect on the page. */
export function MotionToggle({
  labels,
}: {
  labels: { pause: string; play: string; reduced: string };
}) {
  const motion = useMotion();
  const label = motion.reduced ? labels.reduced : motion.paused ? labels.play : labels.pause;
  return (
    <button
      type="button"
      className="icon-button motion-toggle"
      onClick={motion.toggle}
      disabled={motion.reduced}
      aria-label={label}
      title={label}
      aria-pressed={motion.enabled}
    >
      <Icon name={motion.enabled ? 'pause' : 'play'} size={17} />
    </button>
  );
}
