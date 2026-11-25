// Moa's brain: Claude Sonnet 5.5 with four tools (market data, plan proposal, agent recommendation, trade execution).
// The recommendation is the app's fixed rule (src/recommend.ts); the model only says which coin the user means.
// Execution is gated twice: the latest user message must explicitly ask to execute, and the vault contract
// enforces its own caps and slippage floor.
import Anthropic from '@anthropic-ai/sdk';
import { loadQuotes } from '../src/market.ts';
import * as cex from '../src/cex.ts';
import { executeTrade, vaultStatus, type ExecConfig, type TradeResult } from './executor.ts';
import { loadAgents, type Agent } from '../src/agents.ts';
import { recommend, type Level } from '../src/recommend.ts';
import { STRINGS } from '../src/i18n.ts';

export const MODEL = 'claude-sonnet-5-5';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Default high (the product owner's choice); MOA_EFFORT overrides it for measurement. */
const EFFORT: Effort = (['low', 'medium', 'high', 'xhigh', 'max'] as const).find((e) => e === process.env.MOA_EFFORT) ?? 'high';
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
  /** Set when recommend_agent ran: the app shows this agent's card under the reply. */
  recommend?: { agentId: string; coin: string };
}
export interface MoaContext { level?: Level | null; asset?: string }

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
- The app has an agent market: agents that each follow one fixed rule on one coin. When the user asks what to hire, which agent to use, or to have buying done for them, call recommend_agent with the coin they mean ("any" if none). The app picks by its own rule and shows the agent card with a Hire button under your reply. Describe the pick in one or two sentences using only the numbers the tool returns. You never hire agents, change amounts or pause agents yourself: hiring and amounts go through a sheet the user confirms, and every agent has a pause button in the bar at the top.
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
    name: 'recommend_agent',
    description: 'Show the user one agent to hire, picked by the app rule: only agents that can trade on HSKSwap, the coin asked about, the user risk level, then the smallest worst drop in the backtest. Returns the pick and three alternatives with their backtest numbers.',
    input_schema: {
      type: 'object',
      properties: { coin: { type: 'string', enum: ['HSK', 'ETH', 'BTC', 'SOL', 'XRP', 'BNB', 'DOGE', 'any'], description: 'The coin the user means; "any" when they did not name one' } },
      required: ['coin'],
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

export type MoaStep = 'thinking' | 'market' | 'plan' | 'agents' | 'execute' | 'writing';
export type MoaEvent = { type: 'step'; step: MoaStep; detail?: string };

const pctOf = (v: number) => +(v * 100).toFixed(1);
/** An agent as the model sees it: English name, rule, backtest numbers, state now. */
function forModel(a: Agent) {
  return {
    name: `${a.base} ${STRINGS.en.agRule[a.rule]}`, rule: STRINGS.en.agLine[a.rule], canHire: a.runnable,
    backtestDays: a.days, periodReturnPct: pctOf(a.total), justHoldingPct: pctOf(a.hold), worstDropPct: -pctOf(a.maxDd), feePerTradePct: pctOf(a.fee),
    now: a.kind === 'position' ? (a.live ? 'holding' : 'waiting for its signal') : a.mult > 0 ? `would buy x${a.mult} today` : 'skips today',
  };
}

export async function runMoa(apiKey: string, cfg: ExecConfig, history: ChatTurn[], onEvent: (e: MoaEvent) => void = () => {}, ctx: MoaContext = {}): Promise<MoaResult> {
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
      output_config: { effort: EFFORT },
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
        } else if (u.name === 'recommend_agent') {
          onEvent({ type: 'step', step: 'agents' });
          const coin = (u.input as { coin: string }).coin;
          const r = recommend(await loadAgents(), { coin: coin === 'any' ? ctx.asset : coin, level: ctx.level });
          if (!r) { isError = true; content = 'No agent can be scored right now: candles did not load.'; }
          else {
            result.recommend = { agentId: r.pick.id, coin };
            content = JSON.stringify({ shownToUser: true, scope: r.scope === 'coin' ? `agents for ${r.pick.base}` : 'all agents the vault can trade (none for the coin asked)', agentsCompared: r.pool, pick: forModel(r.pick), others: r.others.map(forModel) });
          }
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
