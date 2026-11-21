// Moa panels shared by the trade screen and the chat.
import type { Quote } from './market.ts';
import { fmtPrice } from './market.ts';
import { useT } from './i18n.ts';

export interface VaultInfo { configured: boolean; vault?: string; usdtBalance?: string; remainingTodayUsdt?: string; maxTradeUsdt?: string; maxDailyUsdt?: string }

export function TrustCard({ vault }: { vault: VaultInfo | null }) {
  const { t } = useT();
  return (
    <div className="trust">
      <div className="trust-title"><span aria-hidden>🔒</span> {t.trustTitle}</div>
      <ul>
        <li>{t.trust1}</li>
        <li>{t.trust2}</li>
        <li>{vault?.configured ? t.trust3(vault.maxTradeUsdt ?? '?', vault.maxDailyUsdt ?? '?') : t.trust3none}</li>
      </ul>
    </div>
  );
}

export function MoaSees({ quotes }: { quotes: Quote[] }) {
  const { t } = useT();
  return (
    <>
      <div className="panel-label"><span className="live-dot" /> {t.seesTitle}</div>
      <div className="sees">
        {quotes.length === 0 && <div className="muted pad-sm">{t.readingChain}</div>}
        {quotes.map((q) => (
          <div key={q.asset} className="sees-row">
            <span className={`coin coin-${q.asset.toLowerCase()}`}>{q.asset}</span>
            <span className="sees-price">{q.pool !== undefined ? `$${fmtPrice(q.pool)}` : '—'}</span>
            {q.gap !== undefined && <span className={`gap ${Math.abs(q.gap) >= 0.006 ? 'gap-wide' : ''}`}>{q.gap > 0 ? '▲ +' : '▼ '}{(q.gap * 100).toFixed(2)}%</span>}
            <span className="sees-take muted">{q.gap === undefined ? '' : Math.abs(q.gap) < 0.003 ? t.seesInLine : q.gap > 0 ? t.seesPricey : t.seesCheap}</span>
          </div>
        ))}
      </div>
      <p className="muted small">{t.seesNote}</p>
    </>
  );
}
