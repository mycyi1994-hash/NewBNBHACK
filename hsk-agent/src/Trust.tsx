// "How Moa makes money, and the risks": plain and short. The pool figures are read live from HSK Chain: the USDT in
// each pool and the order size from which a buy moves the price by more than 1%.
import { useEffect, useState } from 'react';
import { useT } from './i18n.ts';
import type { Asset } from './intent.ts';
import type { Quote } from './market.ts';
import { Icon } from './Icons.tsx';
import { poolDetail, poolState, POOLS } from './dex.ts';
import { poolDepth } from './depth.ts';
import { FACTORIES, EXPLORER } from './vaultRead.ts';

const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
interface PoolRow { asset: Asset; usdt?: number; onePct?: number; failed?: boolean }

export default function Trust({ quotes }: { quotes: Quote[] }) {
  const { t } = useT();
  const [pools, setPools] = useState<PoolRow[]>((['HSK', 'ETH', 'BTC'] as Asset[]).map((asset) => ({ asset })));
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all((['HSK', 'ETH', 'BTC'] as Asset[]).map(async (asset): Promise<PoolRow> => {
      try {
        const [d, s] = await Promise.all([poolDetail(asset, 0), poolState(asset)]);
        return { asset, usdt: d.reserveUsdt, onePct: poolDepth(s).bands.find((b) => b.pct === 1)?.usdt };
      } catch { return { asset, failed: true }; }
    })).then((rows) => { if (alive) { setPools(rows); setAt(Date.now()); } });
    return () => { alive = false; };
  }, []);
  const gaps = quotes.filter((q) => q.gap !== undefined);
  // The factory's platform fee: shown only when it is not 0 (it is 0 unless the factory's guardian sets one).
  const [platformBps, setPlatformBps] = useState(0);
  useEffect(() => { fetch('/api/terms').then((r) => r.json()).then((j: { platformFeeBps?: number }) => setPlatformBps(Number(j.platformFeeBps) || 0), () => undefined); }, []);
  return (
    <div className="page trust-page">
      <header className="page-head"><h1>{t.trTitle}</h1></header>
      <p className="page-sub">{t.trSub}</p>

      <section className="tr-card">
        <h2><Icon name="coin" size={18} />{t.trMoneyH}</h2>
        <ul className="tr-list">{t.trMoney.map((x) => <li key={x}>{x}</li>)}</ul>
        {platformBps > 0 && <p className="tr-fee">{t.trPlatformFee(`${Number((platformBps / 100).toFixed(2))}%`)}</p>}
      </section>

      <section className="tr-card">
        <h2><Icon name="shield" size={18} />{t.trCustodyH}</h2>
        <ul className="tr-list">{t.trCustody.map((x) => <li key={x}>{x}</li>)}</ul>
        <p className="tr-links">
          <a href="?vault">{t.trSeeVaults} →</a>
          <a href={`${EXPLORER}/address/${FACTORIES[0].address}`} target="_blank" rel="noreferrer">{t.trSource} ↗</a>
        </p>
      </section>

      <section className="tr-card risk">
        <h2><Icon name="info" size={18} />{t.trRiskH}</h2>
        <ul className="tr-list">{t.trRisk.map((x) => <li key={x}>{x}</li>)}</ul>
        <div className="tr-pools">
          <div className="tr-pool head"><span>{t.trPool}</span><span>{t.trPoolUsdt}</span><span>{t.trPool1pct}</span></div>
          {pools.map((p) => (
            <div key={p.asset} className="tr-pool">
              <span><b>{POOLS[p.asset].symbol}/USDT</b></span>
              <span>{p.failed ? '—' : p.usdt === undefined ? <i className="skel" style={{ width: 70 }} /> : usd(p.usdt)}</span>
              <span><span className="tr-k">{t.trPool1pct}: </span>{p.failed ? '—' : p.onePct === undefined ? <i className="skel" style={{ width: 60 }} /> : t.trOver(usd(p.onePct))}</span>
            </div>
          ))}
          <p className="tr-note">{at ? t.trPoolNote(new Date(at).toLocaleTimeString(document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' })) : t.trPoolWait}</p>
        </div>
        {gaps.length > 0 && <p className="tr-gap">{t.trGap(gaps.map((q) => `${q.asset} ${q.gap! >= 0 ? '+' : '−'}${Math.abs(q.gap! * 100).toFixed(2)}%`).join(' · '))}</p>}
      </section>

      <p className="muted small">{t.trNotAdvice}</p>
    </div>
  );
}
