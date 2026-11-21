// Moa's brain: Claude Sonnet 5.5 with three tools (market data, plan proposal, trade execution).
// Execution is gated twice: the latest user message must explicitly ask to execute, and the vault contract
// enforces its own caps and slippage floor.
import Anthropic from '@anthropic-ai/sdk';
import { loadQuotes } from '../src/market.ts';
import * as cex from '../src/cex.ts';
import { executeTrade, vaultStatus, type ExecConfig, type TradeResult } from './executor.ts';

export const MODEL = 'claude-sonnet-5-5';
const EXECUTE_WORDS = /(실행|execute)/i;

export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface PlanStep {
  kind: 'accumulate' | 'stopLoss' | 'takeProfit' | 'earn';
  asset?: 'HSK' | 'ETH' | 'BTC';
  perBuyUsd?: number; every?: 'hour' | 'day' | 'week'; durationDays?: number;
  targetQty?: number; deadline?: string; maxPrice?: number; budgetUsd?: number;
  dropPct?: number; risePct?: number; sellFraction?: number; what?: 'idle USDT' | 'accumulated coins';
}
export interface MoaResult {
  reply: string;
  plan?: { steps: PlanStep[]; missing: string[] };
  executions: (TradeResult & { request: { asset: string; side: string; amount: number } })[];
  model: string;
}

const SYSTEM = `You are Moa, an AI money assistant on HSK Chain. Your personality: short, direct, a little cheeky, never reckless.
Users tell you a goal in plain language (English or Korean; always answer in the user's language). You turn it into a plan of steps:
collect (buy a little at a time on HSKSwap), protect (stop-loss), take profit, and earn (park idle USDT).

Rules:
- Never invent prices or numbers. Call get_market when you need current prices; quote only what it returns.
- When the user describes a goal, call propose_plan with structured steps. If something essential is missing (asset, amount, pace or deadline), ask one short question and put it in "missing".
- Trading venue is HSKSwap on HSK Chain (WHSK, WETH, WBTC against USDT). HashKey Global prices are reference only.
- Call execute_trade only when the user's latest message explicitly asks to execute (for example "실행" or "execute"), and only for the immediate trade the user asked for or the first buy of the approved plan. Never execute on your own initiative.
- Execution moves real funds through the user's MoaVault contract. If execute_trade returns an error, explain it plainly; do not retry with different numbers unless the user asks.
- After an execution, state the result in one or two sentences. Do not paste transaction hashes or links; the app shows a receipt card with the link.
- Keep replies under 90 words. No markdown headers.`;

const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_market',
    description: 'Live prices: HSKSwap pool prices on HSK Chain (HSK, ETH, BTC vs USDT) with the gap to Gate spot, the HashKey Global BTC/USDT perpetual, and the user vault status (limits, balance) if a vault is configured.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'propose_plan',
    description: 'Show the user a structured plan for their goal in the plan panel. Call this whenever the user states or changes a goal.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['accumulate', 'stopLoss', 'takeProfit', 'earn'] },
              asset: { type: 'string', enum: ['HSK', 'ETH', 'BTC'] },
              perBuyUsd: { type: 'number' }, every: { type: 'string', enum: ['hour', 'day', 'week'] }, durationDays: { type: 'number' },
              targetQty: { type: 'number' }, deadline: { type: 'string' }, maxPrice: { type: 'number' }, budgetUsd: { type: 'number' },
              dropPct: { type: 'number' }, risePct: { type: 'number' }, sellFraction: { type: 'number', description: '0 to 1' },
              what: { type: 'string', enum: ['idle USDT', 'accumulated coins'] },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
        missing: { type: 'array', items: { type: 'string' }, description: 'Questions the user must answer before the plan can run' },
      },
      required: ['steps', 'missing'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'execute_trade',
    description: 'Execute one swap now through the user MoaVault on HSKSwap. Only when the latest user message explicitly asks to execute. buy: amount is USDT to spend. sell: amount is the token quantity to sell.',
    input_schema: {
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['HSK', 'ETH', 'BTC'] },
        side: { type: 'string', enum: ['buy', 'sell'] },
        amount: { type: 'number' },
        note: { type: 'string', description: 'One short sentence: why this trade, stored on-chain' },
      },
      required: ['asset', 'side', 'amount', 'note'],
      additionalProperties: false,
    },
    strict: true,
  },
];

async function marketSnapshot(cfg: ExecConfig) {
  const [quotes, perp, vault] = await Promise.all([
    loadQuotes(),
    cex.ticker().then((t) => ({ last: t.last, change24hPct: +((t.last / t.open - 1) * 100).toFixed(2) })).catch((e: unknown) => ({ unavailable: String(e) })),
    vaultStatus(cfg).catch((e: unknown) => ({ configured: false, error: String(e) })),
  ]);
  return {
    hskswap: quotes.map((q) => ({ asset: q.asset, poolPriceUsd: q.pool ?? null, gateSpotUsd: q.exchange ?? null, gapPct: q.gap !== undefined ? +(q.gap * 100).toFixed(2) : null })),
    hashkeyGlobalBtcPerp: perp,
    vault,
    note: 'HSKSwap fee is 0.3% per swap.',
  };
}

export type MoaStep = 'thinking' | 'market' | 'plan' | 'execute' | 'writing';
export type MoaEvent = { type: 'step'; step: MoaStep; detail?: string };

export async function runMoa(apiKey: string, cfg: ExecConfig, history: ChatTurn[], onEvent: (e: MoaEvent) => void = () => {}): Promise<MoaResult> {
  const client = new Anthropic({ apiKey });
  const lastUser = [...history].reverse().find((t) => t.role === 'user')?.content ?? '';
  const executionAllowed = EXECUTE_WORDS.test(lastUser);
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((t) => ({ role: t.role, content: t.content }));
  const result: MoaResult = { reply: '', executions: [], model: MODEL };

  for (let i = 0; i < 6; i++) {
    onEvent({ type: 'step', step: i === 0 ? 'thinking' : 'writing' });
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'high' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      tools,
      messages,
    });
    result.model = response.model;
    if (response.stop_reason === 'refusal') {
      result.reply = 'I can’t help with that one.';
      return result;
    }
    messages.push({ role: 'assistant', content: response.content });
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) result.reply = text;
    if (response.stop_reason !== 'tool_use' || uses.length === 0) return result;

    const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      let content: string;
      let isError = false;
      try {
        if (u.name === 'get_market') {
          onEvent({ type: 'step', step: 'market' });
          content = JSON.stringify(await marketSnapshot(cfg));
        } else if (u.name === 'propose_plan') {
          onEvent({ type: 'step', step: 'plan' });
          const input = u.input as { steps: PlanStep[]; missing: string[] };
          result.plan = { steps: input.steps ?? [], missing: input.missing ?? [] };
          content = 'Plan shown to the user in the plan panel.';
        } else if (u.name === 'execute_trade') {
          const input = u.input as { asset: 'HSK' | 'ETH' | 'BTC'; side: 'buy' | 'sell'; amount: number; note: string };
          if (!executionAllowed) {
            isError = true;
            content = 'Refused by the server: the user has not explicitly asked to execute in their latest message. Ask them to confirm with "실행" or "execute".';
          } else if (result.executions.length > 0) {
            isError = true;
            content = 'Refused by the server: only one execution per user message.';
          } else {
            onEvent({ type: 'step', step: 'execute', detail: `${input.side} ${input.amount} ${input.side === 'buy' ? 'USDT of ' : ''}${input.asset}` });
            const r = await executeTrade(cfg, input);
            result.executions.push({ ...r, request: { asset: input.asset, side: input.side, amount: input.amount } });
            isError = !r.ok;
            content = JSON.stringify(r);
          }
        } else {
          isError = true;
          content = `Unknown tool ${u.name}`;
        }
      } catch (e) {
        isError = true;
        content = `Tool failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: u.id, content, is_error: isError });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  if (!result.reply) result.reply = 'I ran out of steps on that one. Try again?';
  return result;
}
