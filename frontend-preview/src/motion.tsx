import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const MotionContext = createContext({ enabled: true, reduced: false, visible: true, paused: false, toggle: () => {} });

/** The app's motion is explanatory. It never changes an account value. */
export function MotionProvider({ children }: { children: ReactNode }) {
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(() => !document.hidden);
  const enabled = !paused && !reduced;
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const preference = () => setReduced(media.matches);
    const visibility = () => setVisible(!document.hidden);
    const keyboard = () => { document.documentElement.dataset.input = 'keyboard'; };
    const pointer = () => { document.documentElement.dataset.input = 'pointer'; };
    media.addEventListener('change', preference);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('pointerdown', pointer, true);
    return () => {
      media.removeEventListener('change', preference);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('keydown', keyboard, true);
      document.removeEventListener('pointerdown', pointer, true);
    };
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.motion = enabled ? 'on' : 'off';
    if (!enabled) {
      document.getAnimations().forEach(animation => {
        if (animation.id.startsWith('ijaro-')) animation.cancel();
      });
    }
  }, [enabled]);
  return <MotionContext.Provider value={{ enabled, reduced, visible, paused, toggle: () => setPaused(value => !value) }}>{children}</MotionContext.Provider>;
}
export const useMotion = () => useContext(MotionContext);
export const canAnimate = () => !matchMedia('(prefers-reduced-motion: reduce)').matches &&
  document.documentElement.dataset.motion !== 'off' && document.documentElement.dataset.input !== 'keyboard';

export function animateElement(element: Element, frames: Keyframe[], duration = 220, delay = 0) {
  const animation = element.animate(frames, { duration, delay, easing: EASE_OUT, fill: 'backwards' });
  animation.id = 'ijaro-ui';
  return animation;
}

/** Preserve the real text: slide the changed value, never count through fictitious balances. */
export function AnimatedText({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    const element = ref.current;
    if (!element || !canAnimate()) { animation.current?.cancel(); return; }
    const running = animation.current?.playState === 'running';
    const style = getComputedStyle(element);
    const first = { opacity: running ? style.opacity : 0, transform: running ? style.transform : 'translateY(25%)' };
    animation.current?.cancel();
    animation.current = animateElement(element, [first, { opacity: 1, transform: 'translateY(0)' }], 200);
  }, [value]);
  useEffect(() => () => animation.current?.cancel(), []);
  return <span ref={ref} className="animated-value">{value}</span>;
}

export function usePageMotion(ref: RefObject<HTMLDivElement | null>, route: string) {
  useLayoutEffect(() => {
    if (!ref.current || !canAnimate()) return;
    const blocks = ref.current.querySelectorAll('.section-heading, .receipt-panel, .progress-strip, .process-strip, .receipt-document, .execution-trace');
    const animations = [...blocks].map((element, index) => animateElement(element, [
      { opacity: 0, transform: 'translateY(10px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], 220, Math.min(index, 2) * 35));
    return () => animations.forEach(animation => animation.cancel());
  }, [ref, route]);
}

export function useNavIndicator(ref: RefObject<HTMLElement | null>, active: string, mobile: boolean) {
  useLayoutEffect(() => {
    const nav = ref.current;
    const indicator = nav?.querySelector<HTMLElement>('.nav-indicator');
    const link = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !indicator || !link) return;
    const update = () => {
      indicator.style.top = (mobile ? 0 : link.offsetTop + link.offsetHeight - 3) + 'px';
      indicator.style.transform = 'translateX(' + link.offsetLeft + 'px) scaleX(' + link.offsetWidth / 100 + ')';
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
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.1 });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}
