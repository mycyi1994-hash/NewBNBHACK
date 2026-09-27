/**
 * Line icons from the approved design (frontend-preview/src/components.tsx), plus the few the real
 * states need: fail (x), skip (minus) and warn. Icons never carry meaning alone; text goes with them.
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'check'
  | 'arrow'
  | 'right'
  | 'back'
  | 'close'
  | 'home'
  | 'earn'
  | 'invest'
  | 'activity'
  | 'info'
  | 'reset'
  | 'plus'
  | 'clock'
  | 'pause'
  | 'play'
  | 'x'
  | 'minus'
  | 'warn';

const PATHS: Record<IconName, ReactNode> = {
  check: <path d="m5 12 4 4L19 6" />,
  arrow: <path d="M6 18 18 6M6 6h12v12" />,
  right: <path d="M4 12h16m-6-6 6 6-6 6" />,
  back: <path d="M20 12H4m6-6-6 6 6 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  home: <path d="m3 10 9-7 9 7v11h-6v-8H9v8H3Z" />,
  earn: <path d="M4 20V12m5 8V5m6 15V9m5 11V2" />,
  invest: (
    <>
      <path d="M12 3v9h9A9 9 0 1 1 12 3Z" />
      <path d="M16 3.9A9 9 0 0 1 20.1 8H16Z" />
    </>
  ),
  activity: (
    <>
      <path d="M5 3h10l4 4v14H5Z" />
      <path d="M14 3v5h5M8 12h8M8 16h6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v.1" />
    </>
  ),
  reset: <path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" />,
  plus: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M7 12h10" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" strokeWidth="2.5" />,
  play: <path d="m8 4 12 8-12 8Z" />,
  x: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6m0-6-6 6" />
    </>
  ),
  minus: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </>
  ),
  warn: <path d="M12 3 2 20h20L12 3Zm0 7v5m0 3v.1" />,
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The Yieldvest Y/V mark (frontend-preview/public/yieldvest-mark.svg). */
export function YieldvestMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path d="M7 10h13l12 19 12-19h13L38 40v15H26V40L7 10Z" fill="#F0B90B" />
      <path d="m32 29 12-19h13L38 40l-6-11Z" fill="#FFD65A" />
    </svg>
  );
}
