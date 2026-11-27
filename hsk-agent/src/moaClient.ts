// Talking to Moa's server brain (/api/moa, NDJSON stream) and sending a hired agent's approved order
// to the vault (/api/agent-trade).
import type { Step } from './intent.ts';
import { authHeaders } from './account.ts';

export type StepKey = 'thinking' | 'market' | 'plan' | 'agents' | 'execute' | 'writing';
export interface Exec { ok: boolean; reason?: string; txHash?: string; explorerUrl?: string; amountIn?: string; amountOut?: string; tokenIn?: string; tokenOut?: string; request: { asset: string; side: string; amount: number } }
export interface ServerStep { kind: Step['kind']; asset?: 'HSK' | 'ETH' | 'BTC'; perBuyUsd?: number; every?: 'hour' | 'day' | 'week'; durationDays?: number; targetQty?: number; deadline?: string; maxPrice?: number; budgetUsd?: number; dropPct?: number; risePct?: number; sellFraction?: number; what?: 'idle USDT' | 'accumulated coins' }
export interface MoaResult { reply: string; plan?: { steps: ServerStep[]; missing: string[] }; executions: Exec[]; recommend?: { agentId: string; coin: string }; lp?: { usdt?: number; coin?: number; shape?: 'spot' | 'curve' | 'bidask'; reachPct?: number; goal?: 'buy' | 'sell' | 'both'; step?: number; perSide?: number } }
/** What the server needs to know about the user that is not in the words: their level and the coin on screen. */
export interface MoaCtx { level?: 'new' | 'some' | 'pro' | null; asset?: string }

/** Same words the server checks before it lets Moa trade. */
export const EXECUTE_WORDS = /(실행|execute)/i;

/**
 * The API conversation must start with the user. When Moa opened the conversation (its notes),
 * fold those notes into the user's first message as quoted context instead of sending them as turns.
 */
export function toApiHistory(history: { role: 'moa' | 'you'; text: string }[]) {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  let lead: string[] = [];
  for (const m of history) {
    if (!out.length && m.role === 'moa') { lead.push(m.text); continue; }
    const content = lead.length && m.role === 'you' ? `(Moa said earlier: “${lead.join(' ')}”)\n\n${m.text}` : m.text;
    lead = [];
    out.push({ role: m.role === 'you' ? 'user' : 'assistant', content });
  }
  return out;
}

/** The server's plan has optional fields; fill in the shape the plan cards expect. */
export function toStep(s: ServerStep): Step {
  const asset = s.asset ?? 'HSK';
  switch (s.kind) {
    case 'accumulate': return { kind: 'accumulate', asset, perBuyUsd: s.perBuyUsd, every: s.every, durationDays: s.durationDays, targetQty: s.targetQty, deadline: s.deadline, maxPrice: s.maxPrice, budgetUsd: s.budgetUsd };
    case 'stopLoss': return { kind: 'stopLoss', asset, dropPct: s.dropPct ?? 0, sellFraction: s.sellFraction ?? 1 };
    case 'takeProfit': return { kind: 'takeProfit', asset, risePct: s.risePct ?? 0, sellFraction: s.sellFraction ?? 1 };
    default: return { kind: 'earn', what: s.what ?? 'idle USDT' };
  }
}

/** Ask Moa. Calls onStep for each progress step; resolves with the final result, rejects if the API is unreachable. */
/** The server sends a line every 5 seconds while it works. This long without one means the connection is dead. */
export const SILENCE_MS = 25_000;
/** No answer after this long: stop waiting, whatever the server says (six model calls would be the worst case). */
export const ANSWER_MS = 150_000;

export async function askMoa(history: { role: 'moa' | 'you'; text: string }[], onStep: (s: StepKey) => void, signal?: AbortSignal, context?: MoaCtx): Promise<MoaResult> {
  // Three ways out: the user stops it, the server goes quiet, or the whole answer takes too long.
  const watch = new AbortController();
  const stopOn = () => watch.abort();
  signal?.addEventListener('abort', stopOn);
  let quiet = setTimeout(stopOn, SILENCE_MS);
  const total = setTimeout(stopOn, ANSWER_MS);
  const heard = () => { clearTimeout(quiet); quiet = setTimeout(stopOn, SILENCE_MS); };
  try {
    return await readMoa(history, onStep, watch.signal, heard, context);
  } finally {
    clearTimeout(quiet); clearTimeout(total);
    signal?.removeEventListener('abort', stopOn);
  }
}

async function readMoa(history: { role: 'moa' | 'you'; text: string }[], onStep: (s: StepKey) => void, signal: AbortSignal, heard: () => void, context?: MoaCtx): Promise<MoaResult> {
  const r = await fetch('/api/moa', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ history: toApiHistory(history), context }),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    heard();
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line) as { type: string; step?: StepKey; error?: string; result?: MoaResult };
      if (ev.type === 'step' && ev.step) onStep(ev.step);
      else if (ev.type === 'error') throw new Error(ev.error);
      else if (ev.type === 'done' && ev.result) return ev.result;
    }
  }
  throw new Error('stream ended without a result');
}

export type TradeResult =
  | { ok: true; txHash: string; explorerUrl: string; amountIn: string; amountOut: string; tokenIn: string; tokenOut: string }
  | { ok: false; reason: string };

/** One approved order from a hired agent. buy: amount is USDT; sell: amount is the coin quantity. */
export async function sendAgentTrade(req: { asset: string; side: 'buy' | 'sell'; amount: number; note: string }): Promise<TradeResult> {
  try {
    const r = await fetch('/api/agent-trade', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(req) });
    const j = (await r.json().catch(() => null)) as TradeResult | { error?: string } | null;
    if (j && 'ok' in j) return j;
    return { ok: false, reason: (j && 'error' in j && j.error) || `Server answered HTTP ${r.status}.` };
  } catch (e) {
    return { ok: false, reason: `The server is not reachable (${e instanceof Error ? e.message : String(e)}).` };
  }
}

/* ---------- agents that work on their own (kept on the server) ---------- */
import type { HiredAgent } from './runner.ts';

const postAuto = (body: unknown) => fetch('/api/auto', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) });
/** The server's copy of this wallet's auto agents, or null when it cannot be read (logged out, server down). */
export async function autoList(): Promise<HiredAgent[] | null> {
  try {
    const r = await fetch('/api/auto', { headers: authHeaders() });
    if (!r.ok) return null;
    const j = (await r.json()) as { agents?: HiredAgent[] };
    return Array.isArray(j.agents) ? j.agents : null;
  } catch { return null; }
}
export type AutoPut = { ok: true; agent: HiredAgent } | { ok: false; why: 'noVault' | 'needLimit' | 'login' | 'failed' };
/** Put an agent on auto, or send its new amounts or pause. What it already did stays as the server has it. */
export async function autoPut(agent: HiredAgent): Promise<AutoPut> {
  try {
    const r = await postAuto({ agent });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; agent?: HiredAgent; why?: 'noVault' | 'needLimit' } | null;
    if (r.ok && j?.agent) return { ok: true, agent: j.agent };
    return { ok: false, why: r.status === 401 ? 'login' : j?.why ?? 'failed' };
  } catch { return { ok: false, why: 'failed' }; }
}
/** Take an agent off the server. Returns the server's last copy of it, with everything it did. */
export async function autoRemove(id: string): Promise<HiredAgent | null> {
  try { const r = await postAuto({ op: 'remove', id }); return r.ok ? ((await r.json()) as { agent?: HiredAgent | null }).agent ?? null : null; } catch { return null; }
}
