/**
 * A read-only MCP server (DECISIONS D-31, feature F4). Any MCP client — Claude Code, Claude
 * Desktop, an IDE assistant — can ask Yieldvest what the market is doing, compare the two issuers
 * of a stock, run the agent's rules on a plan before it exists, project interest, and read a
 * plan's record or the receipt feed. Stateless Streamable HTTP (MCP 2025-03-26 to 2025-11-25):
 * one JSON-RPC message (or a 2025-03-26 batch) per POST, one JSON answer, no session, no
 * server-to-client stream.
 *
 * Every tool reads what the worker recorded, through the same functions as the GET routes, and is
 * marked read-only. None of them creates a plan, signs or moves funds: acting stays with the
 * Wallet Skill and the user's own Binance Agentic Wallet (DECISIONS D-03).
 */
import type { Config } from '@yieldvest/config';
import type { Issuer, PlanWindow } from '@yieldvest/core';
import { getPlan, type Db } from '@yieldvest/db';
import { z } from 'zod';
import { compareIssuers } from './compare';
import { marketStatus } from './market';
import { planView } from './plan-view';
import { preflight, preflightAmountProblem } from './preflight';
import { interestProjection } from './projection';
import { receiptFeed } from './receipts';
import { PreflightQuery, ProjectionQuery, WalletQuery } from './schemas';
import { walletView } from './wallet';

/** Newest first; an initialize asking for anything else is answered with the newest. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const SERVER_INFO = { name: 'yieldvest', title: 'Yieldvest (read-only)', version: '1.0.0' };

export const INSTRUCTIONS =
  'Yieldvest buys tokenized US stocks (bStocks and Ondo tokens on BNB Smart Chain) with the interest of a USDT deposit, only in the US regular session, under hard caps, with an on-chain receipt and a one-sentence reason for every action. These tools are read-only: they read what the Yieldvest worker recorded (a market tape every 10 minutes, the Venus rate, the guardian) and run its deterministic rules. None of them creates a plan, signs or moves funds. Every answer carries its data state (LIVE, STALE with a time, UNAVAILABLE with a reason): say it whenever you quote a number. Nothing here is investment advice; never choose an issuer for the user. To act, the user runs the Yieldvest Wallet Skill with their own Binance Agentic Wallet.';

export interface ToolContext {
  db: Db | undefined;
  config: Config;
  now: Date;
}

type ToolOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  run(args: z.output<S>, db: Db, ctx: ToolContext): Promise<ToolOutcome>;
}

const ok = (value: object): ToolOutcome => ({ ok: true, value: value as Record<string, unknown> });
const fail = (message: string): ToolOutcome => ({ ok: false, message });

/** Types each tool's `run` by its own input schema; the list holds them as plain tools. */
const tool = <S extends z.ZodType>(definition: Tool<S>): Tool => definition;

export const TOOLS: readonly Tool[] = [
  tool({
    name: 'market_status',
    title: 'US session and token status',
    description:
      'The US equity session by Yieldvest’s NYSE calendar (regular, pre, post, overnight, weekend, holiday), the next regular open, and for every registered token: issuer, symbol, full contract address, status reason code, on-chain price per share, the US stock price and the gap between them, and the venue minimum. From the latest tape run, with its data state.',
    input: z.object({}),
    run: async (_args, db, ctx) => ok(await marketStatus(db, ctx.now)),
  }),
  tool({
    name: 'compare_issuers',
    title: 'bStocks vs Ondo for one stock',
    description:
      'The same US stock from its two issuers, side by side, from the latest tape run: the shares each $5 / $50 / $500 quote was worth, the price per share in that quote, price impact or the error code it was refused with, token status and venue minimum, and per size which quote was worth more shares. Facts with their time; the user chooses.',
    input: z.object({ ticker: PreflightQuery.shape.ticker }),
    run: async (args, db, ctx) => {
      const comparison = await compareIssuers(db, args.ticker, ctx.now);
      return comparison ? ok(comparison) : fail(`${args.ticker} is not in the registry`);
    },
  }),
  tool({
    name: 'preflight',
    title: 'Would Yieldvest buy this right now?',
    description:
      'Runs Yieldvest’s deterministic decision engine (decideCycle) on the latest tape for a fixed-amount plan that does not exist yet, once per issuer: buy (with the amount and about how many shares), wait (with when), or skip, with the one-line reason the agent would record. Lists every rule’s input against its limit — data age, guardian, session, amount vs minimum, token status, price gap, price impact. Creates nothing.',
    input: PreflightQuery,
    run: async (args, db, ctx) => {
      const minBuyUsd = String(ctx.config.caps.minBuyUsd);
      const bad = preflightAmountProblem(args.usd, {
        minBuyUsd,
        maxPerTxUsd: String(ctx.config.caps.houseMaxPerTxUsd),
      });
      if (bad) return fail(bad);
      const query: { ticker: string; usd: string; window: PlanWindow; issuer?: Issuer } = {
        ticker: args.ticker,
        usd: args.usd,
        window: args.window,
        ...(args.issuer ? { issuer: args.issuer } : {}),
      };
      const answer = await preflight(db, query, minBuyUsd, ctx.now);
      return answer
        ? ok(answer)
        : fail(`${args.ticker}${args.issuer ? ` (${args.issuer})` : ''} is not in the registry`);
    },
  }),
  tool({
    name: 'interest_projection',
    title: 'What a deposit would earn at today’s rate',
    description:
      'For a USDT deposit: interest per day, week, month and year if today’s listed Venus APY held (compounded daily), the days until that interest reaches the minimum buy, and about how many shares a month of it buys at today’s on-chain price. The rate changes daily: a projection, not a promise. Each input carries its data state.',
    input: ProjectionQuery,
    run: async (args, db, ctx) => {
      if (Number(args.depositUsd) <= 0) return fail('depositUsd must be above 0');
      const query: { depositUsd: string; ticker?: string; issuer?: Issuer } = {
        depositUsd: args.depositUsd,
        ...(args.ticker ? { ticker: args.ticker } : {}),
        ...(args.issuer ? { issuer: args.issuer } : {}),
      };
      const view = await interestProjection(db, query, String(ctx.config.caps.minBuyUsd), ctx.now);
      if (args.ticker && view.price === null) {
        return fail(
          `${args.ticker}${args.issuer ? ` (${args.issuer})` : ''} is not in the registry`,
        );
      }
      return ok(view);
    },
  }),
  tool({
    name: 'wallet_holdings',
    title: 'A wallet’s tokenized stocks, in shares',
    description:
      'A BNB Smart Chain address (the user’s Binance Wallet or Agentic Wallet: `baw wallet address`) read on chain at one block: each registered bStocks or Ondo token it holds, in underlying shares (tokens × the multiplier; a scheduled bStocks multiplier change is named), its value at the last recorded price with that price’s state, the wallet’s USDT, its Venus USDT position and the Yieldvest plans that use it. Public chain reads; nothing is stored.',
    input: WalletQuery,
    run: async (args, db, ctx) => ok(await walletView(db, ctx.config, args.address, ctx.now)),
  }),
  tool({
    name: 'plan_status',
    title: 'A plan’s public record',
    description:
      'A Yieldvest plan by id: status, limits with today’s use, every cycle with its one-line reason, receipts with BscScan links, holdings in shares, and guardian events. The same record as the plan page; it never includes a token or a key.',
    input: z.object({ planId: z.string().trim().min(1).max(80).describe('The plan id') }),
    run: async (args, db, ctx) => {
      const row = await getPlan(db, args.planId);
      return row ? ok(await planView(db, ctx.config, row, ctx.now)) : fail('no such plan');
    },
  }),
  tool({
    name: 'recent_receipts',
    title: 'The receipt feed',
    description:
      'The latest on-chain actions of every plan (buys, deposits, withdrawals, exact approvals), each with its transaction hash, BscScan link and one-line reason.',
    input: z.object({
      limit: z.number().int().min(1).max(100).default(20).describe('How many, newest first'),
    }),
    run: async (args, db, ctx) =>
      ok({ at: ctx.now.toISOString(), receipts: await receiptFeed(db, args.limit) }),
  }),
];

function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input' });
  return rest;
}

/** What tools/list answers. */
export function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: inputSchema(t.input),
    annotations: {
      title: t.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));
}

/**
 * A model often writes 5 for "5": a number where the schema wants a decimal string is passed as
 * its text, and the schema still decides (2.505 still fails the two-decimal rule).
 */
function withStringAmounts(schema: z.ZodType, args: Record<string, unknown>) {
  const properties = (inputSchema(schema).properties ?? {}) as Record<string, { type?: unknown }>;
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === 'number' && properties[key]?.type === 'string' ? String(value) : value,
    ]),
  );
}

type JsonRpcId = string | number;

export type McpReply =
  | { status: 202 }
  | { status: 200 | 400; body: Record<string, unknown> | Record<string, unknown>[] };

/** At most this many messages in one batch (MCP 2025-03-26 lets a client send them batched). */
export const MAX_BATCH = 10;

/** One message's outcome: nothing to answer (a notification or a response), an answer, or invalid. */
type Outcome = { kind: 'accepted' } | { kind: 'answer' | 'invalid'; body: Record<string, unknown> };

export const rpcError = (id: JsonRpcId | null, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

const isId = (value: unknown): value is JsonRpcId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));

/** tools/call: undefined for a tool that does not exist (a protocol error), else its result. */
async function callTool(params: unknown, ctx: ToolContext): Promise<object | undefined> {
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const found = TOOLS.find((t) => t.name === name);
  if (!found) return undefined;
  const result = (outcome: ToolOutcome) =>
    outcome.ok
      ? {
          content: [{ type: 'text', text: JSON.stringify(outcome.value, null, 2) }],
          structuredContent: outcome.value,
          isError: false,
        }
      : { content: [{ type: 'text', text: outcome.message }], isError: true };
  const raw = args === undefined || args === null ? {} : args;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return result(fail('arguments must be an object'));
  }
  // Argument problems are tool errors, not protocol errors: the model reads them and corrects.
  const parsed = found.input.safeParse(
    withStringAmounts(found.input, raw as Record<string, unknown>),
  );
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return result(fail(`${first?.path.join('.') || 'arguments'}: ${first?.message ?? 'invalid'}`));
  }
  if (!ctx.db) return result(fail('unavailable: no database configured'));
  try {
    return result(await found.run(parsed.data, ctx.db, ctx));
  } catch (error) {
    console.error(
      `web: mcp ${found.name} failed —`,
      error instanceof Error ? error.message : error,
    );
    return result(fail('unavailable: the database did not answer'));
  }
}

/** One JSON-RPC message: a request is answered, a notification or a response is only accepted. */
async function handle(message: unknown, ctx: ToolContext): Promise<Outcome> {
  const invalid = (text: string): Outcome => ({
    kind: 'invalid',
    body: rpcError(null, -32600, text),
  });
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return invalid('not a JSON-RPC message');
  }
  const { jsonrpc, id, method, params } = message as Record<string, unknown>;
  if (jsonrpc !== '2.0') return invalid('jsonrpc must be "2.0"');
  // A response from the client (this server never asks) or a notification: accepted, no body.
  if (method === undefined || id === undefined) return { kind: 'accepted' };
  if (!isId(id) || typeof method !== 'string') return invalid('bad id or method');
  const answer = (result: object): Outcome => ({
    kind: 'answer',
    body: { jsonrpc: '2.0', id, result },
  });
  const error = (code: number, text: string): Outcome => ({
    kind: 'answer',
    body: rpcError(id, code, text),
  });

  switch (method) {
    case 'initialize': {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion =
        typeof asked === 'string' && MCP_PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : MCP_PROTOCOL_VERSIONS[0];
      return answer({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return answer({});
    case 'tools/list':
      return answer({ tools: toolList() });
    case 'tools/call': {
      const result = await callTool(params, ctx);
      if (result === undefined) {
        const name = (params as { name?: unknown } | undefined)?.name;
        return error(-32602, `unknown tool: ${String(name)}`);
      }
      return answer(result);
    }
    default:
      return error(-32601, `method not found: ${method}`);
  }
}

/**
 * The HTTP answer to one POST (MCP Streamable HTTP, without streams): one message, or a batch of
 * up to MAX_BATCH (MCP 2025-03-26; later revisions dropped batching and their clients do not send
 * one). A batch answers with the array of its answers, or 202 when it held no request.
 */
export async function mcpReply(message: unknown, ctx: ToolContext): Promise<McpReply> {
  if (!Array.isArray(message)) {
    const outcome = await handle(message, ctx);
    if (outcome.kind === 'accepted') return { status: 202 };
    return { status: outcome.kind === 'invalid' ? 400 : 200, body: outcome.body };
  }
  if (message.length === 0) {
    return { status: 400, body: rpcError(null, -32600, 'an empty batch') };
  }
  if (message.length > MAX_BATCH) {
    return { status: 400, body: rpcError(null, -32600, `at most ${MAX_BATCH} messages a batch`) };
  }
  const answers: Record<string, unknown>[] = [];
  for (const item of message) {
    const outcome = await handle(item, ctx);
    if (outcome.kind !== 'accepted') answers.push(outcome.body);
  }
  return answers.length === 0 ? { status: 202 } : { status: 200, body: answers };
}
