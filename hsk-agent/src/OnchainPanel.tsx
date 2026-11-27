// The on-chain watch under the HSK chart: the WHSK pool's own swaps and liquidity, read from HSK Chain by the server
// (src/onchain.ts, server/onchainStore.ts). A live reading, not a trading rule: nothing here can be hired.
import { useEffect, useState } from 'react';
import { useT } from './i18n.ts';
import { EXPLORER } from './dex.ts';
import { onchainView, type OnchainView } from './onchain.ts';

const usd = (v: number) => `$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${usd(v)}`;

export default function OnchainPanel() {
  const { t, lang } = useT();
  const [v, setV] = useState<OnchainView | null | 'loading' | 'error'>('loading');
  useEffect(() => {
    let alive = true;
    const load = () => onchainView('HSK').then((x) => alive && setV(x), () => alive && setV('error'));
    void load();
    const timer = setInterval(load, 2 * 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (v === 'loading') return <div className="ow"><div className="skel-block" style={{ height: 140, margin: 16 }} /></div>;
  if (v === 'error' || v === null) return <div className="ow"><p className="ow-none">{v === null ? t.owReading : t.owErr}</p></div>;

  const vol = v.day.buy + v.day.sell;
  const share = vol > 0 ? v.day.buy / vol : 0.5;
  const maxDay = Math.max(1, ...v.days.map((d) => Math.abs(d.net)));
  const readDays = Math.max(1, Math.round((v.at - v.since) / 86_400_000));
  const liqChange = v.liquidity?.dayAgo ? v.liquidity.now / v.liquidity.dayAgo - 1 : undefined;
  const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-GB', { month: 'numeric', day: 'numeric', timeZone: 'UTC' });

  return (
    <div className="ow">
      <section className="ow-now">
        <small><i className="ow-chain" aria-hidden />{t.owSource}</small>
        <b className={`ow-side ${v.side}`}>{t.owSide[v.side]}</b>
        <span className="ow-net">{t.owNet24}<em className={v.day.net > 0 ? 'pos' : v.day.net < 0 ? 'neg' : ''}>{signed(v.day.net)}</em></span>
        <div className="ow-bar" role="img" aria-label={t.owBuySell(usd(v.day.buy), usd(v.day.sell))}><i style={{ width: `${share * 100}%` }} /></div>
        <span className="ow-legend"><span><i className="b" />{t.owBuys} {usd(v.day.buy)}</span><span><i className="s" />{t.owSells} {usd(v.day.sell)}</span></span>
        <p className="ow-meta">{t.owSwaps(v.day.count)}{v.day.largest && <> · <a href={`${EXPLORER}/tx/${v.day.largest.tx}`} target="_blank" rel="noreferrer">{t.owLargest(usd(v.day.largest.usdt), v.day.largest.side === 'buy')} ↗</a></>}</p>
      </section>
      <section className="ow-days">
        <header><b>{t.owDaily}</b><small>{t.owRead(readDays)}</small></header>
        <div className="ow-cols" role="img" aria-label={t.owDaily}>
          {v.days.map((d) => (
            <span key={d.day} className="ow-col" data-tip={`${dayLabel(d.day)} · ${signed(d.net)} · ${t.owSwaps(d.count)}`}>
              <i className={d.net >= 0 ? 'up' : 'down'} style={{ height: `${(Math.abs(d.net) / maxDay) * 50}%` }} />
            </span>
          ))}
        </div>
        <p className="ow-meta">{t.owWeek(signed(v.week.net), v.week.count)}</p>
      </section>
      <section className="ow-liq">
        <small>{t.owLiq}</small>
        <b>{v.liquidity ? usd(v.liquidity.now) : '—'}</b>
        <span className="ow-meta">{liqChange === undefined ? t.owLiqBuilding : t.owLiqChange(`${liqChange >= 0 ? '+' : '−'}${Math.abs(liqChange * 100).toFixed(1)}%`)}</span>
        <p className="ow-note">{t.owNote(readDays)}</p>
      </section>
    </div>
  );
}
