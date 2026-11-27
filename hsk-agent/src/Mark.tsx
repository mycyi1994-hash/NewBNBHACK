// Agent identity: every agent gets a mark like an app icon.
//  - The tile's colour is its family, which is how it trades: rides long rises (blue), follows the average (violet),
//    waits for a crossing (amber), buys breakouts (green), buys dips (coral), collects a little at a time (teal).
//  - The white symbol is the rule itself, one drawing per rule, so two agents of one family still look different.
//  - A coin badge sits in the corner when the coin is known.
// Drawn on a 64-unit grid; symbols stay inside a circle of radius ~17 around the centre, so the corner badge never
// covers them, and strokes are 4.5–5.5 units so the mark still reads at 24px.
import { useId, type ReactNode } from 'react';
import type { RuleId } from './agents.ts';

export type Family = 'mom' | 'avg' | 'cross' | 'brk' | 'dip' | 'col' | 'made';

export const FAMILY: Record<RuleId, Family> = {
  tsmom: 'mom', multiTrend: 'mom', dualMom: 'mom', cryptoMom: 'mom',
  trend200: 'avg', trend: 'avg', adx: 'avg', aroon: 'avg',
  golden: 'cross', ema: 'cross', ma520: 'cross', triple: 'cross', macd: 'cross', ichimoku: 'cross',
  break: 'brk', turtle2: 'brk', donchian: 'brk', keltner: 'brk', psar: 'brk',
  rsi: 'dip', boll: 'dip', rsi2: 'dip', double7: 'dip',
  daily: 'col', smart: 'col', trendDca: 'col', rsiDca: 'col',
  made: 'made',
};

/** Light, mid and deep stop of each family's gradient (top-left to bottom-right). */
const TONE: Record<Family, [string, string, string]> = {
  mom: ['#6fb1ff', '#3b6ff0', '#2443c4'],
  avg: ['#c3a6ff', '#8455f0', '#5a2cc9'],
  cross: ['#ffd36b', '#ffa22b', '#e5740b'],
  brk: ['#5eeab0', '#16b884', '#087a5a'],
  dip: ['#ffa48f', '#ff5f7a', '#d42f68'],
  col: ['#6be6e0', '#1cb2c7', '#0b7a9a'],
  made: ['#5b6474', '#262c38', '#0d1118'],
};
/** The family's mid colour, for washes and accents around a mark. */
export const markColor = (rule: RuleId) => TONE[FAMILY[rule] ?? 'made'][1];

const COIN: Record<string, [string, string, string]> = {
  BTC: ['#ffc062', '#f7931a', 'B'],
  ETH: ['#9fb2ff', '#5f7cf0', 'E'],
  HSK: ['#c8a8ff', '#6d4ce0', 'H'],
};

/** One rule's symbol. `ink` draws it, `cut` draws the details cut into it (the tile colour on a mark). */
function glyph(rule: RuleId, ink: string, cut: string): ReactNode {
  const s = { fill: 'none', stroke: ink, strokeWidth: 5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const f = { fill: ink };
  switch (rule) {
    // ---- momentum: rides long rises ----
    case 'tsmom': // Long View: a telescope on its stand
      return <>
        <g transform="rotate(-27 31 29)">
          <rect x="13" y="24.5" width="27" height="9" rx="3" {...f} />
          <rect x="39" y="21.5" width="9" height="15" rx="3" {...f} />
          <rect x="9" y="26.5" width="5" height="5" rx="1.5" {...f} opacity=".75" />
        </g>
        <path d="M30 34L23 48M30 34L37 48" {...s} strokeWidth={4} opacity=".75" />
      </>;
    case 'multiTrend': // Century: three horizons agreeing, three chevrons up
      return <>
        <path d="M18 46l14-10 14 10" {...s} strokeWidth={5.5} opacity=".45" />
        <path d="M18 36l14-10 14 10" {...s} strokeWidth={5.5} opacity=".72" />
        <path d="M18 26l14-10 14 10" {...s} strokeWidth={5.5} />
      </>;
    case 'dualMom': // Dual: two arrows, the stronger one taller
      return <>
        <path d="M23 47V32M17 38l6-6 6 6" {...s} opacity=".6" />
        <path d="M40 47V18M33 25l7-7 7 7" {...s} />
      </>;
    case 'cryptoMom': // Sprinter: a lightning bolt
      return <path d="M36.5 13L19.5 35H31l-4 16 18-23.5H34z" {...f} stroke={ink} strokeWidth={2} strokeLinejoin="round" />;
    // ---- averages: follows the long average ----
    case 'trend200': // Guardian: a shield with a tick
      return <>
        <path d="M32 13.5l15.5 5.5v12c0 9.6-6.6 16-15.5 19.5C23.1 47 16.5 40.6 16.5 31V19z" {...f} />
        <path d="M24.5 31.5l5 5 10-10.5" fill="none" stroke={cut} strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" />
      </>;
    case 'trend': // Surfer: a curling wave
      return <>
        <path d="M14 44c3-14 12-24 24-24 8 0 12 6 9 11-2.6 4.2-9 3.5-9-1.5" {...s} />
        <path d="M14 48c4 0 5-2.5 9-2.5s5 2.5 9 2.5 5-2.5 9-2.5" {...s} strokeWidth={4} opacity=".6" />
      </>;
    case 'adx': // Compass: a needle pointing up and right
      return <>
        <circle cx="32" cy="31" r="17" fill="none" stroke={ink} strokeWidth={4} opacity=".55" />
        <path d="M42.5 20.5L36 35l-15.5 6.5L27 27z" {...f} />
        <circle cx="31.5" cy="31" r="2.6" fill={cut} />
      </>;
    case 'aroon': // Dawn: the sun coming up over the horizon
      return <>
        <path d="M19 41a13 13 0 0126 0z" {...f} />
        <path d="M14 46.5h32" {...s} strokeWidth={4.5} />
        <path d="M32 21.5V16M45.5 27.5l3.8-3.8M18.5 27.5l-3.8-3.8" {...s} strokeWidth={4.5} />
      </>;
    // ---- crossings: waits for two averages to cross ----
    case 'golden': // Golden: a crown
      return <>
        <path d="M16.5 24.5l8 8L32 19l7.5 13.5 8-8L44.5 42h-25z" {...f} stroke={ink} strokeWidth={2} strokeLinejoin="round" />
        <rect x="19.5" y="44.5" width="25" height="4.5" rx="2.2" {...f} />
        <circle cx="16.5" cy="23.5" r="3" {...f} /><circle cx="32" cy="17" r="3" {...f} /><circle cx="47.5" cy="23.5" r="3" {...f} />
      </>;
    case 'ema': // Cruiser: a sailboat
      return <>
        <path d="M30 13v25H16z" {...f} />
        <path d="M34.5 19v19H46z" {...f} opacity=".7" />
        <path d="M13.5 41.5h37l-5 7.5h-27z" {...f} />
      </>;
    case 'ma520': // Swift: a paper plane
      return <>
        <path d="M13.5 30.5L50 15.5 40.5 48l-8.5-12z" {...f} />
        <path d="M32 36l18-20.5M32 36v9" fill="none" stroke={cut} strokeWidth={2.6} strokeLinecap="round" />
      </>;
    case 'triple': // Triple: three averages stacked up
      return <>
        <path d="M32 13.5l16 8-16 8-16-8z" {...f} />
        <path d="M16 30l16 8 16-8" {...s} opacity=".8" />
        <path d="M16 38.5l16 8 16-8" {...s} opacity=".55" />
      </>;
    case 'macd': // Pulse: a heartbeat
      return <path d="M12.5 33h9l4.5-9.5 6 20.5 5.5-26 4.5 15h9" {...s} strokeWidth={5.2} />;
    case 'ichimoku': // Cloud
      return <>
        <circle cx="24" cy="36" r="8.5" {...f} /><circle cx="34.5" cy="28.5" r="11.5" {...f} /><circle cx="43" cy="37" r="7.5" {...f} />
        <rect x="24" y="36" width="19" height="8.5" {...f} />
      </>;
    // ---- breakouts: buys a fresh high ----
    case 'break': // Turtle: seen from above
      return <>
        <circle cx="32" cy="14" r="5.2" {...f} />
        <ellipse cx="21" cy="23.5" rx="4.3" ry="3.6" {...f} /><ellipse cx="43" cy="23.5" rx="4.3" ry="3.6" {...f} />
        <ellipse cx="21" cy="41" rx="4.3" ry="3.6" {...f} /><ellipse cx="43" cy="41" rx="4.3" ry="3.6" {...f} />
        <path d="M29.5 46l2.5 4.5 2.5-4.5z" {...f} />
        <ellipse cx="32" cy="32" rx="12.5" ry="14.5" {...f} />
        <ellipse cx="32" cy="32" rx="6" ry="7.5" fill="none" stroke={cut} strokeWidth={2.6} />
        <path d="M26.2 28.5l-5.5-2.8M37.8 28.5l5.5-2.8M26.2 35.5l-5.5 2.8M37.8 35.5l5.5 2.8" fill="none" stroke={cut} strokeWidth={2.2} strokeLinecap="round" opacity=".7" />
      </>;
    case 'turtle2': // Big Turtle: seen from the side, a big domed shell
      return <>
        <circle cx="13" cy="35" r="5" {...f} />
        <path d="M15 37.5h5" {...s} strokeWidth={4.5} />
        <path d="M19 40c0-11 6-18 14-18s14 7 14 18z" {...f} />
        <rect x="21.5" y="39" width="7" height="9" rx="3" {...f} /><rect x="37" y="39" width="7" height="9" rx="3" {...f} />
        <path d="M20.5 34h25M28 34v-7.5M38 34v-7.5" fill="none" stroke={cut} strokeWidth={2.4} strokeLinecap="round" />
        <circle cx="11.6" cy="33.8" r="1.5" fill={cut} />
      </>;
    case 'donchian': // Four-week rule: a flag on a new summit
      return <>
        <path d="M33 47l8.5-13.5L50 47z" {...f} opacity=".6" />
        <path d="M12.5 47.5L28.5 22l16 25.5z" {...f} />
        <path d="M28.5 23V11" {...s} strokeWidth={3.2} />
        <path d="M29.5 10.5l10 3.6-10 3.6z" {...f} />
      </>;
    case 'keltner': // Channel: an arrow leaving its channel upward
      return <>
        <path d="M13 33.5h38M13 44.5h38" {...s} strokeWidth={4} opacity=".5" />
        <path d="M18.5 42L44 16.5M33.5 16h11v11" {...s} strokeWidth={5.5} />
      </>;
    case 'psar': // Parabolic: a rising curve with its trailing stop dots
      return <>
        <path d="M13.5 41c13 0 22-6 29-23" {...s} />
        <circle cx="45" cy="15.5" r="5" {...f} />
        <circle cx="23" cy="48" r="2.8" {...f} opacity=".7" /><circle cx="33.5" cy="44.5" r="2.8" {...f} opacity=".7" /><circle cx="42" cy="36.5" r="2.8" {...f} opacity=".7" />
      </>;
    // ---- dip buyers: buys a fall, sells the way back ----
    case 'rsi': // Bounce: a ball bouncing back up
      return <>
        <path d="M13 17c3.5 13 6.5 29 11 29s7.5-10 10-17" fill="none" stroke={ink} strokeWidth={3.8} strokeLinecap="round" strokeDasharray="0.1 7" />
        <circle cx="40" cy="20.5" r="8" {...f} />
        <path d="M14.5 49.5h22" {...s} strokeWidth={4} opacity=".55" />
      </>;
    case 'boll': // Spring: a coil between two plates
      return <>
        <path d="M17 15h26M17 48h26" {...s} strokeWidth={5} />
        <path d="M22 15.5l16 6.5-16 6.5 16 6.5-16 6.5 16 6.5" {...s} strokeWidth={4} opacity=".85" />
      </>;
    case 'rsi2': // Snap: a U-turn arrow, down and straight back up
      return <>
        <path d="M19 15v15c0 9 5.5 15 13 15s13-6 13-15v-8" {...s} strokeWidth={5.5} />
        <path d="M38 27.5l7-7 7 7" {...s} strokeWidth={5.5} />
      </>;
    case 'double7': // Double Seven
      return <path d="M14.5 17.5h13l-8.5 29M35 17.5h13l-8.5 29" {...s} strokeWidth={5.8} />;
    // ---- collectors: a little at a time ----
    case 'daily': // Steady: a calendar
      return <>
        <rect x="15" y="18.5" width="34" height="29" rx="6" {...f} />
        <rect x="21" y="13" width="4.5" height="10" rx="2.2" {...f} stroke={cut} strokeWidth={1.6} />
        <rect x="38.5" y="13" width="4.5" height="10" rx="2.2" {...f} stroke={cut} strokeWidth={1.6} />
        <path d="M15 27h34" stroke={cut} strokeWidth={2.2} />
        <g fill={cut}><circle cx="23.5" cy="33.5" r="2.4" /><circle cx="32" cy="33.5" r="2.4" /><circle cx="40.5" cy="33.5" r="2.4" /><circle cx="23.5" cy="41" r="2.4" /><circle cx="32" cy="41" r="2.4" /></g>
      </>;
    case 'smart': // Thrifty: a piggy bank with a coin going in
      return <>
        <circle cx="30.5" cy="14.5" r="4.6" {...f} opacity=".8" />
        <path d="M21.5 27l1.5-8 7 5.5z" {...f} />
        <ellipse cx="30.5" cy="34" rx="15" ry="11.5" {...f} />
        <rect x="42" y="29.5" width="7.5" height="8.5" rx="3" {...f} />
        <rect x="20" y="41" width="5.5" height="8" rx="2.5" {...f} /><rect x="34" y="41" width="5.5" height="8" rx="2.5" {...f} />
        <path d="M26 25.5h9" stroke={cut} strokeWidth={2.6} strokeLinecap="round" />
        <circle cx="38" cy="30.5" r="2" fill={cut} />
      </>;
    case 'trendDca': // Careful: a sprout that grows only in good weather
      return <>
        <path d="M32 47.5V29" {...s} strokeWidth={4.5} />
        <path d="M31.5 35c-8.5 0-14.5-5-15.5-13.5 8.5 0 14.5 5 15.5 13.5z" {...f} opacity=".75" />
        <path d="M32.5 29c.5-8.5 6.5-14 15.5-14-.5 8.5-6.5 14-15.5 14z" {...f} />
        <path d="M21 48h22" {...s} strokeWidth={4} opacity=".55" />
      </>;
    case 'rsiDca': // Dip Buyer: a basket for picking things up
      return <>
        <path d="M22 28c0-12 20-12 20 0" fill="none" stroke={ink} strokeWidth={4.2} strokeLinecap="round" opacity=".75" />
        <path d="M13.5 27.5h37l-4.5 20h-28z" {...f} stroke={ink} strokeWidth={1.5} strokeLinejoin="round" />
        <path d="M25 33v9M32 33v9M39 33v9" stroke={cut} strokeWidth={2.6} strokeLinecap="round" />
      </>;
    default: // made: a sparkle, someone's own idea
      return <>
        <path d="M30 12c1.6 11 4.4 15.6 16 17.5-11.6 1.9-14.4 6.5-16 17.5-1.6-11-4.4-15.6-16-17.5C25.6 27.6 28.4 23 30 12z" {...f} />
        <path d="M45 12c.6 4 1.6 5.5 5.5 6.2-3.9.7-4.9 2.2-5.5 6.2-.6-4-1.6-5.5-5.5-6.2 3.9-.7 4.9-2.2 5.5-6.2z" {...f} opacity=".75" />
      </>;
  }
}

/** The rule's symbol alone, in the current text colour. */
export function RuleGlyph({ rule, size = 18 }: { rule: RuleId; size?: number }) {
  return <svg width={size} height={size} viewBox="8 8 48 48" aria-hidden>{glyph(rule, 'currentColor', '#fff')}</svg>;
}

/** The full mark: family tile, rule symbol, coin badge. Sized by its container (width/height 100%). */
export function Mark({ rule, base, letter }: { rule: RuleId; base?: string; letter?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const fam = FAMILY[rule] ?? 'made';
  const [c0, c1, c2] = TONE[fam];
  const coin = base ? COIN[base] ?? ['#c4c7cc', '#7b8088', base.slice(0, 1)] : null;
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden className="mark-svg">
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={c0} /><stop offset=".55" stopColor={c1} /><stop offset="1" stopColor={c2} />
        </linearGradient>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".32" /><stop offset=".5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {coin && <linearGradient id={`${id}c`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={coin[0]} /><stop offset="1" stopColor={coin[1]} /></linearGradient>}
      </defs>
      <rect width="64" height="64" rx="18" fill={`url(#${id}t)`} />
      <rect width="64" height="64" rx="18" fill={`url(#${id}g)`} />
      <rect x=".75" y=".75" width="62.5" height="62.5" rx="17.3" fill="none" stroke="#fff" strokeOpacity=".22" strokeWidth="1.5" />
      <g style={{ filter: `drop-shadow(0 1.5px 1.5px ${c2}66)` }}>{glyph(rule, '#fff', c2)}</g>
      {coin && <g>
        <circle cx="52" cy="52" r="11" fill="#fff" />
        <circle cx="52" cy="52" r="8.6" fill={`url(#${id}c)`} />
        {letter && <text x="52" y="55.6" textAnchor="middle" fontSize="10.5" fontWeight="800" fill="#fff" fontFamily="system-ui, sans-serif">{coin[2]}</text>}
      </g>}
    </svg>
  );
}
