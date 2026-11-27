// Moa's brain: Claude Sonnet 5.5 with its tools (market data, spreads, plan proposal, agent recommendation, liquidity plan, trade execution).
// The recommendation is the app's fixed rule (src/recommend.ts); the model only says which coin the user means.
// The model never executes a trade. It can only propose one (propose_trade): the app shows a card with a Confirm
// button carrying a single-use ticket the server signed for that wallet and that exact order (server/guard.ts), and
// only pressing it sends the order. The vault contract then enforces its own limits and price floor.
import Anthropic from '@anthropic-ai/sdk';
import { loadQuotes } from '../src/market.ts';
import * as cex from '../src/cex.ts';
import { poolState } from '../src/dex.ts';
import { poolDepth } from '../src/depth.ts';
import { nanoBrief, NANO_REFRESH_MS } from '../src/nano.ts';
import { ASSETS } from '../src/intent.ts';
import { vaultStatus, type ExecConfig, type TradeResult } from './executor.ts';
import { cleanOrder, type Order, type Ticket } from './guard.ts';
import { loadAgents, type Agent } from '../src/agents.ts';
import { recommend, type Level } from '../src/recommend.ts';
import { STRINGS } from '../src/i18n.ts';
import { LP_STRATEGIES, strategyPlan } from '../src/lpStrategies.ts';
import { spreadRead, gapHistory, gapStats, POOL_FEE, TAKER_FEE } from '../src/spread.ts';
import { onchainForModel, onchainView } from '../src/onchain.ts';

export const MODEL = 'claude-sonnet-5-5';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Default high (the product owner's choice); MOA_EFFORT overrides it for measurement. */
const EFFORT: Effort = (['low', 'medium', 'high', 'xhigh', 'max'] as const).find((e) => e === process.env.MOA_EFFORT) ?? 'high';

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
  /** Orders Moa proposed: each runs only if the user presses Confirm on its card (see server/guard.ts). */
  proposals: Ticket[];
  model: string;
  /** Set when recommend_agent ran: the app shows this agent's card under the reply. */
  recommend?: { agentId: string; coin: string };
  /** Set when set_lp_plan ran: the app applies it to the liquidity studio on screen. */
  lp?: { usdt?: number; coin?: number; shape?: 'spot' | 'curve' | 'spotCurve' | 'bidask'; reachPct?: number; goal?: 'buy' | 'sell' | 'both'; step?: number; perSide?: number; perSideUp?: number };
}
export interface MoaContext { level?: Level | null; asset?: string }

const SYSTEM = `You are Moa, an AI money assistant on HSK Chain. Your personality: short, direct, a little cheeky, never reckless.
Users tell you a goal in plain language (English or Korean; always answer in the user's language). You turn it into a plan of steps:
collect (buy a little at a time on HSKSwap), protect (stop-loss), take profit, and earn (park idle USDT).

Rules:
- Never invent prices or numbers. Call get_market when you need current prices; quote only what it returns.
- When the user describes a goal, call propose_plan with structured steps. If something essential is missing (asset, amount, pace or deadline), ask one short question and put it in "missing".
- Trading venue is HSKSwap on HSK Chain (WHSK, WETH, WBTC against USDT). HashKey Global prices are reference only.
- You cannot execute trades. When the user clearly asks for a trade now (for example "buy $5 of ETH now"), call propose_trade once with exactly that order; the app shows it as a card with a Confirm button, and only the user's press sends it to their vault. Never propose on your own initiative, and never when the user says not to. Say in one sentence that it waits for their Confirm; never say it was executed.
- The app has an agent market: agents that each follow one fixed rule on one coin. When the user asks what to hire, which agent to use, or to have buying done for them, call recommend_agent with the coin they mean ("any" if none). The app picks by its own rule and shows the agent card with a Hire button under your reply. Describe the pick in one or two sentences using only the numbers the tool returns. You never hire agents, change amounts or pause agents yourself: hiring and amounts go through a sheet the user confirms, and every agent has a pause button in the bar at the top.
- When the conversation says the liquidity studio is open, the user is planning HSKSwap liquidity in steps: USDT in steps under the price (it buys the coin as the price comes down into them) and optionally the coin in steps over it (sold as the price goes up). Help them choose the USDT amount, the shape (spot = even; curve = most near the price, most fees while the price moves around it; spotCurve = half even, half curve; bidask = most at the far ends, buys most on a big fall) and how far under the price it reaches (reachPct, e.g. 3, 6, 12, 24). There are ready-made strategies (set_lp_plan's strategy): slowBuy (buy a little on every dip, 8% under the price), dipLadder (buy more the deeper it falls, 15%), crashCatcher (wide under the price for a big fall, 30%), takeProfit (sell a little on every rise, 15% over), rangeFees (both ways, packed near the price, 4%, most fees while the price moves sideways), wideGrid (both ways, even, 20%, set and leave). Do not quote past or expected returns. Call set_lp_plan with what they decided; it changes the plan on their screen. You never supply anything: they press Supply and sign in their wallet. Fees are 0.3% and only earned while the price trades inside a step; say so if they ask about returns, and do not promise any.
- Keep replies under 90 words. No markdown headers.`;

const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_market',
    description: 'Live prices: HSKSwap pool prices on HSK Chain (HSK, ETH, BTC vs USDT) with the gap to Gate spot, the HashKey Global BTC/USDT perpetual, and the vault of the logged-in user when there is one: its USDT, each coin it holds with what that cost and what it is worth now (holdings[].costUsdt, valueUsdt), the limits the owner set (a missing limit means none), the stop-loss (stopLossBps) and whether trading is locked (paused). Use it for questions about positions and profit or loss. It also returns poolDepth for each HSKSwap pool, read from the chain: how many USDT move the pool price by 1, 2 and 5 percent either way (usdtToMove) and how far a buy of 10, 100 or 1000 USDT moves it (buyMovesPricePct); use it when asked how big an order the pool can take or how thin it is. And hskOnchain: the on-chain flow of the HSK pool (buys and sells in USD over 24 hours and 7 days, which side leans, the largest swap) and its liquidity within 2% now and a day ago; it is a live reading, not a tested signal. And exchangeBook for BTC and ETH, from nanotradingclub (nine exchanges added together, not HSK Chain and not HashKey): the thickest stacks of resting orders within 8 percent under the price (buyWalls) and over it (sellWalls) with their size in USD and distance in percent, and forced liquidations in USD over the last hour and 24 hours, split into long and short positions closed. A field that is null or missing was not available: say so rather than guess.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'get_spread',
    description: 'The HSKSwap pool price against HashKey Global (Gate if HashKey Global does not answer) for HSK, ETH and BTC, with costs. vault: what the vault itself can do (it trades only on HSKSwap): buy cheaper there and sell back later, the round-trip cost, what is left if the pool rises to the exchange price, whether the record shows this pool closing a discount, and actionableNow. onlyWithAnExchangeAccount: the cross-venue net after the HSKSwap fee 0.3%, an assumed taker fee 0.1% and the pool price impact, which the vault cannot do. Use it for any question about arbitrage, spreads or the price gap. Say yes only for a coin with actionableNow true, and say plainly that the vault cannot sell on the exchange.',
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
    name: 'set_lp_plan',
    description: 'Change the liquidity plan in the open liquidity studio. Only when the conversation says the studio is open. Pass only what the user decided.',
    input_schema: {
      type: 'object',
      properties: {
        usdt: { type: 'number', description: 'USDT spread over the steps under the price' },
        coin: { type: 'number', description: 'Amount of the coin spread over the steps above the price (0 for none)' },
        shape: { type: 'string', enum: ['spot', 'curve', 'spotCurve', 'bidask'] },
        reachPct: { type: 'number', description: 'How far under (and over) the price the steps reach, in percent' },
        strategy: { type: 'string', enum: LP_STRATEGIES.map((x) => x.id), description: 'A ready-made strategy: sets the goal, shape and reach; amounts stay as they are' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'propose_trade',
    description: 'Propose one swap through the user MoaVault on HSKSwap. Nothing is sent: the app shows a Confirm button and only the user pressing it executes. Only when the user clearly asks for this trade now. buy: amount is USDT to spend. sell: amount is the token quantity to sell.',
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

/** Each pool's depth from the chain, read at most once every three minutes. A pool that cannot be read is left out. */
let depthKept: { at: number; value: unknown[] } | null = null;
async function poolDepths() {
  if (depthKept && Date.now() - depthKept.at < NANO_REFRESH_MS) return depthKept.value;
  const value = (await Promise.all(ASSETS.map(async (asset) => {
    try {
      const d = poolDepth(await poolState(asset));
      return {
        asset,
        usdtToMove: Object.fromEntries(d.bands.map((x) => [`${x.pct > 0 ? '+' : ''}${x.pct}%`, Math.round(x.usdt)])),
        buyMovesPricePct: Object.fromEntries(d.impact.map((x) => [`$${x.usd}`, +(x.pct * 100).toFixed(3)])),
      };
    } catch { return null; }
  }))).filter((x) => x !== null);
  if (value.length) depthKept = { at: Date.now(), value };
  return value;
}

export async function marketSnapshot(cfg: ExecConfig) {
  const [quotes, perp, vault, depth, book, chain] = await Promise.all([
    loadQuotes(),
    cex.ticker().then((t) => ({ last: t.last, change24hPct: +((t.last / t.open - 1) * 100).toFixed(2) })).catch((e: unknown) => ({ unavailable: String(e) })),
    vaultStatus(cfg).catch((e: unknown) => ({ configured: false, error: String(e) })),
    poolDepths(),
    Promise.all((['BTC', 'ETH'] as const).map((c) => nanoBrief(c).catch(() => null))),
    onchainView('HSK').catch(() => null),
  ]);
  return {
    hskswap: quotes.map((q) => ({ asset: q.asset, poolPriceUsd: q.pool ?? null, gateSpotUsd: q.exchange ?? null, gapPct: q.gap !== undefined ? +(q.gap * 100).toFixed(2) : null })),
    hashkeyGlobalBtcPerp: perp,
    vault,
    poolDepth: depth,
    hskOnchain: onchainForModel(chain),
    exchangeBook: { source: 'nanotradingclub: nine exchanges added together (Binance, Bybit, Hyperliquid, Gate, Bitfinex, Upbit, Bithumb; futures and spot)', coins: book.filter((x) => x !== null) },
    note: 'HSKSwap fee is 0.3% per swap.',
  };
}

/** Every coin's spread now and its last day of recorded gaps, for the get_spread tool. */
export async function spreadSnapshot() {
  const pc = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? +(v * 100).toFixed(3) : null);
  const coins = await Promise.all(ASSETS.map(async (a) => {
    const [r, hist] = await Promise.all([spreadRead(a).catch(() => null), gapHistory(a, 1).catch(() => [])]);
    const st = gapStats(hist);
    if (!r) return { asset: a, unavailable: 'prices or pool depth not readable now', last24h: { records: st.n, beatCosts: st.outside } };
    const s = r.s;
    return {
      asset: a, venue: s.venue, poolPriceUsd: s.pool, exchangePriceUsd: s.exchange, gapPct: pc(s.gap),
      // What the vault itself can do: buy on HSKSwap now and sell back there later.
      vault: s.side === 'poolCheap'
        ? { action: 'buy on HSKSwap, sell back on HSKSwap later', roundTripCostPct: pc(s.roundTrip), leftIfPoolRisesToExchangePct: pc(s.vaultNet), recordShowsThisPoolClosingADiscount: r.reverted, actionableNow: (s.vaultNet ?? 0) > 0 && r.reverted }
        : { action: 'only if the vault already holds the coin: selling it on HSKSwap beats the exchange', actionableNow: false },
      // Not possible for the vault: it needs an exchange account and moving the coins there.
      onlyWithAnExchangeAccount: { netPctBySize: Object.fromEntries(s.sizes.map((z) => [`$${z.usd}`, pc(z.net)])), breakEvenUsd: s.breakEven ?? null },
      last24h: { records: st.n, beatCrossVenueCosts: st.outside },
    };
  }));
  return { coins, costs: { hskswapFeePct: POOL_FEE * 100, exchangeTakerFeePctAssumed: TAKER_FEE * 100, notCounted: 'moving funds between HSK Chain and the exchange (time and fees), the exchange order book, gas' }, rule: 'Answer "yes" only when a coin has vault.actionableNow true. Never present onlyWithAnExchangeAccount as something the vault can do.' };
}

export type MoaStep = 'thinking' | 'market' | 'plan' | 'agents' | 'execute' | 'writing';
export type MoaEvent = { type: 'step'; step: MoaStep; detail?: string };

const pctOf = (v: number) => +(v * 100).toFixed(1);
/** An agent as the model sees it: English name, rule, backtest numbers, state now. */
function forModel(a: Agent) {
  return {
    name: `${a.base} ${STRINGS.en.agNick[a.rule]}`, strategy: STRINGS.en.agRule[a.rule], origin: STRINGS.en.agOrigin[a.rule], rule: STRINGS.en.agLine[a.rule], canHire: a.runnable,
    backtestDays: a.days, candles: a.interval ?? '1d', periodReturnPct: pctOf(a.total), justHoldingPct: pctOf(a.hold), worstDropPct: -pctOf(a.maxDd), feePerTradePct: pctOf(a.fee),
    now: a.kind === 'position' ? (a.live ? 'holding' : 'waiting for its signal') : a.mult > 0 ? `would buy x${a.mult} today` : 'skips today',
  };
}

/** How long one model call may take before Moa gives up and says so (the app then answers on-device). */
export const CALL_DEADLINE_MS = 90_000;

/** Turns a proposed order into a ticket for the logged-in wallet, or says why it cannot be proposed. */
export type Propose = (o: Order) => Ticket | string;

export async function runMoa(apiKey: string, cfg: ExecConfig, history: ChatTurn[], onEvent: (e: MoaEvent) => void = () => {}, ctx: MoaContext = {}, signal?: AbortSignal, propose: Propose = () => 'Trades cannot be proposed here.'): Promise<MoaResult> {
  // No silent retries behind the user's back: the SDK default (10 minutes, twice retried) left the chat
  // "reading the message" for half an hour when the API was slow or unreachable.
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: CALL_DEADLINE_MS });
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((t) => ({ role: t.role, content: t.content }));
  const result: MoaResult = { reply: '', executions: [], proposals: [], model: MODEL };

  for (let i = 0; i < 6; i++) {
    onEvent({ type: 'step', step: i === 0 ? 'thinking' : 'writing' });
    // Streamed, so a long answer keeps the connection alive; one deadline for the whole call, and the
    // caller's signal (the browser closed the request, or pressed stop) ends it at once.
    const deadline = AbortSignal.timeout(CALL_DEADLINE_MS);
    const response = await client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      tools,
      messages,
    }, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline }).finalMessage();
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
        } else if (u.name === 'get_spread') {
          onEvent({ type: 'step', step: 'market' });
          content = JSON.stringify(await spreadSnapshot());
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
        } else if (u.name === 'set_lp_plan') {
          onEvent({ type: 'step', step: 'plan' });
          const x = u.input as { usdt?: number; coin?: number; shape?: 'spot' | 'curve' | 'spotCurve' | 'bidask'; reachPct?: number; strategy?: string };
          const preset = LP_STRATEGIES.find((p) => p.id === x.strategy);
          const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
          result.lp = { ...(ok(x.usdt) ? { usdt: x.usdt } : {}), ...(ok(x.coin) ? { coin: x.coin } : {}), ...(x.shape ? { shape: x.shape } : {}), ...(ok(x.reachPct) && x.reachPct! > 0 ? { reachPct: Math.min(60, x.reachPct!) } : {}), ...(preset ? strategyPlan(preset) : {}) };
          content = 'The plan on the screen now shows this. The user supplies it themselves with the Supply button.';
        } else if (u.name === 'propose_trade') {
          const order = cleanOrder(u.input);
          const ticket = order && result.proposals.length === 0 ? propose(order) : null;
          if (!order) { isError = true; content = 'Not a valid order.'; }
          else if (result.proposals.length > 0) { isError = true; content = 'Only one proposal per message.'; }
          else if (typeof ticket === 'string') { isError = true; content = ticket; }
          else if (ticket) {
            onEvent({ type: 'step', step: 'execute', detail: `${order.side} ${order.amount} ${order.side === 'buy' ? 'USDT of ' : ''}${order.asset}` });
            result.proposals.push(ticket);
            content = 'Shown to the user as a card with a Confirm button. Nothing has been sent; it executes only if they press Confirm within 5 minutes.';
          } else { isError = true; content = 'Not proposed.'; }
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
