/**
 * The OpenAPI 3.1 contract of the web API (TASKS M2-08), served at GET /api/openapi. Request
 * bodies come from the zod schemas the routes validate with (lib/server/schemas.ts); responses
 * are written out here and checked against the routes by apps/web/test/openapi.test.ts.
 */
import { z } from 'zod';
import { SESSION_COOKIE } from './session';
import {
  CompareQuery,
  JudgePlanBody,
  JudgeSessionBody,
  PreflightQuery,
  ProjectionQuery,
  ReportRequest,
  RunBody,
  SkillPlanBody,
  WalletQuery,
} from './schemas';

type Schema = Record<string, unknown>;

function fromZod(schema: z.ZodType): Schema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input' });
  return rest;
}

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string): Schema => ({
  type: 'string',
  ...(description ? { description } : {}),
});
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const dataState = {
  type: 'object',
  required: ['tape', 'sampledAt'],
  properties: {
    tape: { enum: ['LIVE', 'STALE', 'UNAVAILABLE'] },
    sampledAt: nullable(str('When the tape run the decision used was sampled')),
  },
};

const schemas: Record<string, Schema> = {
  JudgeSessionBody: fromZod(JudgeSessionBody),
  JudgePlanBody: fromZod(JudgePlanBody),
  SkillPlanBody: fromZod(SkillPlanBody),
  RunBody: fromZod(RunBody),
  ReportRequest: fromZod(ReportRequest),
  Problem: {
    type: 'object',
    description: 'An error with a stable code (the UI maps it to copy) and a plain message.',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: { code: str(), message: str() },
      },
    },
  },
  Unavailable: {
    type: 'object',
    description:
      'The data this view needs is not there; never a made-up number (CLAUDE.md rule 4).',
    required: ['state', 'reason'],
    properties: { state: { const: 'UNAVAILABLE' }, reason: str() },
  },
  Why: {
    type: 'object',
    description: 'The one-sentence reason: a copy key (docs/UX_COPY.md §4) and its parameters.',
    required: ['key', 'params'],
    properties: {
      key: str(),
      params: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
  Queued: {
    type: 'object',
    description: 'Work handed to the worker, which signs (the web never does). Poll `poll`.',
    required: ['jobId', 'status', 'poll'],
    properties: {
      jobId: str(),
      status: { enum: ['queued', 'running'], description: 'running: a stop already under way' },
      poll: str(),
    },
  },
  Job: {
    type: 'object',
    required: ['jobId', 'kind', 'planId', 'status', 'createdAt'],
    properties: {
      jobId: str(),
      kind: { enum: ['preview', 'run', 'stop'] },
      planId: str(),
      status: { enum: ['queued', 'running', 'done', 'failed'] },
      result: {
        description:
          "The worker's report: a cycle outcome, a simulation or a stop. A run's report also has `planStatus`, the plan's status once it is over (`active`: it now runs on its own).",
      },
      error: nullable(str()),
      createdAt: str(),
      finishedAt: nullable(str()),
    },
  },
  NextStep: {
    type: 'object',
    description:
      'One `baw` command for the user’s own wallet, as argv. Placeholders in <angle brackets> are filled from the previous command’s JSON output.',
    required: ['id', 'run'],
    properties: {
      id: { enum: ['redeem', 'quote', 'swap'] },
      preview: {
        type: 'array',
        items: { type: 'string' },
        description: 'Run first and show the user; ask before `run`.',
      },
      run: { type: 'array', items: { type: 'string' } },
      acceptMinToCoinAmount: str(
        'quote: stop unless data.toCoinAmount is at least this — in the unit baw prints for a tokenized stock: shares (tokens × multiplier), human decimals',
      ),
      confirm: {
        type: 'array',
        items: { type: 'string' },
        description: 'swap: poll until FINISHED or FAILED — an orderId is not a trade.',
      },
      report: {
        type: 'object',
        description: 'POST this to /api/plans/{id}/report once the transaction is mined.',
        required: ['kind', 'body'],
        properties: {
          kind: { enum: ['redeem', 'swap'] },
          body: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
    },
  },
  NextAnswer: {
    description:
      'What the plan’s wallet should do now, decided by the deterministic engine (decideCycle) from the worker’s tape and the wallet’s on-chain position. No calldata, never a signature.',
    oneOf: [
      {
        type: 'object',
        required: ['planId', 'decidedAt', 'decision', 'data'],
        properties: {
          planId: str(),
          decidedAt: str(),
          decision: { enum: ['wait', 'skip', 'failed'] },
          why: ref('Why'),
          reason: str(
            'Machine reason when there is no copy key: not_due (the cadence: ask again at retryAt), data_stale, data_unavailable, venus_unavailable, chain_unavailable, no_principal, plan_paused, plan_stopped, …',
          ),
          pausedReason: nullable(str()),
          retryAt: str('Ask again at or after this time'),
          data: dataState,
        },
      },
      {
        type: 'object',
        required: [
          'planId',
          'decidedAt',
          'expiresAt',
          'decision',
          'spendUsd',
          'instrument',
          'estimate',
          'steps',
          'data',
        ],
        properties: {
          planId: str(),
          decidedAt: str(),
          expiresAt: str('The answer is good for five minutes; after that, ask again'),
          decision: { const: 'buy' },
          spendUsd: str(),
          interestUsd: nullable(str('Yield plans: how much of the spend is interest')),
          instrument: {
            type: 'object',
            required: ['ticker', 'issuer', 'symbol', 'address', 'decimals'],
            properties: {
              ticker: str(),
              issuer: { enum: ['bstocks', 'ondo'] },
              symbol: str(),
              address: str(),
              decimals: { type: 'integer' },
            },
          },
          estimate: {
            type: 'object',
            description:
              'Planning estimate from the tape (never executed); the wallet quotes again.',
            required: ['source', 'tokens', 'shares'],
            properties: {
              source: { const: 'tape' },
              sampledAt: nullable(str()),
              tokens: str(),
              shares: str(),
            },
          },
          steps: { type: 'array', items: ref('NextStep') },
          data: dataState,
        },
      },
    ],
  },
  PositionAnswer: {
    type: 'object',
    description:
      'A skill yield plan’s own Venus position, read on chain (its vTokens, never more than the wallet holds, at the market’s rate), and the step that takes exactly that out. The wallet may hold other Venus USDT; never redeem it with --ratio 1 for one plan.',
    required: ['planId', 'asOf', 'position', 'steps'],
    properties: {
      planId: str(),
      asOf: str(),
      position: {
        type: 'object',
        required: ['principalUsd', 'vTokens', 'underlyingUsd'],
        properties: {
          principalUsd: str('Principal on record'),
          vTokens: str('vUSDT units on record for this plan'),
          underlyingUsd: str('What they are worth now; 0 when nothing is left'),
        },
      },
      steps: {
        type: 'array',
        items: ref('NextStep'),
        description: 'One redeem step, or none when there is nothing to take out.',
      },
    },
  },
  ReportResult: {
    type: 'object',
    description:
      'The chain decides: recorded only when mined, successful, sent by the plan wallet after the plan was made (never a house-wallet transaction) and moving the expected tokens. A swap moves the plan to its next due time; spending past the plan limits is recorded and pauses the plan. A redeem counts as interest up to the position’s value above its principal, the rest as principal coming home.',
    required: ['status'],
    properties: {
      status: { enum: ['pending', 'rejected', 'recorded', 'already_recorded'] },
      reason: str(),
      kind: { enum: ['swap', 'deposit', 'redeem'] },
      txHash: str(),
      outcome: { type: 'object' },
      why: ref('Why'),
      paused: { const: 'report_over_limit' },
    },
  },
};

const json = (schema: Schema, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => json(ref('Problem'), description);
const unavailable = json(ref('Unavailable'), 'No database configured');
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const body = (name: string, required = true) => ({
  required,
  content: { 'application/json': { schema: ref(name) } },
});
const judge = [{ judgeSession: [] }];
const skill = [{ skillToken: [] }];
const either = [{ judgeSession: [] }, { skillToken: [] }];
const open = (summary: string, description = 'OK') => ({
  get: { summary, responses: { 200: json({ type: 'object' }, description), 503: unavailable } },
});
const days = { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 30 } };

/** Query parameters from the zod object the route parses its query with. */
function queryParams(schema: z.ZodObject) {
  const json = fromZod(schema) as {
    properties?: Record<string, Schema & { description?: string }>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: 'query',
      required: (json.required ?? []).includes(name),
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

export function openApiDocument(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Yieldvest API',
      version: '1.0.0',
      description:
        'Buy tokenized US stocks on BSC with the interest of a USDT deposit, only in the US regular session, under hard caps, with a receipt and a one-sentence reason for every action. The web reads what the worker recorded and queues work; it never signs and never calls the Binance Web3 API. Skill plans (mode C) run in the user’s own Binance Agentic Wallet: /next answers with `baw` commands, /report is checked against the chain.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        judgeSession: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description: 'Set by POST /api/judge/session; HMAC-signed, HttpOnly, seven days.',
        },
        skillToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'yv_…',
          description:
            'Issued once by POST /api/plans with owner "skill"; only its hash is stored.',
        },
      },
      schemas,
    },
    paths: {
      '/api/health': open('The web process answers'),
      '/api/judge/smoke': {
        get: {
          summary: 'Everything a judge’s visit depends on, in one read',
          description:
            'Database, the worker’s last tick, the Web3 API as the worker last saw it, BSC RPC, house balances, last receipt, tape. green / degraded (200) or red (503).',
          responses: {
            200: json({ type: 'object' }, 'green or degraded'),
            503: json({ type: 'object' }, 'red'),
          },
        },
      },
      '/api/judge/session': {
        post: {
          summary: 'Check a judge code and start a session',
          requestBody: body('JudgeSessionBody'),
          responses: {
            200: json(
              {
                type: 'object',
                properties: {
                  ok: { const: true },
                  capUsd: str(),
                  remainingUsd: str('What the code itself has left'),
                  todayUsd: str('What today’s house-wide cap still lets it spend (≤ remainingUsd)'),
                  dailyCapUsd: str('The house-wide daily cap'),
                  exhausted: { type: 'boolean', description: 'The code has used its own cap' },
                  dailyCapReached: {
                    type: 'boolean',
                    description: 'The code has money left, but today’s house-wide cap is spent',
                  },
                  expiresAt: str(),
                },
              },
              'Session cookie set',
            ),
            400: problem('Bad body'),
            401: problem('bad_code'),
            413: problem('too_large'),
            415: problem('json_only'),
            429: problem('rate_limited: 10 attempts a minute per address'),
            503: unavailable,
          },
        },
      },
      '/api/plans': {
        post: {
          summary: 'Create a plan: a judge sandbox plan, or a skill plan with its token',
          description:
            'With a judge session: JudgePlanBody (at most the sandbox cap, paused until its first run). With owner "skill": SkillPlanBody; the answer carries the bearer token once.',
          security: [{ judgeSession: [] }, {}],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { oneOf: [ref('JudgePlanBody'), ref('SkillPlanBody')] },
              },
            },
          },
          responses: {
            201: json(
              {
                type: 'object',
                properties: {
                  plan: { type: 'object' },
                  token: str('skill plans only: shown once'),
                  tokenId: str(),
                  remainingUsd: str('judge plans: what the code may still spend'),
                  depositUsd: str('judge yield plans: the deposit that starts it'),
                },
              },
              'Created',
            ),
            400: problem(
              'bad_request, unknown_ticker, over_cap, below_min, venue_minimum, bad_limits, house_wallet',
            ),
            401: problem('no_session'),
            409: problem(
              'code_exhausted: the code’s spend and deposits together reach its cap; daily_cap: the code has it, today’s house-wide cap does not',
            ),
            413: problem('too_large'),
            415: problem('json_only'),
            429: problem('too_many_plans or rate_limited'),
            503: unavailable,
          },
        },
      },
      '/api/plans/{id}': {
        get: {
          summary: 'The public plan view: timeline, receipts, holdings, limits, guardian',
          parameters: [idParam],
          responses: {
            200: json({ type: 'object' }, 'Plan view (no owner references; wallet shortened)'),
            404: problem('not_found'),
            503: unavailable,
          },
        },
      },
      '/api/plans/{id}/preview': {
        post: {
          summary: 'Queue a simulated run (never signs)',
          security: either,
          parameters: [idParam],
          responses: {
            202: json(ref('Queued'), 'Queued'),
            401: problem('unauthorized'),
            404: problem('not_found'),
            409: problem('use_next: skill plans are decided by GET /next'),
            429: problem('too_many_jobs: ten per plan per ten minutes'),
            503: unavailable,
          },
        },
      },
      '/api/plans/{id}/run': {
        post: {
          summary: 'Judge Mode “buy now”: queue a run for the worker',
          security: judge,
          parameters: [idParam],
          requestBody: body('RunBody', false),
          responses: {
            202: json(ref('Queued'), 'Queued'),
            400: problem('bad_json, bad_request, deposit_required, over_cap'),
            401: problem('unauthorized'),
            404: problem('not_found'),
            409: problem('plan_held (paused or stopped), code_exhausted'),
            413: problem('too_large'),
            415: problem('json_only'),
            429: problem('too_many_jobs'),
            503: unavailable,
          },
        },
      },
      '/api/plans/{id}/stop': {
        post: {
          summary: 'Queue a stop (house and judge yield plans redeem their position)',
          description:
            'Never refused for the job budget: a stop already waiting is answered instead. A skill plan’s position is in its own wallet and stays there.',
          security: either,
          parameters: [idParam],
          responses: {
            202: json(ref('Queued'), 'Queued (or the stop already waiting)'),
            401: problem('unauthorized'),
            404: problem('not_found'),
            503: unavailable,
          },
        },
      },
      '/api/plans/{id}/next': {
        get: {
          summary: 'Skill: what the wallet should do now, as baw commands',
          security: skill,
          parameters: [idParam],
          responses: {
            200: json(ref('NextAnswer'), 'A decision, valid for five minutes'),
            401: problem('unauthorized'),
            404: problem('not_found'),
            429: problem('rate_limited: 30 a minute per plan and token, 120 per address'),
            503: unavailable,
          },
        },
      },
      '/api/plans/{id}/position': {
        get: {
          summary: 'Skill: a yield plan’s own Venus position and the step that takes it out',
          security: skill,
          parameters: [idParam],
          responses: {
            200: json(ref('PositionAnswer'), 'The position and zero or one redeem step'),
            401: problem('unauthorized'),
            404: problem('not_found'),
            409: problem('not_yield'),
            429: problem('rate_limited: 10 a minute per plan and token, 60 per address'),
            503: json(ref('Unavailable'), 'venus_unavailable, chain_unavailable, or no database'),
          },
        },
      },
      '/api/plans/{id}/report': {
        post: {
          summary: 'Skill: report a transaction; the chain decides what is recorded',
          security: skill,
          parameters: [idParam],
          requestBody: body('ReportRequest'),
          responses: {
            200: json(ref('ReportResult'), 'recorded or already_recorded'),
            202: json(ref('ReportResult'), 'pending: not mined yet, report again'),
            400: problem('bad_json, bad_request'),
            401: problem('unauthorized'),
            404: problem('not_found'),
            413: problem('too_large'),
            415: problem('json_only'),
            422: json(ref('ReportResult'), 'rejected, with the reason'),
            429: problem('rate_limited: 20 a minute per plan and token, 60 per address'),
            503: unavailable,
          },
        },
      },
      '/api/jobs/{id}': {
        get: {
          summary: 'A queued job’s state and, when done, the worker’s report',
          parameters: [idParam],
          responses: { 200: json(ref('Job'), 'Job'), 404: problem('not_found'), 503: unavailable },
        },
      },
      '/api/house': open(
        'The house plans: principal, interest (read on chain), holdings, last outcome',
      ),
      '/api/receipts': {
        get: {
          summary: 'Receipt feed: every on-chain action with its one-line reason',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          responses: { 200: json({ type: 'object' }, 'Receipts'), 503: unavailable },
        },
      },
      '/api/market/status': open(
        'US session by our NYSE calendar and each token’s last recorded state',
      ),
      '/api/instruments': open(
        'The verified registry: addresses from the RWA API, checked on chain',
      ),
      '/api/tape/latest': open('The latest tape run, LIVE / STALE / UNAVAILABLE'),
      '/api/dx/metrics': {
        get: {
          summary: 'Per-endpoint calls, p50/p95, result codes, regions, first sightings',
          parameters: [days],
          responses: { 200: json({ type: 'object' }, 'Metrics'), 503: unavailable },
        },
      },
      '/api/dx/tape': {
        get: {
          summary: 'Tape aggregates for /dx: session gap, price impact by size, issuers',
          parameters: [days],
          responses: { 200: json({ type: 'object' }, 'Aggregates'), 503: unavailable },
        },
      },
      '/api/compare': {
        get: {
          summary: 'bStocks against Ondo for one stock, from the latest tape run',
          description:
            'Per issuer: status, on-chain price per share, US price and gap, venue minimum, full address, and for each tape quote size the shares it was worth, the price per share in it and its price impact (or the code it was refused with). Per size: which quote was worth more shares. Without `ticker`: the tickers and the issuers that sell each. Facts with their data state; never a pick.',
          parameters: queryParams(CompareQuery),
          responses: {
            200: json({ type: 'object' }, 'The comparison, or { tickers } without a ticker'),
            400: problem('bad_request'),
            404: problem('unknown_ticker'),
            429: problem('rate_limited: 120 requests a minute per address'),
            503: unavailable,
          },
        },
      },
      '/api/preflight': {
        get: {
          summary: 'Would Yieldvest buy this right now? decideCycle on the latest tape, read-only',
          description:
            'Runs the agent’s engine for a fixed-amount plan that does not exist yet, once per issuer — the answer GET /api/plans/{id}/next would give such a skill plan — and lists every rule’s input against its limit with its read time: data age (seconds), guardian, session, amount vs minimum (USD), token status, price gap (%), price impact (%). A buy needs a guardian check within 15 minutes. Creates nothing and returns no command.',
          parameters: queryParams(PreflightQuery),
          responses: {
            200: json({ type: 'object' }, 'Verdict per issuer and the rules it read'),
            400: problem('bad_request or bad_amount'),
            404: problem('unknown_ticker'),
            429: problem('rate_limited: 120 requests a minute per address'),
            503: unavailable,
          },
        },
      },
      '/api/projection': {
        get: {
          summary: 'What a deposit would earn if today’s listed Venus APY held',
          description:
            'Interest per day, week, month (30 days) and year, compounded daily at the listed APY; the days until it reaches the first buy (`firstBuyUsd`: the minimum buy, or the priced token’s venue minimum when higher — Ondo’s $5.01); about how many shares a month of it buys at the on-chain price of a LIVE tape. Each input carries its data state; no rate means no projection. The rate changes daily: a projection, not a promise.',
          parameters: queryParams(ProjectionQuery),
          responses: {
            200: json({ type: 'object' }, 'Inputs with their state, and the projection'),
            400: problem('bad_request or bad_amount'),
            404: problem('unknown_ticker'),
            429: problem('rate_limited: 120 requests a minute per address'),
            503: unavailable,
          },
        },
      },
      '/api/wallet': {
        get: {
          summary: 'A wallet’s tokenized stocks in shares, read on chain at one block',
          description:
            'Every registered bStocks or Ondo token the address holds, in underlying shares (tokens × the multiplier: a bStocks token’s own on chain at that block, with a scheduled change; an Ondo token’s from the registry), its value at the last recorded price (`prices.state`), the wallet’s USDT, its Venus USDT position and the Yieldvest plans that use it. `chain.state` is LIVE with the block, or UNAVAILABLE with the reason. Nothing is signed or stored.',
          parameters: queryParams(WalletQuery),
          responses: {
            200: json({ type: 'object' }, 'The wallet at one block'),
            400: problem('bad_request'),
            429: problem('rate_limited: 30 requests a minute per address'),
            503: unavailable,
          },
        },
      },
      '/api/mcp': {
        post: {
          summary: 'Read-only MCP server (Streamable HTTP, JSON-RPC 2.0)',
          description:
            'One JSON-RPC message per POST (or a batch of up to 10, as MCP 2025-03-26 allows), one JSON answer; no session and no stream (GET and DELETE answer 405). Methods: initialize, ping, tools/list, tools/call. Tools: market_status, compare_issuers, preflight, interest_projection, wallet_holdings, plan_status, recent_receipts — all read-only. `claude mcp add --transport http yieldvest <server>/api/mcp`.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            200: json({ type: 'object' }, 'A JSON-RPC result or error'),
            202: { description: 'A notification or a response: accepted, no body' },
            400: json(
              { type: 'object' },
              'Not a JSON-RPC message, or an unsupported protocol version',
            ),
            403: json({ type: 'object' }, 'A browser origin other than this site'),
            429: json({ type: 'object' }, '120 requests a minute per address'),
          },
        },
      },
      '/api/agent': {
        get: {
          summary: 'The ERC-8004 registration file of the Yieldvest agent',
          description:
            'BNB Agent Studio’s registration-v1 format: `name`, `description`, `image`, `services` (the read-only MCP server with its protocol version, and the site) and `registrations` (the BSC identity registry `eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and the agent id once one is assigned, else empty). `pnpm agent:register` puts exactly this file on chain, as its canonical JSON in a base64 data URI.',
          responses: { 200: json({ type: 'object' }, 'The registration file') },
        },
      },
      '/api/openapi': open('This document'),
    },
  };
}
