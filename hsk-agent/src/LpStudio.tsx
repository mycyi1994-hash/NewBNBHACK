// "Liquidity strategy" on the HSKSwap screen, for someone who has never supplied liquidity. Three questions, one at a
// time: what to do (buy as the price comes down, sell as it goes up, or both for the fees), how much, and down (or up)
// to which price, offered as prices the chart shows (the last week's low, the last month's). The chart above draws the
// zones; the result is said in plain words; shapes and step sizes wait under "Advanced". Moa, on the right, explains
// each choice. Supplying is the user's own wallet: exact approvals, then every step in one transaction.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useT } from './i18n.ts';
import type { Asset } from './intent.ts';
import { POOLS, poolState } from './dex.ts';
import { gateCandles } from './gate.ts';
import type { Candle } from './cex.ts';
import { poolDepth, type PoolState } from './depth.ts';
import { chainCall, sendTx, useSession } from './account.ts';
import type { VaultInfo } from './parts.tsx';
import { Icon } from './Icons.tsx';
import { NANO_REFRESH_MS } from './nano.ts';
import { widthFor } from './lpTalk.ts';
import { allowanceOf, approveCall, balanceOf, binsOf, collectCall, fillPoints, mintCall, positionsOf, priceAt, removeCall, shapeWeight, withPlan, USDT, NPM, SPACING, type Goal, type LpPlan, type Position, type Shape } from './lp.ts';

export interface LpZone { from: number; to: number; tone: 'buy' | 'sell'; label: string }
const ROWS = 8;
const fmtPrice = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 1 ? v.toFixed(2) : v.toPrecision(4));
const usd = (v: number) => (v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(v >= 10 ? 0 : 2)}`);
const qty = (v: number) => (v === 0 ? '0' : v >= 1 ? Number(v.toFixed(4)).toString() : Number(v.toPrecision(4)).toString());
const toNum = (raw: bigint, d: number) => Number(raw) / 10 ** d;
const round2 = (v: number) => Math.floor(v * 100) / 100;
const usdtText = (v: number) => (v >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));

type Phase = { k: 'idle' } | { k: 'busy'; step: string } | { k: 'done'; tx: string } | { k: 'failed'; why: string };

export default function LpStudio({ plan, setPlan, vault, onClose, onAsset, onSay, chart }: {
  plan: LpPlan; setPlan: (p: LpPlan) => void; vault: VaultInfo | null; onClose: () => void; onAsset: (a: Asset) => void;
  /** Moa explains a choice on the right. */
  onSay?: (text: string) => void;
  /** The coin's candle chart with the plan's zones drawn on it. */
  chart: (zones: LpZone[]) => ReactNode;
}) {
  const { t } = useT();
  const s = useSession();
  const p = POOLS[plan.asset];
  const [pool, setPool] = useState<PoolState | null>(null);
  const [daily, setDaily] = useState<Candle[] | null>(null);
  const [wallet, setWallet] = useState<{ usdt: number; coin: number } | null>(null);
  const [mine, setMine] = useState<Position[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [sure, setSure] = useState(false);
  const [own, setOwn] = useState('');

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

  const bins = useMemo(() => (pool ? binsOf(plan, pool.tick) : []), [plan, pool?.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const B = bins.length ? bins[0].upper - bins[0].lower : plan.step;
  const at = (tick: number) => priceAt(tick, p.decimals);
  const goal = plan.goal;

  /* ---------- step 1: what to do ---------- */
  const pickGoal = (g: Goal) => {
    // Amounts carry over where they still mean something: the USDT for buying, the coin for selling.
    setPlan({ ...plan, goal: g, usdt: g === 'sell' ? 0 : plan.usdt, coin: g === 'buy' ? 0 : plan.coin, shape: plan.shape === 'custom' ? 'spot' : plan.shape, weights: undefined });
    onSay?.(t.lpsSayGoal[g](p.symbol));
  };

  /* ---------- step 2: how much (in USDT; for both, half the value goes in the coin) ---------- */
  const maxUsd = wallet && price ? (goal === 'buy' ? wallet.usdt : goal === 'sell' ? wallet.coin * price : 2 * Math.min(wallet.usdt, wallet.coin * price)) : null;
  const total = goal === 'buy' ? plan.usdt : goal === 'sell' ? plan.coin * (price ?? 0) : plan.usdt + plan.coin * (price ?? 0);
  const setTotal = (v: number) => {
    if (!price || !goal) return;
    const x = Math.max(0, v);
    setPlan(goal === 'buy' ? { ...plan, usdt: round2(x), coin: 0 } : goal === 'sell' ? { ...plan, usdt: 0, coin: x / price } : { ...plan, usdt: round2(x / 2), coin: x / 2 / price });
  };

  /* ---------- step 3: to which price ---------- */
  const lastDaily = daily?.length ? daily[daily.length - 1].close : undefined;
  const fromChart = (days: number, side: 'low' | 'high') => {
    if (!daily?.length || !lastDaily || !price) return null;
    const xs = daily.slice(-days);
    const v = side === 'low' ? Math.min(...xs.map((c) => c.low)) : Math.max(...xs.map((c) => c.high));
    const pct = side === 'low' ? (1 - v / lastDaily) * 100 : (v / lastDaily - 1) * 100;
    // The pool's own price can sit a little off the exchange's: the same distance, on the pool's price.
    return pct >= 1.5 ? { pct, price: side === 'low' ? price * (1 - pct / 100) : price * (1 + pct / 100) } : null;
  };
  const dir: 'low' | 'high' = goal === 'sell' ? 'high' : 'low';
  const presets = useMemo(() => {
    const out: { key: string; label: string; pct: number }[] = [{ key: 'near', label: t.lpsNear, pct: 3 }];
    const w = fromChart(7, dir), m = fromChart(30, dir);
    if (w) out.push({ key: 'week', label: dir === 'low' ? t.lpsWeekLow(`$${fmtPrice(w.price)}`) : t.lpsWeekHigh(`$${fmtPrice(w.price)}`), pct: w.pct });
    if (m && (!w || m.pct > w.pct * 1.25)) out.push({ key: 'month', label: dir === 'low' ? t.lpsMonthLow(`$${fmtPrice(m.price)}`) : t.lpsMonthHigh(`$${fmtPrice(m.price)}`), pct: m.pct });
    return out;
  }, [daily, price, dir, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickReach = (pct: number) => {
    const next = { ...plan, ...widthFor(pct), reachPct: pct, weights: undefined, shape: plan.shape === 'custom' ? 'spot' as Shape : plan.shape };
    setPlan(next);
    if (pool) say(next, pool.tick);
  };
  const pickOwn = () => {
    const v = Number(own.replace(/[^0-9.]/g, ''));
    if (!price || !(v > 0)) return;
    const pct = dir === 'low' ? (1 - v / price) * 100 : (v / price - 1) * 100;
    if (pct > 0.8 && pct < 80) pickReach(pct);
  };

  /** The result in Moa's words, once the three are chosen. */
  const say = (pl: LpPlan, tick: number) => {
    const b = binsOf(pl, tick), buy = fillPoints(b, 'usdt'), sell = fillPoints(b, 'coin');
    const lines = [
      buy && t.lpsResBuy(`$${fmtPrice(at(buy.halfTick))}`, usdtText(buy.halfAmount), `$${fmtPrice(at(buy.fullTick))}`, usdtText(buy.total), p.symbol),
      sell && t.lpsResSell(`$${fmtPrice(at(sell.halfTick))}`, `$${fmtPrice(at(sell.fullTick))}`, qty(sell.total), p.symbol),
    ].filter(Boolean);
    if (lines.length) onSay?.(`${lines.join(' ')} ${t.lpsResAfter}`);
  };

  /* ---------- the result ---------- */
  const buy = fillPoints(bins, 'usdt'), sell = fillPoints(bins, 'coin');
  const ready = !!goal && total > 0 && plan.reachPct !== undefined;
  const zones: LpZone[] = [];
  if (buy) zones.push({ from: at(buy.fullTick), to: at(bins.find((x) => x.side === 'usdt' && x.d === 1)!.upper), tone: 'buy', label: t.lpsZoneBuy });
  if (sell) zones.push({ from: at(bins.find((x) => x.side === 'coin' && x.d === 1)!.lower), to: at(sell.fullTick), tone: 'sell', label: t.lpsZoneSell });
  const depth = useMemo(() => {
    if (!pool || !(buy || sell)) return null;
    const a = poolDepth(pool), d = poolDepth(withPlan(pool, bins, p.decimals));
    const get = (x: typeof a, pct: number) => x.bands.find((y) => y.pct === pct)!.usdt;
    return { down: [get(a, -2), get(d, -2)], up: [get(a, 2), get(d, 2)] };
  }, [pool, bins, p.decimals]); // eslint-disable-line react-hooks/exhaustive-deps

  const heights = bins.map((b) => (b.side === 'usdt' ? b.amount : b.amount * (price ?? 0)));
  const maxH = Math.max(1e-12, ...heights);
  const nudge = (i: number, by: number) => {
    let base: number[];
    if (plan.shape === 'custom' && plan.weights?.length === bins.length) base = plan.weights;
    else {
      const shape = plan.shape === 'custom' ? 'spot' : plan.shape;
      const raw = bins.map((b) => shapeWeight(shape, b.d, plan.perSide)), top = Math.max(...raw);
      base = raw.map((x) => Math.round((x / top) * 10));
    }
    const w = [...base];
    w[i] = Math.max(0, Math.min(10, (w[i] ?? 0) + by));
    setPlan({ ...plan, shape: 'custom', weights: w });
  };

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
  const stepPct = (x: number) => `${(Math.pow(1.0001, x) * 100 - 100).toFixed(1)}%`;
  const amountPresets = maxUsd && maxUsd > 0 ? [0.25, 0.5, 1].map((f) => ({ label: f === 1 ? t.lpsAll : `${f * 100}%`, v: maxUsd * f })) : [50, 100, 300].map((v) => ({ label: `$${v}`, v }));

  return (
    <section className="lps" aria-label={t.lpOpen}>
      <header className="lps-head">
        <div className="lps-title">
          <b>{t.lpOpen}</b>
          <div className="coin-switch" role="tablist" aria-label={t.stratAsset}>
            {(['HSK', 'ETH', 'BTC'] as Asset[]).map((a) => <button key={a} role="tab" aria-selected={a === plan.asset} className={a === plan.asset ? 'on' : ''} onClick={() => onAsset(a)}>{POOLS[a].symbol}/USDT</button>)}
          </div>
          <span className="lps-pool">HSKSwap · 0.3% · {price !== undefined ? t.prNow(`$${fmtPrice(price)}`) : '—'}</span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t.lpClose} data-tip={t.lpClose}><Icon name="close" size={18} /></button>
      </header>

      <div className="lps-chartbox">{chart(zones)}</div>

      <div className="lps-body">
        <ol className="lps-steps">
          <li className={`lps-step${goal ? ' done' : ' now'}`}>
            <span className="lps-n">1</span>
            <div className="lps-q">
              <b>{t.lpsQ1}</b>
              <div className="lps-goals" role="radiogroup" aria-label={t.lpsQ1}>
                {(['buy', 'sell', 'both'] as Goal[]).map((g) => (
                  <button key={g} role="radio" aria-checked={goal === g} className={`lps-goal g-${g}${goal === g ? ' on' : ''}`} onClick={() => pickGoal(g)}>
                    <b>{t.lpsGoal[g][0]}</b><small>{t.lpsGoal[g][1](p.symbol)}</small>
                  </button>
                ))}
              </div>
            </div>
          </li>
          {goal && (
            <li className={`lps-step${total > 0 ? ' done' : ' now'}`}>
              <span className="lps-n">2</span>
              <div className="lps-q">
                <b>{t.lpsQ2}</b>
                <div className="lps-amount">
                  <div className="lps-chips">{amountPresets.map((x) => <button key={x.label} className={Math.abs(total - x.v) < 0.01 ? 'on' : ''} onClick={() => setTotal(x.v)}>{x.label}</button>)}</div>
                  <label className="lps-usd"><span>$</span><input inputMode="decimal" value={total ? String(round2(total)) : ''} placeholder="0" onChange={(e) => setTotal(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} /></label>
                </div>
                <small className="lps-hint">
                  {wallet ? t.lpsWallet(qty(wallet.usdt), qty(wallet.coin), p.symbol) : t.lpNeedLogin}
                  {goal === 'both' && total > 0 && price ? ` · ${t.lpsBothSplit(qty(plan.usdt), qty(plan.coin), p.symbol)}` : ''}
                  {goal === 'sell' && total > 0 ? ` · ${qty(plan.coin)} ${p.symbol}` : ''}
                </small>
              </div>
            </li>
          )}
          {goal && total > 0 && (
            <li className={`lps-step${plan.reachPct !== undefined ? ' done' : ' now'}`}>
              <span className="lps-n">3</span>
              <div className="lps-q">
                <b>{goal === 'sell' ? t.lpsQ3Up : t.lpsQ3Down}</b>
                <div className="lps-chips wrap">
                  {presets.map((x) => <button key={x.key} className={plan.reachPct !== undefined && Math.abs(plan.reachPct - x.pct) < 0.01 ? 'on' : ''} onClick={() => pickReach(x.pct)}>{x.label}<em>{goal === 'sell' ? '+' : '−'}{x.pct.toFixed(1)}%</em></button>)}
                  <span className="lps-own"><span>$</span><input inputMode="decimal" placeholder={t.lpsOwnPrice} value={own} onChange={(e) => setOwn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') pickOwn(); }} /><button onClick={pickOwn}>{t.lpsSet}</button></span>
                </div>
              </div>
            </li>
          )}
        </ol>

        <div className="lps-result">
          {!ready ? <p className="lps-wait-say">{t.lpsWaiting}</p> : (
            <>
              <div className="lps-cols mini" style={{ '--side': plan.perSide } as React.CSSProperties}>
                {bins.map((b, i) => {
                  const filled = heights[i] > 0 ? Math.max(1, Math.round((heights[i] / maxH) * ROWS)) : 0;
                  const tip = `$${fmtPrice(at(b.lower))} – $${fmtPrice(at(b.upper))}${b.amount > 0 ? ` · ${b.side === 'usdt' ? `${qty(b.amount)} USDT` : `${qty(b.amount)} ${p.symbol}`}` : ''}`;
                  const col = <button key={i} className={`lps-col pr-${b.side}`} onClick={() => nudge(i, 1)} onContextMenu={(e) => { e.preventDefault(); nudge(i, -1); }} data-tip={tip} aria-label={tip}>{Array.from({ length: ROWS }, (_, r) => <i key={r} className={r >= ROWS - filled ? 'on' : ''} />)}</button>;
                  return i === plan.perSide ? [<span key="mid" className="lps-mid" aria-hidden />, col] : col;
                })}
              </div>
              <ul className="lps-say">
                {buy && <li><i className="pr-usdt" aria-hidden />{t.lpsResBuy(`$${fmtPrice(at(buy.halfTick))}`, usdtText(buy.halfAmount), `$${fmtPrice(at(buy.fullTick))}`, usdtText(buy.total), p.symbol)}</li>}
                {sell && <li><i className="pr-coin" aria-hidden />{t.lpsResSell(`$${fmtPrice(at(sell.halfTick))}`, `$${fmtPrice(at(sell.fullTick))}`, qty(sell.total), p.symbol)}</li>}
                <li className="muted">{t.lpsResAfter}</li>
                {depth && buy && <li className="muted">{t.lpDepth(t.lpDown, usd(depth.down[0]), usd(depth.down[1]))}</li>}
              </ul>
            </>
          )}
          <div className="lps-go">
            {!s ? <p className="lps-note">{t.lpNeedLogin}</p> : short ? <p className="lps-note warn">{t.lpNoBal(short)}</p> : null}
            <button className="btn-primary lps-supply" disabled={!s || !m?.count || !!short || phase.k === 'busy'} onClick={() => void supply()}>
              {phase.k === 'busy' ? <><span className="spin" aria-hidden />{phase.step}</> : ready ? t.lpsSupplyGo : t.lpSupply}
            </button>
            {phase.k === 'done' && <p className="lps-note ok">{t.lpDone} <a href={`${explorer}/tx/${phase.tx}`} target="_blank" rel="noreferrer">{t.viewTx} ↗</a></p>}
            {phase.k === 'failed' && <p className="lps-note warn">{t.lpFailed(phase.why)}</p>}
          </div>

          <details className="lps-adv">
            <summary>{t.lpsAdvanced}</summary>
            <div className="lps-row">
              <span className="lps-label">{t.lpShape}</span>
              <div className="seg lps-seg" role="group" aria-label={t.lpShape}>
                {(['spot', 'curve', 'bidask', 'custom'] as Shape[]).map((x) => <button key={x} className={plan.shape === x ? 'on' : ''} aria-pressed={plan.shape === x} onClick={() => setPlan({ ...plan, shape: x, weights: x === 'custom' ? plan.weights ?? bins.map(() => 5) : plan.weights })}>{t.lpShapes[x]}</button>)}
              </div>
            </div>
            <div className="lps-row">
              <span className="lps-label">{t.lpStep}</span>
              <div className="seg lps-seg" role="group" aria-label={t.lpStep}>
                {[SPACING, SPACING * 2, SPACING * 4].map((x) => <button key={x} className={B === x ? 'on' : ''} aria-pressed={B === x} onClick={() => setPlan({ ...plan, step: x })}>{stepPct(x)}</button>)}
              </div>
              <span className="lps-label">{t.lpPerSide}</span>
              <div className="seg lps-seg" role="group" aria-label={t.lpPerSide}>
                {[5, 10, 15, 20].map((x) => <button key={x} className={plan.perSide === x ? 'on' : ''} aria-pressed={plan.perSide === x} onClick={() => setPlan({ ...plan, perSide: x, weights: undefined, shape: plan.shape === 'custom' ? 'spot' : plan.shape })}>{x}</button>)}
              </div>
            </div>
            <p className="lps-note">{t.lpGap(stepPct(B))} {t.lpHintClick}.</p>
          </details>

          {s && (
            <div className="lps-mine">
              <b>{t.lpMine}</b>
              {mine === null ? <span className="muted">…</span> : !mine.length ? <span className="muted">{t.lpNone}</span> : (
                <>
                  <span>{t.lpMineSum(mine.length, usd(mineValue))} · {t.lpFeesNow(usd(mineFees))}</span>
                  <span className="lps-range">${fmtPrice(at(mine[0].lower))} – ${fmtPrice(at(mine[mine.length - 1].upper))}</span>
                  <div className="lps-mine-act">
                    <button className="btn sm" disabled={phase.k === 'busy' || mineFees <= 0} onClick={() => void act('collect')}>{t.lpCollect}</button>
                    <button className={`btn sm${sure ? ' danger' : ''}`} disabled={phase.k === 'busy'} onClick={() => void act('remove')}>{sure ? t.lpRemoveSure : t.lpRemove}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
