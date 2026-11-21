// Panels shared by the trade screen and the strategy screen.
import type { Quote } from './market.ts';
import { fmtPrice } from './market.ts';
import { useT } from './i18n.ts';

export interface VaultInfo { configured: boolean; vault?: string; explorerUrl?: string; localFork?: boolean; usdtBalance?: string; remainingTodayUsdt?: string; maxTradeUsdt?: string; maxDailyUsdt?: string }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Vault facts as key/value rows, like the balance block of an order form. */
export function VaultPanel({ vault }: { vault: VaultInfo | null }) {
  const { t } = useT();
  return (
    <section className="panel">
      <div className="panel-head"><span>{t.vaultTitle}</span>
        {vault?.configured ? <span className="status-dot on">{vault.localFork ? t.localFork : 'HSK Chain'}</span> : <span className="status-dot">{t.vaultNone}</span>}
      </div>
      {vault?.configured && vault.vault ? (
        <dl className="kv">
          <dt>{t.vaultContract}</dt>
          <dd>{vault.localFork ? <code>{short(vault.vault)}</code> : <a href={vault.explorerUrl} target="_blank" rel="noreferrer"><code>{short(vault.vault)}</code> ↗</a>}</dd>
          <dt>{t.balance}</dt><dd>{Number(vault.usdtBalance).toFixed(2)} USDT</dd>
          <dt>{t.perTrade}</dt><dd>${vault.maxTradeUsdt}</dd>
          <dt>{t.perDay}</dt><dd>${vault.maxDailyUsdt}</dd>
          <dt>{t.leftToday}</dt><dd>${vault.remainingTodayUsdt}</dd>
          <dt>{t.execution}</dt><dd>{t.execRule}</dd>
          <dt>{t.withdraw}</dt><dd>{t.ownerOnly}</dd>
        </dl>
      ) : (
        <dl className="kv">
          <dt>{t.execution}</dt><dd>{t.execRule}</dd>
          <dt>{t.withdraw}</dt><dd>{t.ownerOnly}</dd>
        </dl>
      )}
    </section>
  );
}

/** HSKSwap pool price against spot, numbers only. */
export function SpreadTable({ quotes }: { quotes: Quote[] }) {
  const { t } = useT();
  return (
    <section className="panel">
      <div className="panel-head"><span>{t.spreadTitle}</span><span className="status-dot on">{t.live}</span></div>
      <table className="grid-table">
        <thead><tr><th>{t.colAsset}</th><th className="r">{t.colPool}</th><th className="r">{t.colGap}</th></tr></thead>
        <tbody>
          {quotes.length === 0 && <tr><td colSpan={3} className="muted">{t.readingChain}</td></tr>}
          {quotes.map((q) => (
            <tr key={q.asset}>
              <td><span className={`coin coin-${q.asset.toLowerCase()}`} />{q.asset}</td>
              <td className="r">{q.pool !== undefined ? fmtPrice(q.pool) : '—'}</td>
              <td className={`r ${q.gap === undefined ? '' : q.gap > 0 ? 'pos' : 'neg'}`}>{q.gap !== undefined ? `${q.gap > 0 ? '+' : ''}${(q.gap * 100).toFixed(2)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel-foot muted">{t.seesNote}</div>
    </section>
  );
}
