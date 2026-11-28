// Moa AI as the first row of the list under the chart: its mark, one line, the share it holds now, and Hire.
// It reads the same feed as the market's card and opens the same decision log (AiPanel.tsx). It has no past
// results, and the row says so.
import { useEffect, useState, type CSSProperties } from 'react';
import { AiBadge, AiLog, useAiFeeds } from './AiPanel.tsx';
import { aiAgent, aiFeed, COINS } from './aiPilot.ts';
import { Face } from './AgentCard.tsx';
import type { Agent } from './agents.ts';
import type { Asset } from './intent.ts';
import { markColor } from './Mark.tsx';
import { useT } from './i18n.ts';

export function AiRow({ coin, onHire }: { coin: string; onHire: (a: Agent) => void }) {
  const { t } = useT();
  const feeds = useAiFeeds();
  const [open, setOpen] = useState(false);
  if (!(COINS as string[]).includes(coin)) return null;
  const f = feeds?.[coin as Asset];
  if (feeds && !f) return null;   // this server does not serve Moa AI for the coin
  const off = !!f && f.state !== 'on';
  // The share in force: the last decision's, once the model has decided at least once.
  const now = f && !off && f.decisions.some((d) => !d.held) ? f.decisions[f.decisions.length - 1].target : undefined;
  return (
    <div className="tk-ai" style={{ '--fam': markColor('aiPilot') } as CSSProperties}>
      <div className="ar-row ai">
        <button className="ar-open" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!f}>
          <Face rule="aiPilot" base={coin} size="md" />
          <span className="ar-main">
            <b>{t.agNick.aiPilot}<AiBadge sm /></b>
            <small>{f?.state === 'noKey' ? t.aiNoKey : f?.state === 'off' ? t.aiOff : `${t.tkAiSub} · ${t.tkAiNoPast}`}</small>
          </span>
          <span className="ar-num">{!f ? <span className="skel ar-skel" /> : now !== undefined && <>{Math.round(now * 100)}%<span className="pf-vs even">{t.aiNow}</span></>}</span>
        </button>
        <button className="btn-primary sm tk-hire" onClick={() => f && onHire(aiAgent(f))} disabled={!f || off}>{t.acHire}</button>
      </div>
      {open && f && <AiLog f={f} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Whether a coin's Moa AI is deciding on this server, asked once per coin per page. */
const deciding = new Map<string, Promise<boolean>>();
const isDeciding = (coin: string) => {
  if (!(COINS as string[]).includes(coin)) return Promise.resolve(false);
  if (!deciding.has(coin)) deciding.set(coin, aiFeed(coin as Asset).then((f) => f.state === 'on', () => false));
  return deciding.get(coin)!;
};
/** Under Moa's pick in the chat: one quiet line that the coin's Moa AI also exists. Nothing while it is off. */
export function AiAlso({ coin, onOpen }: { coin: string; onOpen: () => void }) {
  const { t } = useT();
  const [on, setOn] = useState(false);
  useEffect(() => { let alive = true; void isDeciding(coin).then((v) => { if (alive) setOn(v); }); return () => { alive = false; }; }, [coin]);
  return on ? <button type="button" className="acard-ai" onClick={onOpen}>{t.tkAiAlso} →</button> : null;
}
