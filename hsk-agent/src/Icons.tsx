// Line icons in the Material Symbols manner (24px grid, 1.6 stroke), drawn here so nothing is fetched.
const P: Record<string, string> = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  market: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  chart: 'M4 19V5M4 19h16M7 15l4-5 3 3 5-7',
  bot: 'M8 8V5h8v3M5 8h14v10H5zM9 12.5h.01M15 12.5h.01M10 15.5h4M12 2.5v2.5',
  shield: 'M12 3l7 3v6c0 4.2-3 7.6-7 9-4-1.4-7-4.8-7-9V6z',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  chevron: 'M9 6l6 6-6 6',
  sparkle: 'M12 3c.6 4.5 2.5 6.4 7 7-4.5.6-6.4 2.5-7 7-.6-4.5-2.5-6.4-7-7 4.5-.6 6.4-2.5 7-7z',
  collect: 'M5 19h14M7 15v4M11 11v8M15 8v11M19 5v14',
  trend: 'M4 17l5-5 4 4 7-8M15 8h5v5',
  dip: 'M4 7l5 5 4-4 7 8M15 16h5v-5',
  close: 'M6 6l12 12M18 6L6 18',
  enter: 'M9 10l-4 4 4 4M5 14h11a3 3 0 0 0 3-3V5',
  stop: 'M7 7h10v10H7z',
  menuFold: 'M4 7h11M4 12h8M4 17h11M20 9l-3 3 3 3',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  pause: 'M9 6v12M15 6v12',
  play: 'M8 5.5v13l10-6.5z',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7M10.5 10.5v6M13.5 10.5v6',
  list: 'M8 7h11M8 12h11M8 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01',
  plus: 'M12 5v14M5 12h14',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  down: 'M6 9l6 6 6-6',
  chat: 'M5 5h14v10H10l-5 4z',
  sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  cloud: 'M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 9.1 4.5 4.5 0 0 1 17.5 18z',
  rain: 'M7 15a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 6.1 4.5 4.5 0 0 1 17.5 15zM8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5',
  storm: 'M7 15a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 6.1 4.5 4.5 0 0 1 17.5 15zM12.5 14 10 17.5h3L11 21',
  medal: 'M8 3h8l-2.5 6h-3zM12 9a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z',
  // sharing (src/Shared.tsx)
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v5M12 7.5h.01',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v6h14v-6',
  copy: 'M9 9h10v10H9zM15 9V5H5v10h4',
  user: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4.5 20c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5',
  coin: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM14.5 9.2c-.6-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-1.9-.4-2.5-1.2M12 6.5v1.5M12 16v1.5',
  globe: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
};
export type IconName = keyof typeof P;
/** Sizes are given in the pixels of a 1440px screen and grow with the root font size (14px = 1rem). */
const rem = (px: number) => ({ width: `${px / 14}rem`, height: `${px / 14}rem` });
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg style={rem(size)} viewBox="0 0 24 24" aria-hidden className="ic">
      <path d={P[name]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The four-point spark that marks Moa's voice (a filled star, as AI Studio marks its assistant). */
export function Spark({ size = 16 }: { size?: number }) {
  return <svg style={rem(size)} viewBox="0 0 24 24" aria-hidden className="spark4"><path d="M12 2c.9 6.2 3.8 9.1 10 10-6.2.9-9.1 3.8-10 10-.9-6.2-3.8-9.1-10-10 6.2-.9 9.1-3.8 10-10z" fill="currentColor" /></svg>;
}
