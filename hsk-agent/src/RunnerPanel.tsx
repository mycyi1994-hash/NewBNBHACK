// "Is the server's auto runner alive?" — when it last looked, when it looks next, and what each of my agents on
// auto decided at that look and why, with any error in plain words. The runner part is public; the agents part is
// only answered for the wallet that logged in. Read from /api/auto/status every 30 seconds.
import { useEffect, useState } from 'react';
import { useT, type Strings } from './i18n.ts';
import { authHeaders, useSession } from './account.ts';
import { Icon } from './Icons.tsx';
import type { HiredAgent, Signal, SkipWhy } from './runner.ts';
import { hiredName, money, skipText } from './hiredText.ts';
import { EXPLORER } from './vaultRead.ts';

type Check =
  | { at: number; k: 'paused'; why?: 'moved' }
  | { at: number; k: 'vaultPaused' | 'noRule' }
  | { at: number; k: 'noSignal'; error: string }
  | { at: number; k: 'idle'; signal: Signal }
  | { at: number; k: 'skip'; signal: Signal; why: SkipWhy }
  | { at: number; k: 'order'; signal: Signal; side: 'buy' | 'sell'; amount: number; ok: boolean; tx?: string; error?: string };
export interface RunnerStatus {
  now: number;
  /** lastPassAt: when the last finished check began; lastPassMs: how long it took; runningSince: a check is under way. */
  runner: { on: true; every: number; startedAt: number; passes: number; lastPassAt: number | null; lastPassMs?: number | null; runningSince?: number | null; nextAt: number | null; error: string | null } | { on: false; why: 'demo' | 'starting' };
  owner?: { lastLookAt: number | null; error: string | null };
  /** `why`: the server paused it and says why ('moved' = the wallet moved to a new vault). */
  agents?: { id: string; paused: boolean; why?: 'moved'; check: Check | null }[];
}

export async function loadRunnerStatus(owner?: string): Promise<RunnerStatus> {
  const r = await fetch(`/api/auto/status${owner ? `?owner=${owner}` : ''}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as RunnerStatus;
}

/** A refusal from the vault or the chain, in words a person can act on. */
export function plainError(t: Strings, e: string): string {
  if (/DailyCap|daily/i.test(e)) return t.rnErrDaily;
  if (/TradeCap|per.?trade|TooLarge/i.test(e)) return t.rnErrTrade;
  if (/Paused/i.test(e)) return t.rnErrPaused;
  if (/slippage|TooLittle|minOut|price moved|Price/i.test(e)) return t.rnErrPrice;
  if (/insufficient|balance|exceeds/i.test(e)) return t.rnErrFunds;
  if (/timed? ?out|fetch|network|ECONN|not readable|HTTP 5/i.test(e)) return t.rnErrNet;
  return e.length > 120 ? `${e.slice(0, 117)}…` : e;
}
const signalText = (t: Strings, s: Signal) => (s.kind === 'position' ? (s.live ? t.rnSigOn : t.rnSigOff) : s.kind === 'collect' ? (s.mult > 0 ? t.rnSigBuyDay(String(Math.round(s.mult * 100) / 100)) : t.rnSigRest) : s.price !== undefined ? t.rnSigPrice(money(s.price)) : t.rnSigNone);
export function checkText(t: Strings, c: Check): { text: string; bad?: boolean; tx?: string } {
  switch (c.k) {
    case 'paused': return { text: c.why === 'moved' ? t.rnMoved : t.rnPaused };
    case 'vaultPaused': return { text: t.rnVaultPaused };
    case 'noRule': return { text: t.rnNoRule, bad: true };
    case 'noSignal': return { text: t.rnNoSignal(plainError(t, c.error)), bad: true };
    case 'idle': return { text: `${signalText(t, c.signal)} · ${t.rnIdle}` };
    case 'skip': return { text: `${signalText(t, c.signal)} · ${t.rnSkipped(skipText(t, c.why))}` };
    case 'order': return c.ok ? { text: t.rnSent(c.side === 'buy' ? t.buy : t.sell, c.side === 'buy' ? `$${money(c.amount)}` : String(c.amount)), tx: c.tx } : { text: t.rnRefused(c.side === 'buy' ? t.buy : t.sell, plainError(t, c.error ?? '')), bad: true };
  }
}

const ago = (t: Strings, ms: number) => { const m = Math.round(ms / 60_000); return m < 1 ? t.agoNow : m < 60 ? t.agoMin(m) : t.agoHour(Math.round(m / 60)); };
const inTime = (t: Strings, ms: number) => { const m = Math.max(0, Math.round(ms / 60_000)); return m < 1 ? t.rnSoon : t.rnInMin(m); };

/** On My agents (the logged-in wallet) or the vault view (`owner` = the vault's owner; agents only if that is me). */
export default function RunnerPanel({ hired, owner, compact }: { hired: HiredAgent[]; owner?: string; compact?: boolean }) {
  const { t } = useT();
  const me = useSession();
  const [s, setS] = useState<RunnerStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => loadRunnerStatus(owner).then((x) => { if (alive) { setS(x); setFailed(false); } }, () => alive && setFailed(true));
    load();
    const a = setInterval(load, 30_000), b = setInterval(() => setTick(Date.now()), 10_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, [owner, me?.address]);
  const name = (id: string) => { const h = hired.find((x) => x.id === id); return h ? hiredName(t, h) : t.rnAgent; };
  const r = s?.runner;
  const skew = s ? Date.now() - s.now : 0;   // the server's clock, as seen from here
  const at = (v: number) => tick - skew - v;
  const state = failed ? 'off' : !r ? 'wait' : !r.on ? 'off' : r.error || s?.owner?.error ? 'bad' : 'on';
  return (
    <section className={`rnr${compact ? ' compact' : ''}`} aria-label={t.rnTitle}>
      <header className="rnr-head">
        <span className="rnr-ic" aria-hidden><Icon name="bot" size={18} /></span>
        <b>{t.rnTitle}</b>
        <span className={`st-pill ${state === 'on' ? 'on' : state === 'bad' ? 'ask' : 'off'}`}><i aria-hidden />{failed ? t.rnUnknown : !r ? '…' : !r.on ? (r.why === 'demo' ? t.rnDemo : t.rnStarting) : state === 'bad' ? t.rnTrouble : t.rnAlive}</span>
        {r?.on && <span className="rnr-when">{r.lastPassAt ? t.rnLast(ago(t, at(r.lastPassAt))) : t.rnFirst}{r.nextAt ? ` · ${t.rnNext(inTime(t, r.nextAt - (tick - skew)))}` : ''} · {t.rnEvery(Math.round(r.every / 60_000))}</span>}
      </header>
      {failed && <p className="rnr-line bad">{t.rnNoAnswer}</p>}
      {r && !r.on && <p className="rnr-line">{r.why === 'demo' ? t.rnDemoLine : t.rnStartingLine}</p>}
      {r?.on && r.error && <p className="rnr-line bad">{t.rnPassError(plainError(t, r.error))}</p>}
      {s?.owner?.error && <p className="rnr-line bad">{s.owner.error === 'no vault' ? t.rnNoVault : t.rnVaultError(plainError(t, s.owner.error))}</p>}
      {s?.agents && (s.agents.length ? (
        <ul className="rnr-agents">
          {s.agents.map((a) => {
            // Paused for the move to a new vault: that is the line, whatever its last look was.
            const c = a.paused && a.why === 'moved' ? { text: t.rnMoved } as ReturnType<typeof checkText> : a.check ? checkText(t, a.check) : null;
            return (
              <li key={a.id} className={c?.bad ? 'bad' : ''}>
                <b>{name(a.id)}</b>
                <span>{c ? c.text : t.rnNotYet}{c?.tx && <> · <a href={`${EXPLORER}/tx/${c.tx}`} target="_blank" rel="noreferrer">{t.viewTx} ↗</a></>}</span>
                {a.check && <time>{ago(t, at(a.check.at))}</time>}
              </li>
            );
          })}
        </ul>
      ) : <p className="rnr-line">{t.rnNoAuto}</p>)}
      {r?.on && !s?.agents && owner && <p className="rnr-line muted">{t.rnOwnerOnly}</p>}
    </section>
  );
}
