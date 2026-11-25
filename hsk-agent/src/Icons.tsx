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
};
export type IconName = keyof typeof P;
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="ic">
      <path d={P[name]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
