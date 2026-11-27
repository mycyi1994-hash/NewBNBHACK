// "Liquidity strategy": the HSKSwap screen given over to placing liquidity in blocks. The plan is edited here (shape,
// step width, amounts, single steps by clicking) and by talking to Moa on the right; both change the same plan.
// Supplying is the user's own wallet: exact approvals, then every step in one transaction to HSKSwap's position manager.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from './i18n.ts';
import type { Asset } from './intent.ts';
import { POOLS, poolState } from './dex.ts';
import { poolDepth, type PoolState } from './depth.ts';
import { chainCall, sendTx, useSession } from './account.ts';
import type { VaultInfo } from './parts.tsx';
import { Icon } from './Icons.tsx';
import { NANO_REFRESH_MS } from './nano.ts';
import { allowanceOf, approveCall, balanceOf, binsOf, collectCall, mintCall, positionsOf, priceAt, removeCall, shapeWeight, withPlan, USDT, NPM, SPACING, type LpPlan, type Position, type Shape } from './lp.ts';

const ROWS = 12;
const fmtPrice = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 1 ? v.toFixed(2) : v.toPrecision(4));
const usd = (v: number) => (v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(v >= 10 ? 0 : 2)}`);
const qty = (v: number) => (v === 0 ? '0' : v >= 1 ? Number(v.toFixed(4)).toString() : Number(v.toPrecision(4)).toString());
const toNum = (raw: bigint, d: number) => Number(raw) / 10 ** d;

type Phase = { k: 'idle' } | { k: 'busy'; step: string } | { k: 'done'; tx: string } | { k: 'failed'; why: string };

export default function LpStudio({ plan, setPlan, vault, onClose, onAsset }: {
  plan: LpPlan; setPlan: (p: LpPlan) => void; vault: VaultInfo | null; onClose: () => void; onAsset: (a: Asset) => void;
}) {
  const { t } = useT();
  const s = useSession();
  const p = POOLS[plan.asset];
  const [pool, setPool] = useState<PoolState | null>(null);
  const [wallet, setWallet] = useState<{ usdt: number; coin: number } | null>(null);
  const [mine, setMine] = useState<Position[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [sure, setSure] = useState(false);

  useEffect(() => {
    let alive = true;
    setPool(null);
    const pull = () => poolState(plan.asset).then((x) => { if (alive) setPool(x); }).catch(() => { /* keeps the last state */ });
    void pull();
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
  const valueOf = (b: (typeof bins)[number]) => (b.side === 'usdt' ? b.amount : b.amount * (price ?? 0));
  const funded = bins.some((b) => b.amount > 0);
  // Before any amount is set the editor shows the shape itself, so it is never empty.
  const heights = bins.map((b) => (funded ? valueOf(b) : b.weight));
  const maxH = Math.max(1e-12, ...heights);

  /** Clicking a step turns the plan into custom weights, starting from what the current shape draws. */
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

  const under = bins.filter((b) => b.side === 'usdt' && b.amount > 0), over = bins.filter((b) => b.side === 'coin' && b.amount > 0);
  const edge = (tick: number) => fmtPrice(priceAt(tick, p.decimals));
  const depth = useMemo(() => {
    if (!pool || !funded) return null;
    const a = poolDepth(pool), b = poolDepth(withPlan(pool, bins, p.decimals));
    const at = (d: typeof a, pct: number) => d.bands.find((x) => x.pct === pct)!.usdt;
    return { down: [at(a, -2), at(b, -2)], up: [at(a, 2), at(b, 2)] };
  }, [pool, bins, funded, p.decimals]);
  const poolPer = pool ? (pool.liquidity * (Math.pow(1.0001, pool.tick / 2) - Math.pow(1.0001, (pool.tick - B) / 2))) / 1e6 : 0;

  const short = wallet ? (plan.usdt > wallet.usdt + 1e-9 ? 'USDT' : plan.coin > wallet.coin + 1e-12 ? p.symbol : null) : null;
  const m = pool && s ? mintCall(p.token, bins, p.decimals, s.address, Math.floor(Date.now() / 1000) + 1200) : null;

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

      <div className="lps-body">
        <div className="lps-chart">
          <div className="lps-key">
            <span><i className="pr-usdt" aria-hidden />USDT · {t.lpBuySide}</span>
            <span><i className="pr-coin" aria-hidden />{p.symbol} · {t.lpSellSide}</span>
            <span className="muted">{funded ? t.lpHintClick : t.lpHintEmpty}</span>
          </div>
          <div className="lps-cols" style={{ '--side': plan.perSide } as React.CSSProperties}>
            {bins.map((b, i) => {
              const filled = heights[i] > 0 ? Math.max(1, Math.round((heights[i] / maxH) * ROWS)) : 0;
              const tip = `$${edge(b.lower)} – $${edge(b.upper)}${funded ? ` · ${b.side === 'usdt' ? `${qty(b.amount)} USDT` : `${qty(b.amount)} ${p.symbol} (${usd(valueOf(b))})`}` : ''}`;
              const col = (
                <button key={i} className={`lps-col pr-${b.side}${funded ? '' : ' ghost'}`} onClick={() => nudge(i, 1)} onContextMenu={(e) => { e.preventDefault(); nudge(i, -1); }} data-tip={tip} aria-label={tip}>
                  {Array.from({ length: ROWS }, (_, r) => <i key={r} className={r >= ROWS - filled ? 'on' : ''} />)}
                </button>
              );
              return i === plan.perSide ? [<span key="mid" className="lps-mid" aria-hidden><em>{price !== undefined ? `$${fmtPrice(price)}` : ''}</em></span>, col] : col;
            })}
            {!bins.length && <div className="lps-wait"><span className="spin" aria-hidden /></div>}
          </div>
          {bins.length > 0 && (
            <div className="lps-axis" aria-hidden>
              <span>${edge(bins[0].lower)}</span><span>${edge(bins[plan.perSide - 1].upper)}</span><span>${edge(bins[plan.perSide].lower)}</span><span>${edge(bins[bins.length - 1].upper)}</span>
            </div>
          )}
        </div>

        <div className="lps-side">
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
              {[5, 10, 15].map((x) => <button key={x} className={plan.perSide === x ? 'on' : ''} aria-pressed={plan.perSide === x} onClick={() => setPlan({ ...plan, perSide: x, weights: undefined, shape: plan.shape === 'custom' ? 'spot' : plan.shape })}>{x}</button>)}
            </div>
          </div>
          <label className="lps-amt">
            <span>{t.lpUsdtIn}{wallet && <small>{t.lpBal(qty(wallet.usdt))}<button type="button" onClick={() => setPlan({ ...plan, usdt: Math.floor(wallet.usdt * 100) / 100 })}>{t.lpMax}</button></small>}</span>
            <input inputMode="decimal" value={plan.usdt || ''} placeholder="0" onChange={(e) => setPlan({ ...plan, usdt: Math.max(0, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0) })} />
          </label>
          <label className="lps-amt">
            <span>{t.lpCoinIn(p.symbol)}{wallet && <small>{t.lpBal(qty(wallet.coin))}<button type="button" onClick={() => setPlan({ ...plan, coin: wallet.coin })}>{t.lpMax}</button></small>}</span>
            <input inputMode="decimal" value={plan.coin || ''} placeholder="0" onChange={(e) => setPlan({ ...plan, coin: Math.max(0, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0) })} />
          </label>

          <ul className="lps-say">
            {under.length > 0 && <li><i className="pr-usdt" aria-hidden />{t.lpUnder(qty(plan.usdt), edge(under[0].lower), edge(under[under.length - 1].upper), p.symbol)}</li>}
            {over.length > 0 && <li><i className="pr-coin" aria-hidden />{t.lpOver(qty(plan.coin), p.symbol, edge(over[0].lower), edge(over[over.length - 1].upper))}</li>}
            {funded && <li className="muted">{t.lpGap(stepPct(B))}</li>}
            {funded && <li className="muted">{t.lpFees}</li>}
            {depth && plan.usdt > 0 && <li>{t.lpDepth(t.lpDown, usd(depth.down[0]), usd(depth.down[1]))}</li>}
            {depth && plan.coin > 0 && <li>{t.lpDepth(t.lpUp, usd(depth.up[0]), usd(depth.up[1]))}</li>}
            {!funded && pool && <li className="muted">{t.lpPoolPer(usd(poolPer), stepPct(B))}</li>}
          </ul>

          <div className="lps-go">
            {!s ? <p className="lps-note">{t.lpNeedLogin}</p>
              : short ? <p className="lps-note warn">{t.lpNoBal(short)}</p> : null}
            <button className="btn-primary lps-supply" disabled={!s || !m?.count || !!short || phase.k === 'busy'} onClick={() => void supply()}>
              {phase.k === 'busy' ? <><span className="spin" aria-hidden />{phase.step}</> : m?.count ? t.lpSupplyN(m.count) : t.lpSupply}
            </button>
            {phase.k === 'done' && <p className="lps-note ok">{t.lpDone} <a href={`${explorer}/tx/${phase.tx}`} target="_blank" rel="noreferrer">{t.viewTx} ↗</a></p>}
            {phase.k === 'failed' && <p className="lps-note warn">{t.lpFailed(phase.why)}</p>}
          </div>

          {s && (
            <div className="lps-mine">
              <b>{t.lpMine}</b>
              {mine === null ? <span className="muted">…</span> : !mine.length ? <span className="muted">{t.lpNone}</span> : (
                <>
                  <span>{t.lpMineSum(mine.length, usd(mineValue))} · {t.lpFeesNow(usd(mineFees))}</span>
                  <span className="lps-range">${edge(mine[0].lower)} – ${edge(mine[mine.length - 1].upper)}</span>
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
