// The area under the chart: one surface split into three columns by rules, not cards
// (Frontier Design rubric: avoid "everything in a card", stray labels and arrow glyphs).
//   1. Strategy picks: three rows; the open row shows one small visual, today's line and a plan button.
//   2. My vault and bots: balance, today's spend against the vault cap, running bots.
//   3. HSKSwap pools: pool price vs Gate for HSK / ETH / BTC; a row opens that pool.
// Every number is computed from live data; a source without history says so instead of inventing a backtest.
import { useEffect, useState, type ReactNode } from 'react';
import type { Asset } from './intent.ts';
import { ASSETS } from './intent.ts';
import { fmtPrice, type Quote } from './market.ts';
import { useT } from './i18n.ts';
import type { Trade } from './cex.ts';
import type { VaultInfo } from './parts.tsx';

type Signal = 'good' | 'neutral' | 'wait';
type Id = 'smart' | 'discount' | 'mood';
interface Daily { time: number; close: number }
export interface BotSummary { id: string; name: string; spent: number; budget?: number }

const PAIR: Record<Asset, string> = { HSK: 'HSK_USDT', ETH: 'ETH_USDT', BTC: 'BTC_USDT' };
const cache = new Map<Asset, Promise<Daily[]>>();

/** Gate daily candles, oldest first. Row: [time, quote volume, close, high, low, open, base volume, closed]. */
function gateDaily(asset: Asset): Promise<Daily[]> {
  if (!cache.has(asset)) {
    cache.set(asset, fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${PAIR[asset]}&interval=1d&limit=120`)
      .then((r) => { if (!r.ok) throw new Error(`Gate HTTP ${r.status}`); return r.json() as Promise<string[][]>; })
      .then((rows) => rows.map((r) => ({ time: Number(r[0]), close: Number(r[2]) })).filter((d) => d.close > 0))
      .catch((e: unknown) => { cache.delete(asset); throw e; }));
  }
  return cache.get(asset)!;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (v: number, d = 2) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;

/** $10 a day for the last 90 days: plain DCA vs "more below the 20-day average" (x0.5 … x2), with running average costs. */
function backtest(days: Daily[]) {
  const n = 90, base = 10;
  if (days.length < n + 21) return null;
  let pSpent = 0, pCoins = 0, sSpent = 0, sCoins = 0;
  const plain: number[] = [], smart: number[] = [];
  for (let i = days.length - n; i < days.length; i++) {
    const px = days[i].close;
    const ma = avg(days.slice(i - 20, i).map((d) => d.close));
    pSpent += base; pCoins += base / px;
    const amt = base * clamp(ma / px, 0.5, 2);
    sSpent += amt; sCoins += amt / px;
    plain.push(pSpent / pCoins); smart.push(sSpent / sCoins);
  }
  const last = days[days.length - 1].close;
  const ma20 = avg(days.slice(-21, -1).map((d) => d.close)); // previous 20 days, same as the backtest
  return { plain, smart, better: smart[n - 1] / plain[n - 1] - 1, mult: clamp(ma20 / last, 0.5, 2), vsMa: last / ma20 - 1 };
}

function CostLines({ smart, plain }: { smart: number[]; plain: number[] }) {
  const W = 300, H = 64, pad = 4;
  const all = [...smart, ...plain];
  const lo = Math.min(...all), span = Math.max(...all) - lo || 1;
  const line = (xs: number[]) => xs.map((v, i) => `${(i / (xs.length - 1)) * W},${pad + (1 - (v - lo) / span) * (H - pad * 2)}`).join(' ');
  return (
    <svg className="mini-lines" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={line(plain)} fill="none" stroke="#b9b3ab" strokeWidth="1.5" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <polyline points={line(smart)} fill="none" stroke="#6d4ce0" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Meter({ value, min, max, left, right }: { value: number; min: number; max: number; left: string; right: string }) {
  const pos = clamp((value - min) / (max - min), 0, 1) * 100;
  return (
    <div className="meter" aria-hidden>
      <div className="meter-track"><span style={{ left: `${pos}%` }} /></div>
      <div className="meter-labels"><span>{left}</span><span>{right}</span></div>
    </div>
  );
}

export default function Board({ quotes, mark, index, tape, vault, bots, onAsk, onOpenBots, onOpenBot, onOpenPool }: {
  quotes: Quote[]; mark?: number; index?: number; tape: Trade[]; vault: VaultInfo | null; bots: BotSummary[];
  onAsk: (prompt: string) => void; onOpenBots: () => void; onOpenBot: (id: string) => void; onOpenPool: (a: Asset) => void;
}) {
  const { t } = useT();
  const [asset, setAsset] = useState<Asset>('ETH');
  const [days, setDays] = useState<Daily[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Id | null>(null);

  useEffect(() => {
    let alive = true;
    setDays(null); setFailed(false);
    gateDaily(asset).then((d) => alive && setDays(d), () => alive && setFailed(true));
    return () => { alive = false; };
  }, [asset]);

  const bt = days ? backtest(days) : null;
  const q = quotes.find((x) => x.asset === asset);
  const gap = q?.gap;
  const basis = mark !== undefined && index ? mark / index - 1 : undefined;
  const buyShare = tape.length ? tape.filter((x) => !x.buyerIsMaker).length / tape.length : undefined;

  const signal: Record<Id, Signal> = {
    smart: !bt ? 'neutral' : bt.vsMa <= -0.02 ? 'good' : bt.vsMa >= 0.05 ? 'wait' : 'neutral',
    discount: gap === undefined ? 'neutral' : gap <= -0.003 ? 'good' : gap >= 0.003 ? 'wait' : 'neutral',
    mood: basis === undefined ? 'neutral' : basis <= -0.0005 ? 'good' : basis >= 0.0008 ? 'wait' : 'neutral',
  };
  const order: Id[] = ['smart', 'discount', 'mood'];
  const rank = (s: Signal) => (s === 'good' ? 2 : s === 'neutral' ? 1 : 0);
  const best = [...order].sort((a, b) => rank(signal[b]) - rank(signal[a]))[0];
  const current = open ?? best;

  const rows: Record<Id, { name: string; value: string; caption: string; today: string; visual: ReactNode; prompt: string }> = {
    smart: {
      name: t.s2Name, value: bt ? pct(bt.better) : failed ? '—' : '…', caption: t.capSmart(asset),
      today: bt ? t.s2Now(pct(bt.vsMa, 1), `×${bt.mult.toFixed(2)}`) : failed ? t.stratNoData : '',
      visual: bt ? <><CostLines smart={bt.smart} plain={bt.plain} /><div className="mini-legend"><span className="lg-s">{t.lgSmart} ${fmtPrice(bt.smart[bt.smart.length - 1])}</span><span className="lg-p">{t.lgPlain} ${fmtPrice(bt.plain[bt.plain.length - 1])}</span></div></> : null,
      prompt: t.s2Prompt(asset),
    },
    discount: {
      name: t.s1Name, value: gap === undefined ? '—' : pct(gap), caption: t.capDiscount(asset),
      today: gap === undefined ? '' : t.s1Now(asset, q?.pool !== undefined ? `$${fmtPrice(q.pool)}` : '—', pct(gap)),
      visual: gap === undefined ? null : <Meter value={gap} min={-0.02} max={0.02} left={t.zoneCheap} right={t.zoneWait} />,
      prompt: t.s1Prompt(asset),
    },
    mood: {
      name: t.s3Name, value: basis === undefined ? '—' : pct(basis, 3), caption: t.capMood,
      today: basis === undefined ? '' : t.s3Now(pct(basis, 3), buyShare === undefined ? '—' : `${Math.round(buyShare * 100)}%`),
      visual: basis === undefined ? null : <Meter value={basis} min={-0.002} max={0.002} left={t.zoneFear} right={t.zoneHot} />,
      prompt: t.s3Prompt,
    },
  };

  const spentToday = vault?.configured ? Math.max(0, Number(vault.maxDailyUsdt) - Number(vault.remainingTodayUsdt)) : 0;
  const dayCap = vault?.configured ? Number(vault.maxDailyUsdt) : 0;

  return (
    <section className="board-wrap" aria-label={t.stratTitle}>
      <div className="board">
      {/* 1. strategies */}
      <div className="board-col">
        <div className="col-head">
          <h3>{t.stratTitle}</h3>
          <div className="coin-switch" role="tablist" aria-label={t.stratAsset}>
            {ASSETS.map((a) => <button key={a} role="tab" aria-selected={a === asset} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}>{a}</button>)}
          </div>
        </div>
        <ul className="strat-list">
          {order.map((k) => {
            const r = rows[k];
            const isOpen = k === current;
            return (
              <li key={k} className={isOpen ? 'open' : ''}>
                <button className="strat-row" aria-expanded={isOpen} onClick={() => setOpen(k)}>
                  <span className="sr-name">{r.name}{k === best && rank(signal[k]) === 2 && <em className="sr-best">{t.stratRec}</em>}</span>
                  <span className={`sr-value ${k === 'smart' && bt && bt.better < 0 ? 'pos' : ''}`}>{r.value}</span>
                  <span className={`sig sig-${signal[k]}`}>{t.sig[signal[k]]}</span>
                </button>
                {isOpen && (
                  <div className="strat-detail">
                    <p className="sd-caption">{r.caption}</p>
                    {r.visual}
                    {r.today && <p className="sd-today">{r.today}</p>}
                    <button className="btn-primary sd-cta" onClick={() => onAsk(r.prompt)}>{t.planIt}</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* 2. vault and bots */}
      <div className="board-col">
        <div className="col-head"><h3>{t.boardVault}</h3>{vault?.localFork && <span className="fork-badge">{t.localFork}</span>}</div>
        {vault?.configured ? (
          <>
            <div className="vault-big">{Number(vault.usdtBalance).toLocaleString('en-US', { maximumFractionDigits: 2 })}<small> USDT</small></div>
            <div className="spend-line">
              <span>{t.spentTodayOf(spentToday.toFixed(0), String(dayCap))}</span>
              <span className="track"><span style={{ width: `${dayCap ? Math.min(100, (spentToday / dayCap) * 100) : 0}%` }} /></span>
            </div>
            <p className="vault-rule">{t.trust3(vault.maxTradeUsdt ?? '?', vault.maxDailyUsdt ?? '?')}</p>
          </>
        ) : <p className="muted vault-rule">{t.vaultNone}</p>}
        <div className="bots-mini">
          <div className="bm-head"><span>{t.navBots}</span>{bots.length > 0 && <button className="text-link" onClick={onOpenBots}>{t.allBots}</button>}</div>
          {bots.length === 0 ? <p className="muted bm-empty">{t.noBotsShort}</p> : bots.slice(0, 3).map((b) => (
            <button key={b.id} className="bm-row" onClick={() => onOpenBot(b.id)}>
              <span className="bm-name">{b.name}</span>
              <span className="track"><span style={{ width: `${b.budget ? Math.min(100, (b.spent / b.budget) * 100) : 0}%` }} /></span>
              <span className="bm-num">${b.spent.toFixed(0)}{b.budget !== undefined && <span className="muted"> / ${b.budget.toFixed(0)}</span>}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 3. HSKSwap pools */}
      <div className="board-col">
        <div className="col-head"><h3>{t.boardPools}</h3><span className="muted col-note">{t.vsGate}</span></div>
        <div className="pool-rows">
          {quotes.length === 0 && [0, 1, 2].map((i) => <div key={i} className="pool-row"><span className="skel" style={{ width: '60%' }} /></div>)}
          {quotes.map((x) => {
            const g = x.gap;
            const w = g === undefined ? 0 : Math.min(50, (Math.abs(g) / 0.02) * 50);
            return (
              <button key={x.asset} className="pool-row" onClick={() => onOpenPool(x.asset)} data-tip={t.openPoolTip(x.asset)}>
                <span className="pr-coin"><span className={`coin coin-${x.asset.toLowerCase()}`} />{x.asset}</span>
                <span className="pr-price">{x.pool !== undefined ? `$${fmtPrice(x.pool)}` : '—'}<small className="muted">{x.exchange !== undefined ? `Gate $${fmtPrice(x.exchange)}` : ''}</small></span>
                <span className="pr-gap">
                  <span className="gapbar"><span className={g !== undefined && g < 0 ? 'neg-side' : 'pos-side'} style={{ width: `${w}%` }} /></span>
                  <b className={g === undefined ? '' : g < 0 ? 'pos' : 'warn'}>{g === undefined ? '—' : pct(g)}</b>
                </span>
              </button>
            );
          })}
        </div>
        <p className="muted col-foot">{t.poolsFoot}</p>
      </div>
      <p className="board-foot muted">{t.stratFoot}</p>
      </div>
    </section>
  );
}
