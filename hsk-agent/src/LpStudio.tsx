// "Liquidity strategy" on the HSKSwap screen, for someone who has never supplied liquidity. The chart fills the
// left; on the right, like an exchange's order panel, three choices one after the other: what to do, how far, how
// much. Every choice shows on the chart at once: the zones, the steps at their prices, and a line to drag. The panel
// then says what the money does in plain words, with the supply button always at its foot. Supplying is the user's
// own wallet: exact approvals, then every step in one transaction.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useT } from './i18n.ts';
import type { Asset } from './intent.ts';
import { POOLS, poolState } from './dex.ts';
import { gateCandles, type GateInterval } from './gate.ts';
import type { Candle } from './cex.ts';
import type { PoolState } from './depth.ts';
import { chainCall, sendTx, useSession } from './account.ts';
import type { VaultInfo } from './parts.tsx';
import { Icon, type IconName } from './Icons.tsx';
import { NANO_REFRESH_MS } from './nano.ts';
import { sidesFor, widthFor } from './lpTalk.ts';
import { LP_STRATEGIES, strategyPlan, type LpStrategy, type LpStrategyId } from './lpStrategies.ts';
import LpBlocks from './LpBlocks.tsx';
import type { DragLine, LadderStep, Zone } from './Trade.tsx';
import { allocate, coinQty, fullFill, holdingsAt, maxUsd, money, priceText, SMALL_SIDE_USD, type Wallet } from './lpAmount.ts';
import { allowanceOf, approveCall, balanceOf, binsOf, collectCall, fillPoints, heightsOf, mintCall, positionsOf, priceAt, removeCall, USDT, NPM, type Bin, type Goal, type LpPlan, type Position, type Shape } from './lp.ts';

export type LpZone = Zone;
/** What the studio draws on the chart. */
export interface StudioChart { zones: Zone[]; ladder: LadderStep[]; handles: DragLine[]; fit: number[] }
export const STUDIO_IV = ['1h', '4h', '1d'] as const;

const toNum = (raw: bigint, d: number) => Number(raw) / 10 ** d;
const GOAL_ICON: Record<Goal, IconName> = { buy: 'dip', sell: 'trend', both: 'collect' };
const REACH = { min: 1, max: 40 };

type Phase = { k: 'idle' } | { k: 'busy'; step: string } | { k: 'done'; tx: string } | { k: 'failed'; why: string };
type StepId = 'goal' | 'range' | 'amount';
/** What undo and redo bring back in the block editor. */
type Snap = Pick<LpPlan, 'shape' | 'weights' | 'step' | 'perSide' | 'perSideUp' | 'reachPct' | 'goal' | 'usdt' | 'coin'>;

export default function LpStudio({ plan, setPlan, vault, onClose, onAsset, onSay, chart, interval, setInterval: setIv }: {
  plan: LpPlan; setPlan: (p: LpPlan) => void; vault: VaultInfo | null; onClose: () => void; onAsset: (a: Asset) => void;
  /** Moa explains a choice on the right. */
  onSay?: (text: string) => void;
  /** The coin's candle chart with the plan drawn on it. */
  chart: (layer: StudioChart) => ReactNode;
  interval: GateInterval; setInterval: (v: GateInterval) => void;
}) {
  const { t } = useT();
  const s = useSession();
  const p = POOLS[plan.asset];
  const [pool, setPool] = useState<PoolState | null>(null);
  const [daily, setDaily] = useState<Candle[] | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [mine, setMine] = useState<Position[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [sure, setSure] = useState(false);
  const [own, setOwn] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState<StepId | null>(null);
  // On a tall screen there is room for the advanced settings to start open.
  // The drag lines carry a small "drag to change" until the first drag.
  const [dragged, setDragged] = useState(() => { try { return localStorage.getItem('moa.lpDragged') === '1'; } catch { return false; } });
  const [roomy] = useState(() => typeof window !== 'undefined' && window.innerHeight >= 1200);
  /** A range under the pointer, drawn on the chart before it is picked. */
  const [preview, setPreview] = useState<LpPlan | null>(null);
  // Step 1 starts on the ready-made strategies; setting it up by hand is one tap away.
  const [mode, setMode] = useState<'strat' | 'own'>('strat');
  const [strat, setStrat] = useState<LpStrategyId | null>(null);
  // The block editor (under the chart, or in the panel on a phone), its undo history, and the risk line's detail.
  const [blocks, setBlocks] = useState(false);
  const [hist, setHist] = useState<{ back: Snap[]; fwd: Snap[] }>({ back: [], fwd: [] });
  const [riskOpen, setRiskOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setPool(null); setDaily(null);
    const pull = () => poolState(plan.asset).then((x) => { if (alive) setPool(x); }).catch(() => { /* keeps the last state */ });
    void pull();
    gateCandles(plan.asset, '1d', 35).then((c) => { if (alive) setDaily(c); }).catch(() => { if (alive) setDaily([]); });
    const iv = setInterval(() => { if (!document.hidden) void pull(); }, NANO_REFRESH_MS / 3);
    return () => { alive = false; clearInterval(iv); };
  }, [plan.asset]);

  const price = pool ? pool.sqrtPrice ** 2 * 10 ** (p.decimals - 6) : undefined;
  const reload = useCallback(async () => {
    if (!s || !pool) { setWallet(null); setMine(null); return; }
    try {
      const [u, c, ps] = await Promise.all([balanceOf(chainCall, USDT, s.address), balanceOf(chainCall, p.token, s.address), positionsOf(chainCall, s.address, p.token, pool.sqrtPrice)]);
      setWallet({ usdt: toNum(u, 6), coin: toNum(c, p.decimals) });
      setMine(ps);
    } catch { /* the wallet could not answer; the plan still works */ }
  }, [s?.address, pool?.tick, p.token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);

  const goal = plan.goal;
  /** The coin as people call it (비트코인, not WBTC); amounts still show the token's symbol. */
  const name = plan.asset === 'BTC' ? t.coinBtc : plan.asset === 'ETH' ? t.coinEth : 'HSK';
  const at = (tick: number) => priceAt(tick, p.decimals);
  const bins = useMemo(() => (pool ? binsOf(plan, pool.tick) : []), [plan, pool?.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const B = bins.length ? bins[0].upper - bins[0].lower : plan.step;
  const sides = (g: Goal | undefined): Bin['side'][] => (g === 'buy' ? ['usdt'] : g === 'sell' ? ['coin'] : g === 'both' ? ['usdt', 'coin'] : []);
  const live = bins.filter((b) => sides(goal).includes(b.side));
  /** The far edges a plan reaches, as prices: [lowest, highest]. */
  const edgesOf = (bs: Bin[]) => (bs.length ? [at(Math.min(...bs.map((b) => b.lower))), at(Math.max(...bs.map((b) => b.upper)))] as const : null);

  /* ---------- amounts ---------- */
  const total = goal === 'buy' ? plan.usdt : goal === 'sell' ? plan.coin * (price ?? 0) : plan.usdt + plan.coin * (price ?? 0);
  const max = wallet && price && goal ? maxUsd(goal, wallet, price) : null;
  const split = goal && price ? allocate(goal, total, price, wallet, p.decimals) : null;
  const setTotal = (v: number) => {
    if (!price || !goal) return;
    const x = allocate(goal, v, price, wallet, p.decimals);
    setPlan({ ...plan, usdt: x.usdt, coin: x.coin });
  };

  /* ---------- range ---------- */
  const reached = plan.reachPct !== undefined;
  const lastDaily = daily?.length ? daily[daily.length - 1].close : undefined;
  const swing = (days: number, side: 'low' | 'high') => {
    if (!daily?.length || !lastDaily) return null;
    const xs = daily.slice(-days);
    const v = side === 'low' ? Math.min(...xs.map((c) => c.low)) : Math.max(...xs.map((c) => c.high));
    const pct = side === 'low' ? (1 - v / lastDaily) * 100 : (v / lastDaily - 1) * 100;
    return pct >= 1.5 ? Math.min(REACH.max, pct) : null;
  };
  const presets = useMemo(() => {
    if (!goal) return [];
    const out: { key: string; label: string; pct: number }[] = [{ key: 'near', label: t.lpsNear, pct: 3 }];
    const pick = (days: number) => {
      if (goal === 'buy') return swing(days, 'low');
      if (goal === 'sell') return swing(days, 'high');
      const a = swing(days, 'low'), b = swing(days, 'high');
      return a === null && b === null ? null : Math.max(a ?? 0, b ?? 0);
    };
    const w = pick(7), m = pick(30);
    const label = (k: 'week' | 'month') => (goal === 'buy' ? (k === 'week' ? t.lpsWeekLow : t.lpsMonthLow) : goal === 'sell' ? (k === 'week' ? t.lpsWeekHigh : t.lpsMonthHigh) : (k === 'week' ? t.lpsWeekRange : t.lpsMonthRange));
    if (w !== null && w > 3.5) out.push({ key: 'week', label: label('week'), pct: w });
    if (m !== null && m > (w ?? 3) * 1.25) out.push({ key: 'month', label: label('month'), pct: m });
    return out;
  }, [daily, goal, t]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Where a reach would put the edges, so each choice shows the prices it really ends at. */
  const edgesFor = (pct: number) => (pool && goal ? edgesOf(binsOf({ ...plan, ...widthFor(pct) }, pool.tick).filter((b) => sides(goal).includes(b.side))) : null);
  const rangeText = (e: readonly [number, number] | null) => (!e ? '—' : goal === 'buy' ? priceText(e[0]) : goal === 'sell' ? priceText(e[1]) : `${priceText(e[0])} ~ ${priceText(e[1])}`);

  const withReach = (pct: number): LpPlan => ({ ...plan, ...widthFor(pct), reachPct: pct, weights: undefined, shape: plan.shape === 'custom' ? 'spot' : plan.shape });
  const pickReach = (pct: number) => {
    const next = withReach(pct);
    setPlan(next);
    setOpen(null);
    if (pool) say(next, pool.tick);
  };
  const pickOwn = () => {
    const v = Number(own.replace(/[^0-9.]/g, ''));
    if (!price || !(v > 0)) return;
    const pct = goal === 'sell' ? (v / price - 1) * 100 : (1 - v / price) * 100;
    if (pct >= REACH.min * 0.8 && pct <= REACH.max) pickReach(pct);
  };

  /* ---------- a ready-made strategy ---------- */
  // It counts as the plan's strategy only while the plan still has its goal, shape and width.
  const stratNow = strat ? LP_STRATEGIES.find((x) => x.id === strat && x.goal === plan.goal && x.shape === plan.shape && widthFor(x.reachPct).step === plan.step && widthFor(x.reachPct).perSide === plan.perSide && (plan.perSideUp ?? plan.perSide) === plan.perSide) ?? null : null;
  const pickStrat = (x: LpStrategy) => {
    const sp = strategyPlan(x);
    const keep = price && total > 0 ? allocate(sp.goal!, Math.round(total * 100) / 100, price, wallet, p.decimals) : { usdt: 0, coin: 0 };
    setPlan({ ...plan, ...sp, usdt: keep.usdt, coin: keep.coin, weights: undefined });
    setStrat(x.id); setOpen(null); setDraft(null);
    onSay?.(t.lpsStratSay(t.lpsStrat[x.id][0], t.lpsStrat[x.id][1]));
  };

  /* ---------- the manual path: the block editor is where the plan is made ---------- */
  /** Which sides hold orders says what the plan does. */
  const goalOf = (down: number, up: number): Goal => (down > 0 && up > 0 ? 'both' : down > 0 ? 'buy' : 'sell');
  const enterOwn = () => {
    setMode('own'); setBlocks(true); setOpen(null);
    if (goal && reached) return;   // a plan already on screen (a strategy, or Moa's) is the starting point
    const g: Goal = 'both', keep = price && total > 0 ? allocate(g, total, price, wallet, p.decimals) : { usdt: 0, coin: 0 };
    setPlan({ ...plan, goal: g, ...widthFor(6), reachPct: 6, shape: 'spot', weights: undefined, usdt: keep.usdt, coin: keep.coin });
  };
  /** Orders below and above, from the editor; 0 on a side turns it off, and the amount follows the new sides. */
  const setCounts = (down: number, up: number) => {
    if (down + up <= 0) return;
    begin();
    const g = goalOf(down, up), cents = Math.round(total * 100) / 100;
    const keep = price && cents > 0 ? allocate(g, cents, price, wallet, p.decimals) : { usdt: plan.usdt, coin: plan.coin };
    const n = down || plan.perSide, m = up || (plan.perSideUp ?? plan.perSide);
    // Only a side switched off or back on: the block heights stay as they were.
    const same = n === plan.perSide && m === (plan.perSideUp ?? plan.perSide);
    setPlan({ ...plan, goal: g, perSide: n, perSideUp: m, usdt: keep.usdt, coin: keep.coin, ...(same ? {} : { weights: undefined, shape: plan.shape === 'custom' ? 'spot' as Shape : plan.shape }) });
  };

  /** The result in Moa's words. */
  const say = (pl: LpPlan, tick: number) => {
    const b = binsOf(pl, tick), buy = fillPoints(b, 'usdt'), sell = fillPoints(b, 'coin');
    const lines = [
      buy && t.lpsHowBuy(priceText(at(buy.halfTick)), money(buy.halfAmount), priceText(at(buy.fullTick))),
      sell && t.lpsHowSell(priceText(at(sell.halfTick)), priceText(at(sell.fullTick))),
    ].filter(Boolean);
    if (lines.length) onSay?.(`${lines.join(' ')} ${t.lpsResAfter}`);
  };
  const pickAmount = (v: number) => {
    if (!price || !goal) return;
    const x = allocate(goal, v, price, wallet, p.decimals), next = { ...plan, usdt: x.usdt, coin: x.coin };
    setPlan(next); setDraft(null); setOpen(null);
    if (pool && next.reachPct !== undefined) say(next, pool.tick);
  };

  /* ---------- what it does ---------- */
  const buy = fillPoints(bins, 'usdt'), sell = fillPoints(bins, 'coin');
  const ready = !!goal && total > 0 && reached;
  const next: StepId | null = !goal ? 'goal' : !reached ? 'range' : !(total > 0) ? 'amount' : null;
  const cur = open ?? next;
  const manual = mode === 'own';
  const stage = manual ? (!goal || !reached ? 0 : !(total > 0) ? 1 : 2) : !goal ? 0 : !reached ? 1 : !(total > 0) ? 2 : 3;
  const progress = manual ? t.lpsProgressOwn : t.lpsProgress;
  const usdtBins = live.filter((b) => b.side === 'usdt'), coinBins = live.filter((b) => b.side === 'coin');
  const buyEdge = edgesOf(usdtBins), sellEdge = edgesOf(coinBins);

  // The chart: zones, the steps at their prices (sized by dollars, or by shape before there is an amount), and the
  // lines that set how far the plan reaches.
  const layer = useMemo((): StudioChart => {
    const look = preview ?? plan, g = look.goal;
    const live = pool && g ? binsOf(look, pool.tick).filter((b) => sides(g).includes(b.side)) : [];
    const buyEdge = edgesOf(live.filter((b) => b.side === 'usdt')), sellEdge = edgesOf(live.filter((b) => b.side === 'coin'));
    if (!g || !(reached || preview) || !price || !live.length) return { zones: [], ladder: [], handles: [], fit: [] };
    const dollars = live.map((b) => (b.side === 'usdt' ? b.amount : b.amount * price));
    const ghost = !(Math.max(0, ...dollars) > 0);
    const sizes = ghost ? live.map((b) => b.weight) : dollars;
    const top = Math.max(1e-12, ...sizes);
    const ladder: LadderStep[] = live.map((b, i) => ({ from: at(b.lower), to: at(b.upper), size: sizes[i] / top, tone: b.side === 'usdt' ? 'buy' : 'sell', ghost }));
    const zones: Zone[] = [], handles: DragLine[] = [];
    // Each line moves its own side; the other side keeps how far it reaches (one step width serves both).
    const nowDown = buyEdge ? (1 - buyEdge[0] / price) * 100 : undefined, nowUp = sellEdge ? (sellEdge[1] / price - 1) * 100 : undefined;
    const move = (side: 'buy' | 'sell') => (v: number) => {
      const pct = Math.max(REACH.min, Math.min(REACH.max, side === 'buy' ? (1 - v / price) * 100 : (v / price - 1) * 100));
      const dn = side === 'buy' ? pct : nowDown ?? pct, upp = side === 'sell' ? pct : nowUp ?? pct;
      const w = sidesFor(dn, upp);
      if (w.step === plan.step && w.perSide === plan.perSide && w.perSideUp === (plan.perSideUp ?? plan.perSide)) return;
      setPlan({ ...plan, ...w, reachPct: Math.max(dn, upp), weights: undefined, shape: plan.shape === 'custom' ? 'spot' : plan.shape });
    };
    const done = () => {
      if (pool) say(plan, pool.tick);
      if (!dragged) { setDragged(true); try { localStorage.setItem('moa.lpDragged', '1'); } catch { /* this visit only */ } }
    };
    const hint = dragged ? undefined : t.lpsDragTip;
    if (buyEdge) {
      zones.push({ from: buyEdge[0], to: buyEdge[1], tone: 'buy', label: t.lpsZoneBuy });
      handles.push({ price: buyEdge[0], tone: 'buy', label: `↕  ${t.lpsHandleBuy(priceText(buyEdge[0]), `−${((1 - buyEdge[0] / price) * 100).toFixed(1)}%`)}`, hint, onMove: move('buy'), onDone: done });
    }
    if (sellEdge) {
      zones.push({ from: sellEdge[0], to: sellEdge[1], tone: 'sell', label: t.lpsZoneSell });
      handles.push({ price: sellEdge[1], tone: 'sell', label: `↕  ${t.lpsHandleSell(priceText(sellEdge[1]), `+${((sellEdge[1] / price - 1) * 100).toFixed(1)}%`)}`, hint, onMove: move('sell'), onDone: done });
    }
    const lo = Math.min(...ladder.map((x) => x.from)), hi = Math.max(...ladder.map((x) => x.to));
    return { zones, ladder, handles, fit: [lo * 0.992, hi * 1.008, price] };
  }, [plan, pool?.tick, goal, reached, price, preview, dragged, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the whole side turns into if the price goes all the way through it, and at what average price.
  const asSteps = (bs: Bin[]) => bs.map((b) => ({ lo: at(b.lower), hi: at(b.upper), amount: b.amount }));
  const endBuy = ready ? fullFill(asSteps(usdtBins), 'buy') : null, endSell = ready ? fullFill(asSteps(coinBins), 'sell') : null;
  // What the wallet will be asked, the same amounts the supply sends (the recipient does not change them).
  const ask = ready && pool ? mintCall(p.token, bins, p.decimals, s?.address ?? '0x0000000000000000000000000000000000000000', 0) : null;
  const useBuyOnly = () => {
    if (!price) return;
    const x = allocate('buy', total, price, wallet, p.decimals), next = { ...plan, goal: 'buy' as Goal, usdt: x.usdt, coin: 0 };
    setPlan(next);
    onSay?.(t.lpsSayGoal.buy(name));
  };

  // One plain sentence first; the details, a few "what if" prices and the risk are computed from the same steps.
  const lead = !ready || !price ? '' : goal === 'buy' && buyEdge ? t.lpsLeadBuy(name, priceText(buyEdge[0]), money(plan.usdt), usdtBins.length)
    : goal === 'sell' && sellEdge ? t.lpsLeadSell(name, priceText(sellEdge[1]), money(plan.coin * price), coinBins.length)
      : buyEdge && sellEdge ? t.lpsLeadBoth(name, priceText(buyEdge[0]), money(plan.usdt), priceText(sellEdge[1]), money(plan.coin * price)) : '';
  const allSteps = live.map((b) => ({ lo: at(b.lower), hi: at(b.upper), amount: b.amount, side: b.side === 'usdt' ? 'buy' as const : 'sell' as const }));
  const whatIf = !ready || !price ? [] : ([...(goal !== 'sell' ? [-5] : []), ...(goal !== 'buy' ? [5] : [])] as number[]).map((pct) => {
    const at2 = price * (1 + pct / 100), h = holdingsAt(allSteps, at2);
    return {
      label: pct < 0 ? t.lpsIfDown('5%', priceText(at2)) : t.lpsIfUp('5%', priceText(at2)),
      hold: t.lpsIfHold(money(h.usdt), coinQty(h.coin), p.symbol), worth: t.lpsIfWorth(money(h.worth)),
    };
  });
  const risk = !ready || !price ? [] : [
    goal === 'both' && buyEdge ? t.lpsRiskBuyShort(priceText(buyEdge[0]), money(plan.usdt), name)
      : goal === 'buy' && buyEdge && endBuy ? t.lpsRiskBuy(priceText(buyEdge[0]), money(endBuy.spent), name, `${coinQty(endBuy.got)} ${p.symbol}`, money(endBuy.got * buyEdge[0] * 0.9)) : null,
    goal !== 'buy' && sellEdge && endSell ? t.lpsRiskSell(priceText(sellEdge[1]), name, money(endSell.got)) : null,
  ].filter((x): x is string => !!x);
  /** The same login as the button at the top right (it also offers the wallet list, or how to get a wallet). */
  const connect = () => {
    const b = document.querySelector<HTMLButtonElement>('.acct-login');
    if (b) { b.scrollIntoView({ block: 'nearest' }); b.click(); }
  };

  /* ---------- supplying ---------- */
  const short = wallet ? (plan.usdt > wallet.usdt + 1e-9 ? 'USDT' : plan.coin > wallet.coin + 1e-12 ? p.symbol : null) : null;
  const m = pool && s && ready ? mintCall(p.token, bins, p.decimals, s.address, Math.floor(Date.now() / 1000) + 1200) : null;
  const supply = async () => {
    if (!s || !vault?.net || !m || !m.count) return;
    const net = vault.net;
    try {
      for (const [token, need, name] of [[USDT, m.usdtRaw, 'USDT'], [p.token, m.coinRaw, p.symbol]] as const) {
        if (need <= 0n) continue;
        if ((await allowanceOf(chainCall, token, s.address)) >= need) continue;
        setPhase({ k: 'busy', step: t.lpStepApprove(name) });
        const r = await sendTx(net, token, approveCall(need));
        if (!r.ok) { setPhase({ k: 'failed', why: r.why === 'rejected' ? t.lpRejected : r.detail ?? r.why }); return; }
      }
      setPhase({ k: 'busy', step: t.lpStepMint(m.count) });
      const fresh = mintCall(p.token, bins, p.decimals, s.address, Math.floor(Date.now() / 1000) + 1200);
      const r = await sendTx(net, NPM, fresh.data);
      if (!r.ok) { setPhase({ k: 'failed', why: r.why === 'rejected' ? t.lpRejected : r.detail ?? r.why }); return; }
      setPhase({ k: 'done', tx: r.txHash });
      // What was planned is now in the pool (listed below): clear the amounts so the same plan is not sent twice.
      setPlan({ ...plan, usdt: 0, coin: 0 });
      onSay?.(t.lpsSayDone);
      void reload();
    } catch (e) { setPhase({ k: 'failed', why: e instanceof Error ? e.message : String(e) }); }
  };
  const act = async (kind: 'collect' | 'remove') => {
    if (!s || !vault?.net || !mine?.length) return;
    if (kind === 'remove' && !sure) { setSure(true); return; }
    setSure(false);
    setPhase({ k: 'busy', step: kind === 'collect' ? t.lpCollect : t.lpRemove });
    const data = kind === 'collect' ? collectCall(mine, s.address) : removeCall(mine, s.address, Math.floor(Date.now() / 1000) + 1200);
    const r = await sendTx(vault.net, NPM, data);
    setPhase(r.ok ? { k: 'done', tx: r.txHash } : { k: 'failed', why: r.why === 'rejected' ? t.lpRejected : r.detail ?? r.why });
    void reload();
  };
  const mineValue = mine && price ? mine.reduce((v, x) => v + toNum(x.raw1, 6) + toNum(x.raw0, p.decimals) * price, 0) : 0;
  const mineFees = mine && price ? mine.reduce((v, x) => v + toNum(x.fee1, 6) + toNum(x.fee0, p.decimals) * price, 0) : 0;
  const explorer = vault?.net?.explorer ?? 'https://hsk.blockscout.com';
  const amountPresets = max !== null && max > 0
    ? [0.25, 0.5, 1].map((f) => ({ label: f === 1 ? t.lpsAll : `${f * 100}%`, v: f === 1 ? max : Math.floor(max * f * 100) / 100 }))
    : [50, 100, 300].map((v) => ({ label: `$${v}`, v }));

  /* ---------- the block editor ---------- */
  const heights = heightsOf(plan, bins);
  const snap = (): Snap => ({ shape: plan.shape, weights: plan.weights, step: plan.step, perSide: plan.perSide, perSideUp: plan.perSideUp, reachPct: plan.reachPct, goal: plan.goal, usdt: plan.usdt, coin: plan.coin });
  const begin = () => setHist((h) => ({ back: [...h.back.slice(-49), snap()], fwd: [] }));
  const undo = () => { const last = hist.back[hist.back.length - 1]; if (!last) return; setHist({ back: hist.back.slice(0, -1), fwd: [...hist.fwd, snap()] }); setPlan({ ...plan, ...last }); };
  const redo = () => { const last = hist.fwd[hist.fwd.length - 1]; if (!last) return; setHist({ back: [...hist.back, snap()], fwd: hist.fwd.slice(0, -1) }); setPlan({ ...plan, ...last }); };
  const setShape = (x: Shape) => { begin(); setPlan({ ...plan, shape: x, weights: x === 'custom' ? heights : undefined }); };
  const editor = goal && reached && price && bins.length > 0 ? (
    <LpBlocks bins={bins} heights={heights} goal={goal} price={price} at={at} symbol={p.symbol}
      shape={plan.shape} onShape={setShape} onBegin={begin} onHeights={(h) => setPlan({ ...plan, shape: 'custom', weights: h })}
      step={B} onStep={(x) => { begin(); setPlan({ ...plan, step: x, weights: undefined, shape: plan.shape === 'custom' ? 'spot' : plan.shape }); }}
      down={goal === 'sell' ? 0 : plan.perSide} up={goal === 'buy' ? 0 : plan.perSideUp ?? plan.perSide}
      onCounts={setCounts}
      canUndo={hist.back.length > 0} canRedo={hist.fwd.length > 0} onUndo={undo} onRedo={redo} onClose={() => setBlocks(false)} />
  ) : null;

  /** How far the plan really reaches (its far edge), which can sit a little off the price that was asked for. */
  const reachText = () => {
    const e = edgesOf(live);
    if (!e || !price) return '';
    const down = (1 - e[0] / price) * 100, up = (e[1] / price - 1) * 100;
    return goal === 'buy' ? `−${down.toFixed(1)}%` : goal === 'sell' ? `+${up.toFixed(1)}%` : `−${down.toFixed(1)}% / +${up.toFixed(1)}%`;
  };
  const summary: Record<StepId, string | null> = {
    goal: stratNow ? t.lpsStrat[stratNow.id][0] : goal ? t.lpsGoal[goal][0] : null,
    range: reached && price ? (goal === 'both' ? rangeText(edgesOf(live)) : `${rangeText(edgesOf(live))} · ${reachText()}`) : null,
    amount: total > 0 ? money(total) : null,
  };
  const step = (id: StepId, n: number, title: string, body: ReactNode, locked: boolean) => {
    const isOpen = cur === id && !locked, done = summary[id] !== null;
    return (
      <section className={`lps-step${isOpen ? ' open' : ''}${done ? ' done' : ''}${locked ? ' locked' : ''}`}>
        {isOpen ? (
          <div className="lps-step-head"><span className="lps-n">{n}</span><b>{title}</b></div>
        ) : (
          <button className="lps-step-head" disabled={locked} onClick={() => setOpen(id)} aria-expanded={false} aria-label={done ? `${t.lpsShort[id]}: ${summary[id]} · ${t.lpsChange}` : title}>
            <span className="lps-n">{done ? <Icon name="check" size={14} /> : n}</span>
            <span className="lps-step-label">{done ? t.lpsShort[id] : title}</span>
            {done && <b className="lps-step-val">{summary[id]}</b>}
            {done && <span className="lps-step-edit" aria-hidden><Icon name="edit" size={15} /></span>}
          </button>
        )}
        {isOpen && <div className="lps-step-body">{body}</div>}
      </section>
    );
  };

  const stratList = (
    <div className="lps-strats" role="radiogroup" aria-label={t.lpsModeStrat}>
      {LP_STRATEGIES.map((x) => {
        const on = stratNow?.id === x.id;
        const reach = x.goal === 'buy' ? `−${x.reachPct}%` : x.goal === 'sell' ? `+${x.reachPct}%` : `±${x.reachPct}%`;
        return (
          <button key={x.id} role="radio" aria-checked={on} className={`lps-strat g-${x.goal}${on ? ' on' : ''}`} onClick={() => { setPreview(null); pickStrat(x); }}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') setPreview({ ...plan, ...strategyPlan(x), usdt: 0, coin: 0, weights: undefined }); }} onPointerLeave={() => setPreview(null)}>
            <span className="lps-goal-ico"><Icon name={GOAL_ICON[x.goal]} size={15} /></span>
            <span className="lps-strat-txt"><b>{t.lpsStrat[x.id][0]}</b><small>{t.lpsStrat[x.id][1]}</small></span>
            <em className="lps-strat-reach">{reach}</em>
          </button>
        );
      })}
    </div>
  );
  const sign = goal === 'both' ? '±' : goal === 'sell' ? '+' : '−';
  const rangeBody = (
    <>
      <div className="lps-opts" role="radiogroup">
        {presets.map((x) => {
          const on = plan.reachPct !== undefined && Math.abs(plan.reachPct - x.pct) < 0.01;
          return (
            <button key={x.key} role="radio" aria-checked={on} className={`lps-opt${on ? ' on' : ''}`} onClick={() => { setPreview(null); pickReach(x.pct); }}
              onPointerEnter={(e) => { if (e.pointerType === 'mouse') setPreview(withReach(x.pct)); }} onPointerLeave={() => setPreview(null)}>
              <span className="lps-opt-name">{x.label}<em>{sign}{x.pct.toFixed(1)}%</em></span>
              <b className="lps-opt-val">{rangeText(edgesFor(x.pct))}</b>
            </button>
          );
        })}
      </div>
      <div className="lps-own">
        <span>$</span>
        <input inputMode="decimal" placeholder={goal === 'both' ? t.lpsOwnLow : t.lpsOwnPrice} value={own} onChange={(e) => setOwn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') pickOwn(); }} aria-label={goal === 'both' ? t.lpsOwnLow : t.lpsOwnPrice} />
        <button className="btn sm" onClick={pickOwn}>{t.lpsSet}</button>
      </div>
      <p className="lps-tip">{t.lpsDragHint}</p>
    </>
  );
  const amountBody = (
    <>
      <label className="lps-usd">
        <span>$</span>
        <input inputMode="decimal" value={draft ?? (total > 0 ? (Math.floor(total * 100) / 100).toFixed(2) : '')} placeholder="0.00" aria-label={t.lpsQAmount}
          onFocus={() => setOpen('amount')}
          onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ''); setDraft(v); setTotal(Number(v) || 0); }}
          onBlur={() => { setDraft(null); if (ready && pool) say(plan, pool.tick); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { setDraft(null); setOpen(null); } }} />
        <em>USD</em>
      </label>
      <div className="lps-chips">{amountPresets.map((x) => <button key={x.label} className={Math.abs(total - x.v) < 0.005 ? 'on' : ''} onClick={() => pickAmount(x.v)}>{x.label}</button>)}</div>
      {wallet && price ? <p className="lps-tip">{t.lpsWalletLine(wallet.usdt.toFixed(2), coinQty(wallet.coin), money(wallet.coin * price), p.symbol)}</p> : <p className="lps-tip">{t.lpNeedLogin}</p>}
    </>
  );

  const ownLine = goal && price ? [
    goal !== 'sell' && buyEdge ? t.lpsOwnBuy(usdtBins.length, priceText(buyEdge[0])) : null,
    goal !== 'buy' && sellEdge ? t.lpsOwnSell(coinBins.length, priceText(sellEdge[1])) : null,
  ].filter(Boolean).join(' · ') : '';
  const footLabel = !goal ? t.lpsNeed.goal : !reached ? t.lpsNeed.range : !(total > 0) ? t.lpsNeed.amount : t.lpsSupplyGo;

  return (
    <section className="lps" aria-label={t.lpOpen}>
      <header className="lps-head">
        <b className="lps-name">{t.lpOpen}</b>
        <div className="coin-switch" role="tablist" aria-label={t.stratAsset}>
          {(['HSK', 'ETH', 'BTC'] as Asset[]).map((a) => <button key={a} role="tab" aria-selected={a === plan.asset} className={a === plan.asset ? 'on' : ''} onClick={() => onAsset(a)}>{POOLS[a].symbol}</button>)}
        </div>
        <span className="lps-pool">HSKSwap · 0.3% · <b>{price !== undefined ? priceText(price) : '—'}</b></span>
        <button className="icon-btn lps-x" onClick={onClose} aria-label={t.lpClose} data-tip={t.lpClose}><Icon name="close" size={18} /></button>
      </header>

      <div className="lps-stage">
        <div className={`lps-chart${blocks && editor ? ' editing' : ''}`}>
          {goal && reached && price && (buyEdge || sellEdge) && (
            <div className="lps-out" aria-live="polite">
              {buyEdge && (
                <div className="lps-tile buy">
                  <span>{t.lpsOutBuy(`−${((1 - buyEdge[0] / price) * 100).toFixed(1)}%`)}</span><b>{t.lpsOutDown(priceText(buyEdge[0]))}</b>
                  {goal === 'both' && endBuy ? <small title={t.lpsOutFeeNote}>{t.lpsOutAllBuy(`${coinQty(endBuy.got)} ${p.symbol}`, priceText(endBuy.avg))}</small>
                    : <small>{ready ? t.lpsOutBuySub(money(plan.usdt), usdtBins.length) : t.lpsOutPieces(usdtBins.length)}</small>}
                </div>
              )}
              {sellEdge && (
                <div className="lps-tile sell">
                  <span>{t.lpsOutSell(`+${((sellEdge[1] / price - 1) * 100).toFixed(1)}%`)}</span><b>{t.lpsOutUp(priceText(sellEdge[1]))}</b>
                  {goal === 'both' && endSell ? <small title={t.lpsOutFeeNote}>{t.lpsOutAllSell(money(endSell.got), priceText(endSell.avg))}</small>
                    : <small>{ready ? t.lpsOutSellSub(money(plan.coin * price), coinBins.length) : t.lpsOutPieces(coinBins.length)}</small>}
                </div>
              )}
              {goal === 'buy' && endBuy && buyEdge && (
                <div className="lps-tile buy" title={t.lpsOutFeeNote}>
                  <span>{t.lpsOutBuyEnd(priceText(buyEdge[0]))}</span><b>≈ {coinQty(endBuy.got)} {p.symbol}</b><small>{t.lpsOutAvgBuy(priceText(endBuy.avg))}</small>
                </div>
              )}
              {goal === 'sell' && endSell && sellEdge && (
                <div className="lps-tile sell" title={t.lpsOutFeeNote}>
                  <span>{t.lpsOutSellEnd(priceText(sellEdge[1]))}</span><b>≈ {money(endSell.got)} USDT</b><small>{t.lpsOutAvgSell(priceText(endSell.avg))}</small>
                </div>
              )}
            </div>
          )}
          <div className="lps-chart-bar">
            <div className="seg" role="group" aria-label="Interval">
              {STUDIO_IV.map((v) => <button key={v} className={interval === v ? 'on' : ''} aria-pressed={interval === v} onClick={() => setIv(v)}>{t.ivLabel[v]}</button>)}
            </div>
            <span className="lps-legend">
              {goal && goal !== 'sell' && <span><i className="lg-buy" />{t.lpsLegendBuy}</span>}
              {goal && goal !== 'buy' && <span><i className="lg-sell" />{t.lpsLegendSell(name)}</span>}
            </span>
          </div>
          <div className="lps-chartbox">{chart(layer)}</div>
          {blocks && editor && <div className="lps-blocks-chart">{editor}</div>}
        </div>

        <aside className="lps-ticket">
          <div className="lps-flow">
            <ol className="lps-prog" aria-label={t.lpOpen}>
              {progress.map((x, i) => <li key={x} className={i < stage ? 'done' : i === stage ? 'now' : ''} aria-current={i === stage ? 'step' : undefined}><i>{i < stage ? '✓' : i + 1}</i>{x}</li>)}
            </ol>
            <div className="seg lps-mode" role="tablist">
              <button role="tab" aria-selected={!manual} className={!manual ? 'on' : ''} onClick={() => setMode('strat')}>{t.lpsModeStrat}</button>
              <button role="tab" aria-selected={manual} className={manual ? 'on' : ''} onClick={enterOwn}>{t.lpsModeOwn}</button>
            </div>
            {manual ? (
              <>
                {goal && reached && (
                  <button className={`lps-own-row${blocks ? ' on' : ''}`} onClick={() => setBlocks(true)}>
                    <span className="lps-n"><Icon name="check" size={14} /></span>
                    <span className="lps-own-txt"><b>{t.lpsOwnSet}</b><small>{ownLine}</small></span>
                    <span className="lps-step-edit" aria-hidden><Icon name="edit" size={15} /></span>
                  </button>
                )}
                {blocks && editor && <div className="lps-blocks-panel">{editor}</div>}
                {step('amount', 2, t.lpsQAmount, amountBody, !goal || !reached)}
              </>
            ) : (
              <>
                {step('goal', 1, t.lpsQStrat, stratList, false)}
                {step('range', 2, goal ? t.lpsQRange[goal] : t.lpsQRange.buy, rangeBody, !goal)}
                {step('amount', 3, t.lpsQAmount, amountBody, !goal || !reached)}
              </>
            )}

            {ready && (
              <section className="lps-result" aria-live="polite">
                <h3>{t.lpsResTitle}</h3>
                <p className="lps-lead">{lead}</p>
                {split?.short === 'coin' && price && (
                  <div className="lps-flag">{t.lpsCoinShort(name, money(split.coinUsd), money(split.moved))}<button className="btn sm" onClick={useBuyOnly}>{t.lpsUseBuy}</button></div>
                )}
                {split?.short === 'usdt' && <p className="lps-flag">{t.lpsUsdtShort(money(split.usdt), money(split.moved))}</p>}
                {goal !== 'sell' && plan.usdt > 0 && plan.usdt < SMALL_SIDE_USD && <p className="lps-flag">{t.lpsTooSmall('USDT', money(plan.usdt))}</p>}
                {goal !== 'buy' && price && plan.coin > 0 && plan.coin * price < SMALL_SIDE_USD && !split?.short && <p className="lps-flag">{t.lpsTooSmall(name, money(plan.coin * price))}</p>}
                <details className="lps-more" open={roomy || undefined}>
                  <summary>{t.lpsMore}</summary>
                  <ul className="lps-say">
                    {buy && <li className="buy">{t.lpsHowBuy(priceText(at(buy.halfTick)), money(buy.halfAmount), priceText(at(buy.fullTick)))}</li>}
                    {sell && <li className="sell">{t.lpsHowSell(priceText(at(sell.halfTick)), priceText(at(sell.fullTick)))}</li>}
                  </ul>
                  {whatIf.length > 0 && (
                    <div className="lps-if">
                      <b>{t.lpsIfTitle}</b>
                      {whatIf.map((w) => (
                        <div key={w.label} className="lps-if-row"><span>{w.label}</span><span>{w.hold}</span><b>{w.worth}</b></div>
                      ))}
                    </div>
                  )}
                  <p className="lps-fine">{t.lpsResAfter}</p>
                </details>
              </section>
            )}

            {ask && ask.count > 0 && (
              <section className="lps-sign">
                <b>{t.lpsSignTitle}</b>
                <ol>
                  {ask.usdtRaw > 0n && <li>{t.lpsSignAllow(`${(Number(ask.usdtRaw) / 1e6).toFixed(2)} USDT`)}</li>}
                  {ask.coinRaw > 0n && <li>{t.lpsSignAllow(`${coinQty(Number(ask.coinRaw) / 10 ** p.decimals)} ${p.symbol}`)}</li>}
                  <li>{t.lpsSignMint(ask.count)}</li>
                </ol>
                <small>{t.lpsSignSkip}</small>
              </section>
            )}

            {!manual && goal && reached && (
              <button className={`lps-adv-btn${blocks ? ' on' : ''}`} onClick={() => setBlocks((v) => !v)} aria-expanded={blocks}>
                <span>{t.lpsAdvanced}</span><small>{t.lpShapes[plan.shape]}</small><Icon name="down" size={14} />
              </button>
            )}
            {!manual && blocks && editor && <div className="lps-blocks-panel">{editor}</div>}

            {s && (
              <section className="lps-mine">
                <b>{t.lpMine}</b>
                {mine === null ? <span className="lps-tip">…</span> : !mine.length ? <span className="lps-tip">{t.lpNone}</span> : (
                  <>
                    <span>{t.lpMineSum(mine.length, money(mineValue))} · {t.lpFeesNow(money(mineFees))}</span>
                    <span className="lps-tip">{priceText(at(mine[0].lower))} – {priceText(at(mine[mine.length - 1].upper))}</span>
                    <div className="lps-mine-act">
                      <button className="btn sm" disabled={phase.k === 'busy' || mineFees <= 0} onClick={() => void act('collect')}>{t.lpCollect}</button>
                      <button className={`btn sm${sure ? ' danger' : ''}`} disabled={phase.k === 'busy'} onClick={() => void act('remove')}>{sure ? t.lpRemoveSure : t.lpRemove}</button>
                    </div>
                  </>
                )}
              </section>
            )}
            <section className="lps-how">
              <b>{t.lpsHowTitle}</b>
              <ol>{t.lpsHow(name).map((x, i) => <li key={i}>{x}</li>)}</ol>
            </section>
          </div>

          <footer className="lps-foot">
            {ready && risk.length > 0 && (
              <div className={`lps-risk${riskOpen ? ' open' : ''}`}>
                <Icon name="shield" size={14} /><p><b>{t.lpsRisk}</b> {risk.join(' ')}</p>
                <button className="lps-risk-more" onClick={() => setRiskOpen((v) => !v)} aria-expanded={riskOpen}>{riskOpen ? t.lpsRiskLess : t.lpsRiskMore}</button>
              </div>
            )}
            {ready && s && short && <p className="lps-note warn">{t.lpNoBal(short)}</p>}
            {!s && ready ? (
              <button className="btn-primary lps-supply" onClick={connect}>{t.lpsConnect}</button>
            ) : (
              <button className="btn-primary lps-supply" disabled={!ready || !s || !m?.count || !!short || phase.k === 'busy'} onClick={() => void supply()}>
                {phase.k === 'busy' ? <><span className="spin" aria-hidden />{phase.step}</> : footLabel}
              </button>
            )}
            {phase.k === 'done' && <p className="lps-note ok">{t.lpDone} <a href={`${explorer}/tx/${phase.tx}`} target="_blank" rel="noreferrer">{t.viewTx} ↗</a></p>}
            {phase.k === 'failed' && <p className="lps-note warn">{t.lpFailed(phase.why)}</p>}
          </footer>
        </aside>
      </div>
    </section>
  );
}
