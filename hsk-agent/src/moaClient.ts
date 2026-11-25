// Talking to Moa's server brain (/api/moa, NDJSON stream). Shared by the Ask Moa page and the
// Moa panel on the trade screen, so both get the same live progress steps, plans and trade receipts.
import type { Step } from './intent.ts';

export type StepKey = 'thinking' | 'market' | 'plan' | 'execute' | 'writing';
export interface Exec { ok: boolean; reason?: string; txHash?: string; explorerUrl?: string; amountIn?: string; amountOut?: string; tokenIn?: string; tokenOut?: string; request: { asset: string; side: string; amount: number } }
export interface ServerStep { kind: Step['kind']; asset?: 'HSK' | 'ETH' | 'BTC'; perBuyUsd?: number; every?: 'hour' | 'day' | 'week'; durationDays?: number; targetQty?: number; deadline?: string; maxPrice?: number; budgetUsd?: number; dropPct?: number; risePct?: number; sellFraction?: number; what?: 'idle USDT' | 'accumulated coins' }
export interface MoaResult { reply: string; plan?: { steps: ServerStep[]; missing: string[] }; executions: Exec[] }

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
export async function askMoa(history: { role: 'moa' | 'you'; text: string }[], onStep: (s: StepKey) => void, signal?: AbortSignal): Promise<MoaResult> {
  const r = await fetch('/api/moa', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ history: toApiHistory(history) }),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
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
