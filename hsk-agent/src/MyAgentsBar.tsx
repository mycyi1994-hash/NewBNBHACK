// "My agents" bar: one line at the top of every screen. Each hired agent is a chip with its state, its
// money line and one control. Pause works on its own, without Moa or the AI. Tapping a chip opens that
// agent's status card in Moa's conversation; a chip that needs an answer jumps to Moa's question.
import { useT } from './i18n.ts';
import type { Quote } from './market.ts';
import { statusOf, type HiredAgent } from './runner.ts';
import { hiredName, moneyLine, statusText } from './hiredText.ts';
import type { CSSProperties } from 'react';
import { isRunning, Mark } from './AgentLive.tsx';
import { agentColors, OTHER_COLOR } from './portfolio.ts';

export default function MyAgentsBar({ hired, quotes, now, sending, onOpen, onPause, onResume }: {
  hired: HiredAgent[]; quotes: Quote[]; now: number; sending: Set<string>;
  onOpen: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void;
}) {
  const { t } = useT();
  // Nothing hired: no bar. The market header and Moa carry "Get a pick from Moa".
  if (!hired.length) return null;
  const colors = agentColors(hired);
  return (
    <div className="agent-bar" role="region" aria-label={t.barLabel}>
      <span className="agent-bar-label">{t.barLabel}</span>
      {hired.map((h) => {
        const st = statusOf(h, now);
        const busy = !!h.pending && sending.has(h.pending.id);
        const m = moneyLine(t, h, quotes.find((q) => q.asset === h.asset)?.pool);
        return (
          <span key={h.id} className={`agent-chip st-${st}${isRunning(st) ? ' run' : ''}`} style={{ '--agent': colors.get(h.id) ?? OTHER_COLOR } as CSSProperties}>
            <button className="chip-main" onClick={() => onOpen(h.id)}>
              <span className={`chip-mark${isRunning(st) ? ' orbit' : ''}`}><Mark h={h} size="sm" /></span>
              <b>{hiredName(t, h)}</b>
              {h.mode === 'auto' && <svg className="chip-auto" viewBox="0 0 12 12" role="img" aria-label={t.autoBadge}><title>{t.autoBadge}</title><path d="M6.8 1 2.5 7h3l-.8 4L9.5 5h-3z" fill="currentColor" /></svg>}
              <span className="chip-st"><i className={`pf-dot ${st}`} aria-hidden />{busy ? t.stSending : statusText(t, h, now)}</span>
              <span className={`chip-pl ${h.fills.length ? m.cls : 'none'}`}>{m.text}</span>
            </button>
            {st === 'confirm'
              ? <button className="chip-ctl ask" onClick={() => onOpen(h.id)} disabled={busy}>{t.stReview}</button>
              : st === 'paused'
                ? <button className="chip-ctl" onClick={() => onResume(h.id)} aria-label={t.stResume} data-tip={t.stResume}>▶</button>
                : st !== 'done' && <button className="chip-ctl" onClick={() => onPause(h.id)} aria-label={t.stPause} data-tip={t.stPause}>Ⅱ</button>}
          </span>
        );
      })}
    </div>
  );
}
