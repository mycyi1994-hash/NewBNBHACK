# SPEC.md — Technical specification

Author: Dohyun Lee (lead, systems and trading infrastructure). Reviewers: Minseo Kang (UX touchpoints), Jiwoo Park (instrumentation and submission).
Notation: **⚠️VERIFY** = confirm against the docs (`docs/vendor/llms-full.txt`) or a live call, then write the result in `DECISIONS.md`. Do not build anything on top of it before it is confirmed.

**v2 (2026-09-24):** §4, §5, §7, §8.2, §11, §12 and §14 were revised to reflect the G1 live measurements and the five-judge review (`docs/REPLAN.md` §5). Values that involve money (principal, minimum buy, caps) were not changed (REPLAN R1~R4 on hold).
- Signing happens in one place only: the worker.
- Market hours are judged by our own calendar.
- The price gap is compared only against an independent stock price.
- A quote is used within 25 seconds.
- RFQ is not executed.
- Before broadcast, the tx is written to the outbox, and a PENDING state exists.
- Simulation is judged by `status`.

## 1. Stack and repository layout

- Node 22, TypeScript 5, pnpm workspaces. Tests: vitest. Lint: eslint + prettier.
- `apps/web`: Next.js (App Router) + Tailwind. Deployed on Vercel, server function region **fra1** (Frankfurt). Seoul `icn1` is allowed for the web only, depending on the M0-04 reachability result.
- `apps/agent`: long-running Node worker (node-cron). Fly.io or Render, region **Frankfurt**. Banned regions: Amsterdam, London, Tokyo, Singapore (restricted regions, or blocking reported).
- `packages/core`: pure domain. No external I/O. 100% unit-tested.
- `packages/binance`: Web3 API client.
- `packages/chain`: viem-based BSC reads and signing. RPC: the official BSC dataseed + 1 spare.
- `packages/db`: Drizzle + Postgres (Neon, Frankfurt). Local development also uses Postgres (Docker) — no SQLite branch.
- `skills/yieldvest`: Wallet Skill.
- Shared config: `packages/config` (env validation with zod, cap constants).

## 2. Environment variables (see `.env.example`)

| Variable | Purpose |
| --- | --- |
| `BINANCE_WEB3_API_KEY`, `BINANCE_WEB3_API_SECRET` | Web3 API signing |
| `BINANCE_WEB3_BASE_URL` | Default `https://web3.binance.com/build` ⚠️VERIFY |
| `BSC_RPC_URL`, `BSC_RPC_URL_FALLBACK` | Chain reads, fallback broadcast |
| `DATABASE_URL` | Postgres |
| `HOUSE_WALLET_PRIVATE_KEY` | House wallet (server only, total balance ≤ $300) |
| `EXECUTION_MODE` | `simulate` (default) / `live` |
| `HOUSE_MAX_PER_TX_USD`=25, `SANDBOX_MAX_PER_PLAN_USD`=5, `DAILY_SPEND_CAP_USD`=50, `MIN_BUY_USD`=0.25(9/27, D-21), `MAX_PRINCIPAL_USD`=1000 | Caps |
| `JUDGE_CODES` | Comma-separated judge codes |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPS_CHAT_ID` | Ops alerts |
| `REGION_TAG` | For instrumentation (`fra`, `icn`, `kr-dev`) |

Caps are read in code only through `packages/config`, and are shown in the UI.

## 3. External systems

### 3.1 Binance Web3 API client (`packages/binance`)
Prior reference material (notes from earlier builders, all ⚠️VERIFY):
- Base `https://web3.binance.com/build`. Headers `X-OC-APIKEY`, `X-OC-TIMESTAMP` (ISO 8601 ms), `X-OC-SIGN` = base64(HMAC-SHA256(secret, timestamp + METHOD + path + body)). **The signed path includes the `/build` prefix and the query string** (the #1 cause of signature failures). Optional `X-OC-RECV-WINDOW`.
- Response envelope `{ code, msg, data, success, timestamp }`. **API errors can arrive as HTTP 200** → treat `success === false || code !== 0` as an error. A gateway 401 has no `success` field.
- Rate limits: 5 req/s per endpoint, 1,200/min per key and IP. On 429, honor `Retry-After`.
- Install the official connector `@binance-web3/wallet` (npm) as a devDependency and use it as **the primary source for paths, parameters and signing**. Why we implement our own client anyway: we need the original envelope and raw responses for instrumentation and fixtures.

Client requirements:
1. `request<T>(module, endpoint, opts)` as the single entry point. Per-endpoint token bucket (5/s), global 1,200/min.
2. Record every call in `api_calls`: ts, region, module, endpoint, method, http_status, code, msg (sensitive data masked), latency_ms, request_id, retry_count, fixture_path (optional).
3. Normalize errors to `BinanceApiError { module, endpoint, httpStatus, code, msg, retryable }`. The code mapping is in §11.
4. `recordFixture` option: save the response as `fixtures/<module>/<endpoint>-<yyyymmdd>-<n>.json` (keys and addresses masked).
5. Clock-skew guard: measure the difference between the server `timestamp` and local time, and warn.

Endpoints used (by module · paths are ⚠️VERIFY; once settled from llms-full.txt, list them in `docs/vendor/ENDPOINTS.md`):

| Module | Purpose | Notes |
| --- | --- | --- |
| RWA Data | Token and platform lists, ticker search, on-chain price and reference price, company profile and certificates, market status and next open, sector filter | Source for building the instrument registry |
| Market | Batched prices (`POST .../market/price`, array body ⚠️VERIFY), candles, USDT price | One batch per 5-minute tick |
| Trading | Quote (RFQ issuers require `userWalletAddress` ⚠️VERIFY), approval calldata, swap calldata, MEV | Quote expiry and re-quote rules: §5.6 |
| Transaction | Simulation, broadcast, status lookup | The gate for every write |
| Wallet | Balances, tokens, history | House, sandbox |
| DeFi | Protocol list and info (security score, TVL, APY), investment list, positions, deposit and redeem calldata | Venus core pool USDT only |
| b402 | 402 payment requirement, verification, settlement | Should |

Public auxiliary RWA endpoints (no auth required, sourced from the official skill docs, for fallback and cross-checking during outages):
under `https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/`: `stock/detail/list/ai?type=1|2|3` (1 Ondo, 2 xStocks, 3 bStocks), `meta/ai`, `market/status/ai`, `asset/market/status/ai`, `…/v2/…/dynamic/ai`, K-Line. Header `Accept-Encoding: identity`.

### 3.2 Agentic Wallet (`baw`, npm `@binance/agentic-wallet` 1.10.0)
- Never run on the server on a user's behalf. Where it is used: (1) the assistant on the user's device + our Skill, (2) verification and filming on the team's dev machines.
- Confirmed commands: `auth signin/verify`, `wallet status/settings/balance/tx-history`, `market-order quote/swap/list`, `limit-order buy/sell/list/cancel`, `defi protocol-list/investment-list/position/deposit/redeem/preview`, `x402-payment preview/sign`, `approvals list/revoke`.
- Policy: preview and confirm before any state change, `--json` required, an `orderId` is not a fill (check FINISHED/FAILED with `market-order list`), respect `sessionExpireTime`, `dailyLimit`, `defiDailyLimit` and `x402DailyLimit` from `wallet settings`.
- ⚠️VERIFY: `market-order swap` support for RWA tokens, whether `limit-order` is supported, whether `defi deposit` supports Venus USDT (M0-09).

### 3.3 BNB Agent Studio (`bag`)
- Purpose: an ERC-8004 identity for the house agent; if possible, runtime and MCP registration.
- ⚠️VERIFY(M0-10): whether the runtime can run an arbitrary Node worker, how the wallet is provided, how to expose the ERC-8183 task interface, cost.

### 3.4 Chain constants (on-chain verification required before use)
| Name | Address | Verification |
| --- | --- | --- |
| USDT (BSC) | `0x55d398326f99059fF775485246999027B3197955` | Official skill table |
| USDC (BSC) | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | Official skill table |
| Venus vUSDT (core pool) | `0xfD5840Cd36d94D7229439859C0112a4185BC0255` | ⚠️VERIFY `symbol()`, `underlying()` |
| Venus Comptroller | `0xfD36E2c2a6789Db23113685031d7F16329158384` | ⚠️VERIFY |
| Stock tokens | **No code constants.** RWA Data API → build the registry → verify `symbol/decimals` on-chain | M0-05 |

BEP-677 (bStocks): `balanceOf` does not change on dividends or splits; `uiMultiplier` changes. On detecting a multiplier change, invalidate the holdings cache. For Ondo/xStocks, use the `multiplier` from the RWA list.

## 4. Domain model (`packages/core/src/types.ts`)

v2: at the boundaries, amounts are passed as decimal strings (USD `"5"`; tokens as base-unit integer strings). Math is done in 18-decimal bigint (`amounts.ts`). The `number` amounts in the sketch below are `string` in the implementation.
- `FAILED.fundsMoved` is `'none' | 'gas_only'`.
- `BOUGHT` carries `interestUsd` (the part paid with interest). `refGapPct` is `null` when there is no independent stock price.
- A tx that has been broadcast but is not yet confirmed is not a cycle outcome; it is in the outbox's `PENDING` state (§5.8).

```ts
type Issuer = 'bstocks' | 'ondo' | 'xstocks';
type PlanOwner = { kind: 'house' } | { kind: 'judge'; code: string } | { kind: 'skill'; token: string };
type PlanMode = 'safe' | 'yield';
type Window = 'regular_session' | 'anytime';

interface Instrument { ticker: string; issuer: Issuer; chainId: 56; address: `0x${string}`;
  symbol: string; decimals: number; multiplier: string; verifiedAt: string; }

interface Plan { id: string; owner: PlanOwner; mode: PlanMode;
  target: { type: 'ticker'; ticker: string } | { type: 'sector'; sector: string };
  issuerPreference: Issuer[];           // default ['bstocks','ondo']
  principalUsd: number;                 // yield mode only, ≤ MAX_PRINCIPAL_USD
  contributionUsd: number;              // 0 allowed
  cadence: 'weekly' | 'daily' | 'once'; window: Window;
  limits: { maxPerBuyUsd: number; maxDailyUsd: number };
  status: 'active' | 'paused' | 'stopped'; pausedReason?: string;
  createdAt: string; nextDueAt: string; expiresAt?: string; /* judge: +7d */ }

type CycleOutcome =
  | { kind: 'BOUGHT'; spendUsd: number; tokens: string; shares: string; refGapPct: number }
  | { kind: 'DEFERRED'; reason: 'market_closed' | 'price_gap' | 'session_expiring' | 'quote_impact'; retryAt: string }
  | { kind: 'SKIPPED'; reason: 'below_min' | 'corporate_action' | 'daily_cap' | 'guardian' | 'no_instrument'; detail?: string }
  | { kind: 'FAILED'; code: string; message: string; fundsMoved: boolean };

interface Cycle { id: string; planId: string; startedAt: string; finishedAt?: string;
  steps: StepLog[]; outcome: CycleOutcome; whyKey: string; whyParams: Record<string, string>;
  receipts: Receipt[]; }

interface Receipt { kind: 'deposit' | 'redeem' | 'approve' | 'swap'; txHash: string; explorerUrl: string;
  chainId: 56; amounts: Record<string, string>; broadcastVia: 'transaction_api' | 'rpc'; simulatedAt: string; }

interface Holding { planId: string; instrument: Instrument; tokens: string; multiplierAtLastUpdate: string;
  shares: string; costUsd: string; updatedAt: string; }
```

DB tables: `plans, cycles, receipts, holdings, instruments, api_calls, tape_samples, guardian_events, judge_codes, skill_tokens, spend_ledger`. v2 adds `tx_outbox` and `jobs`.
- `tx_outbox`: a signed tx is written here before broadcast. Its columns are nonce, raw, hash and status (`SIGNED/PENDING/CONFIRMED/FAILED`).
- `jobs`: the web → worker job queue.

`spend_ledger` is the single source for the daily-cap calculation (per UTC day). It is written in the same DB transaction when a cycle **reserves** an amount.

## 5. Agent loop (`apps/agent`)

Tick: 5 minutes. A distributed lock per plan (`plans.lock_until`) prevents duplicate runs. A cycle's idempotency key is `planId:dueAt`.

**v2: there is one signer.** The house key exists only in the worker's (Fly) env. The web (Vercel) does not sign. `POST /api/plans/:id/run` puts a job into `jobs`, and the worker runs it under the same lock and nonce management. All plans use one wallet, so nonces are serialized per wallet.

**v2: the decision is a pure function.** `packages/core` `decideCycle(input)` answers one step at a time.
- `not_due`
- `done` (DEFERRED/SKIPPED/FAILED + whyKey)
- `quote` (get a quote and call again)
- `execute`

The worker does only the quote I/O, attaches the result to `quotes`, and calls again. The order is DUE → GUARDIAN → WINDOW → BUDGET → ASSET → PRICE → QUOTE.

### 5.1 DUE
If not `now ≥ plan.nextDueAt`, stop (nothing recorded). If due, create a cycle.

### 5.2 WINDOW
- **v2: the gate is our NYSE calendar** (`packages/core/session.ts`: New York time, a table of holidays and early closes). RWA `statusInfo` is not used to judge the session. bStocks report `openState:true, reasonCode:TRADING, marketStatus:null` even off-hours (dx/LOG.md 2026-09-24 00:45).
- `window === 'regular_session'`: outside the regular session, `DEFERRED(market_closed, retryAt = next open + 2 min)` (avoids outliers in the first quote right after the open).
- `anytime`: passes, but the per-buy limit is halved, and the reason is `why.bought.anytime`. If the half limit is smaller than the minimum buy, it does not buy off-hours and defers to 2 minutes after the regular-session open (`DEFERRED(market_closed)`, detail `half_limit_below_min`, D-22). If the per-buy limit itself is smaller than the minimum buy, that is a configuration error (validated at plan creation).

### 5.3 BUDGET
- safe: `budget = contributionUsd`.
- yield (v2 fix):
  - `interestInPosition = max(0, underlyingUsd − principalUsd)`
  - `budget = interestInPosition + harvestedUnspentUsd + contributionUsd`
  - `harvestedUnspentUsd` is interest that has been redeemed but not yet spent (per plan, from the ledger). The old formula's `− alreadyHarvested` was wrong: it subtracted twice the interest that the redeem had already taken out of the position.
  - The wallet's entire USDT is not treated as interest. The house wallet also holds the H-SAFE funds.
- If `budget < MIN_BUY_USD`, `SKIPPED(below_min)`. The accumulated amount is shown in the reason.
- If today's remaining limit is smaller than the minimum buy, `SKIPPED(daily_cap)`.
- `spend = min(budget, per-buy limit, today's remaining limit)`. The per-buy limit is the smaller of the plan limit and the config per-tx cap.
- Funding order for an interest buy: interest already redeemed → interest in the position (redeem) → contribution. The redeemed amount never exceeds the interest in the position (principal is untouchable).

### 5.4 ASSET
v2: status codes follow the Reason Codes and Corporate Actions tables of the official skill `binance-tokenized-securities-info`.
- Only `TRADING` (+`openState:true`) passes.
- `ASSET_PAUSED` (reasonMsg: cash_dividend, stock_dividend, stock_split, merger, acquisition, spinoff, maintenance, corporate action) and `ASSET_LIMITED` (earnings) are corporate actions.
  - End with `SKIPPED(corporate_action, detail)` **without switching issuers**. A corporate action is about the stock, not the exchange.
  - UX_COPY has keys only for earnings, dividends (cash, stock) and splits. The rest are shown as `why.skipped.no_liquidity`, with the actual reason kept in detail. Adding keys is a human's job.
- `MARKET_CLOSED/MARKET_PAUSED/MARKET_MAINTENANCE` skip that issuer. If no issuer is left, `DEFERRED(market_closed, retryAt = API nextOpenTime + 2 min, or +30 min if absent)`.
- `UNSUPPORTED` (the overnight session for some Ondo stocks) skips that issuer.

Issuer selection follows the `issuerPreference` order. Pick the first issuer that is trading, is above the issuer minimum order (`venueMinUsd`, Ondo 5.01 measured), and has not been excluded by a quote failure. If the minimum order means it cannot buy anywhere, write that minimum into `SKIPPED(below_min)`.

### 5.5 PRICE
v2: RWA `referencePrice` is derived as token price ÷ multiplier (Q-06 measured), so it is not used to judge the gap. The independent stock price is RWA Dynamic V2 `stockInfo.price` (official skill docs, "May be `null` outside trading hours"). Only when both exist is `gap = on-chain price per share / independent stock price − 1` measured.
- During the regular session, if the **premium** exceeds 2%, `DEFERRED(price_gap, retryAt = +30m)` (the same direction as the copy "…{gap}% above reference").
- A cheaper price and off-hours (anytime) are not blocked; only `refGapPct` is recorded.
- If there is no independent stock price, `refGapPct = null`. The `{gap}` copy in `why.bought.*` is then empty, so UX_COPY needs a change (human).

### 5.6 QUOTE
A Trading API quote is `spend` USDT → token.
- If `priceImpactPct > 1%`, re-quote with half the spend (at most twice). If the half is below the minimum buy or the issuer minimum order, `DEFERRED(quote_impact)` right away.
- v2: a quoteId is valid for **30 seconds** (Q-04 measured, 40401 at 35 seconds). **A quote older than 25 seconds is fetched again before signing.**
- Quote error handling:
  - On `40374` (liquidity) or `40375` (issuer minimum), exclude that issuer for this cycle and try the next issuer.
  - On `40369/40367` (off-hours RFQ refusal), `DEFERRED(market_closed)`.
  - Any other code is `FAILED(code, fundsMoved:'none')`.
- v2: a quote with `executionMode: 'RFQ'` is **not executed**. An EIP-712 order cannot be simulated through the Transaction API, and it is a new spending path, so it needs human approval (Q-15). Try the next issuer.

### 5.7 REDEEM (yield only)
Amount needed = `spend − spare wallet USDT`. DeFi API redeem calldata → Transaction API simulation → sign → broadcast → receipt. On failure, the cycle is `FAILED(fundsMoved=false)`.

### 5.8 SIMULATE → EXECUTE → CONFIRM
If an approval is needed, approve the **exact amount** (calldata from the Trading API). Swap calldata → Transaction API simulation (on failure, `FAILED` with the reason, fundsMoved=false) → viem signing → Transaction API broadcast (on failure, RPC fallback; record `broadcastVia`) → receipt polling (up to 3 minutes). The amount actually received is parsed from the receipt logs (never use the quoted value).

v2 order and rules:
1. **Order:** exact approval → confirm the approval receipt → **fresh quote (within 25 seconds)** → swap calldata → simulation → sign → broadcast.
   - Simulation covers one tx at a time, so a swap simulation cannot succeed before the approval is reflected on-chain (Q-05).
   - The DeFi API's APPROVE item (unlimited, Q-16) is not signed. We encode an exact-amount `approve` to the same spender ourselves (the spender is checked against the DEPOSIT item's `to`).
2. **Simulation verdict:** even on failure, the Transaction API returns `data.status: "FAILED"` with HTTP 200 and code 0 (Q-14). `simulate()` throws if `status !== 'SUCCESS'`.
3. **Outbox:** the signed raw tx, nonce and hash are written to `tx_outbox` (`SIGNED`) **before** broadcast. After sending, it is `PENDING`. When the worker starts, it reconciles `SIGNED/PENDING` against receipts and only then opens new cycles. A tx not confirmed within 3 minutes stays `PENDING`, not FAILED. This is to prevent duplicate buys.
   - v2.1 (9/27, DECISIONS D-23): settlement (`settleOutbox` = check against the chain → finish the waiting cycle → apply txs outside a cycle) runs on every tick and right before every signature, regardless of mode. A tx is FAILED (the nonce is reused) only when both broadcast paths **definitely** rejected it; if unclear, `PENDING` (`broadcast_via='unknown'`). When the nonce was used but we have no receipt for it, or when the node lost a swap older than 10 minutes, we do not guess: `PENDING` + a human alert after 30 minutes (RUNBOOK §3.4). The swap's call target must be the approved router.
4. **Cap reservation:** the `spend_ledger` reservation and the cycle row are written in the same DB transaction. If confirmation fails, the reservation is released.

### 5.9 RECORD
Update `holdings` (tokens, multiplier snapshot, shares = tokens × multiplier), write `spend_ledger`, store `whyKey/whyParams` (UX_COPY §4 keys), publish to the feed, ops alert (FAILED only). Update `nextDueAt` (weekly: the same window next week; daily: the next regular session).

v2.1 (9/27, D-23): on-chain effects (redeem, swap, deposit) are applied the moment they are confirmed, in one transaction that locks the plan row and inserts the receipt first (receipt hash unique → exactly once). Even if a cycle dies midway, an already-confirmed redeem is recorded, and the next lock holder either finishes that cycle from the chain (when something was signed) or closes it as FAILED `INTERRUPTED` (when nothing was). Cycles from manual runs (cycle:once, web jobs) do not move `nextDueAt`.

### 5.10 House plan initial values
- Plan H-SAFE: NVDA, safe, contribution $5, daily, regular_session, maxPerBuy $5.
- Plan H-YIELD: QQQ (MSFT if unavailable), yield, principal $200 ($500 if the budget allows), contribution $0, weekly, regular_session. The interest-accrual display is a key screen, so keep this plan even if buys are rare.
(Amounts are settled in DECISIONS, within the house wallet budget ≤ $300.)

## 6. Guardian (`packages/core/guardian.ts`, runs every tick)
Implements the PLAN §7 table as is. The input is `GuardianInputs {comptrollerPaused, tvlChange24hPct, utilizationPct, usdtPrice, ...}`, the output is `GuardianAction[]`. Actions are executed by `apps/agent`. Every trigger is recorded in `guardian_events` and shown on the Watch screen. A full redeem is broadcast only if its simulation succeeds; if it fails, alert and wait for a human to step in.

## 7. Execution adapters (`apps/agent/src/executors`)
| Adapter | Signer | Modes | Notes |
| --- | --- | --- | --- |
| `HouseWalletExecutor` | Worker (viem). v2: exists only in the worker process; the web requests via `jobs` | A, B | Caps: HOUSE_MAX_PER_TX_USD; sandbox: SANDBOX_MAX_PER_PLAN_USD |
| `DecisionOnlyExecutor` | None | C | Returns only the decision plus calldata, amount, addresses and reason. The user's assistant executes with baw, then calls `/report` |
| `SimulateExecutor` | None | Dev, CI | Only up to the Transaction API simulation |

## 8. Web app (`apps/web`)

### 8.1 Screens
| Path | Screen | Key elements |
| --- | --- | --- |
| `/` | Overview (D-25) | House interest-plan summary (USDT supplied, interest available, next purchase, status), interest flow diagram (interest earned → buy / carried forward), latest-receipt panel, progress bar to the next purchase, market status and data status |
| `/earn` | Earn (D-25) | Venus interest account (APY, security score), interest this cycle (carried forward and new interest; a chart that connects only the two values read), amount left to reach the minimum buy |
| `/invest` | Invest = Judge Mode (D-25, `/judge` redirects here) | code → stock → mode, amount, when to buy → preview (worker simulation) → run → receipt → stop |
| `/activity`, `/activity/[id]` | Activity, receipt detail (D-25) | Every cycle and receipt of the house plans (outcome filter); per cycle: amount, reason, BscScan, execution trace (step log) |
| `/plans/[id]` | Plan detail | Timeline, guardian events, limit usage, [Stop/Redeem all] |
| `/risk` | Risk disclosure | Full text of UX_COPY §5 |
| `/dx` | Developer experience | p50/p95 and error codes by endpoint, tape charts (regular session vs off-hours gap, price impact by size, issuer comparison), link to the findings list |
| `/skill` | Skill install guide | One-line install, example conversation, safety rules |

### 8.2 API
| Method and path | Purpose | Auth |
| --- | --- | --- |
| `GET /api/health` | Process liveness | None |
| `GET /api/judge/smoke` | Web3 API reachability, RPC, DB, last tick time, house balance, last receipt and latest tape time, all at once | None (read) |
| `POST /api/judge/session` | Verify judge code → session cookie | Code |
| `POST /api/plans` | Create a plan (B: session; C: issues a skill token) | Session/token |
| `POST /api/plans/:id/preview` | Simulation preview (plain language + raw) | Session/token |
| `POST /api/plans/:id/run` | One cycle right now (B). v2: goes into `jobs` and the worker runs it; the web polls the progress | Session |
| `GET /api/plans/:id/next` | Decision (C): what to do now, amount, address, baw command parameters without calldata, reason | Token |
| `POST /api/plans/:id/report` | Report C's execution result (txHash, orderId, status) | Token |
| `POST /api/plans/:id/stop` | Stop (+ request a full redeem) | Session/token |
| `GET /api/market/status`, `GET /api/instruments` | Read | None |
| `GET /api/dx/metrics`, `GET /api/tape/latest` | Read | None |

Every write route has rate limiting (IP, session) and cap checks. A total cap per judge code. Sandbox plans auto-stop after 7 days.

## 9. Wallet Skill (`skills/yieldvest`)
- The format follows `binance-agentic-wallet` on Skills Hub (frontmatter `name/description/metadata`, `references/`). `requires: bins: [baw]`; check that the prerequisite skill `binance-agentic-wallet` is installed.
- Command routing: create a plan → `POST /api/plans`; what to do now → `GET /next`; execute → `baw defi deposit|redeem` and `baw market-order quote → swap` with the parameters the server gave, confirm completion with `market-order list --orderId`; report → `POST /report`; status, stop.
- Safety rules (stated in the skill doc): read the risk disclosure aloud, then get consent; always preview and confirm before a state change; cross-check addresses from the server against the RWA list API; alert 2 hours before the session expires; `orderId`≠fill; pass error messages on verbatim.
- Test: on a team dev machine, use Claude Code to actually run one safe-mode $5 buy and one yield-mode deposit, and save the transcript to `docs/skill-demo.md` (masked).

## 10. Instrumentation and DX (Jiwoo Park's requirements)
- `api_calls`: §3.1. Weekly `pnpm dx:metrics` → `dx/metrics.md` (per endpoint: count, p50, p95, error-code distribution; per region).
- `tape_samples`: every 10 minutes, per instrument (5 tickers × the issuers that exist): on-chain price, reference price, market status + quotes at $5/$50/$500 (expectedOut, priceImpact, route/vendor, error code). Tagged regular session, pre/post, weekend.
- The `/dx` page renders the two above. The DX report's "Tokenized-stock specifics" comes from here.
- Event hooks: first sighting of an error code, a response shape that differs from the docs, p95 > 2s → ops alert + the agent records the facts in `dx/LOG.md` (a human fills in the narrative).

## 11. Error taxonomy (initial values, codes are ⚠️VERIFY)
| Source | Code/condition | Meaning | Handling | User copy key |
| --- | --- | --- | --- | --- |
| Web3 API | 40001 | Parameters | No retry, treat as a bug | `err.internal` |
| Web3 API | 40101/40102/40103/40104 | Key, signature, timestamp, permission | Check signing and clock, alert | `err.internal` |
| Web3 API | 40304 | Compliance/region | Region problem, alert, UNAVAILABLE | `err.region` |
| Web3 API | 40369(bStock)·40367(Ondo) | Off-hours RFQ refusal | DEFERRED(market_closed) | `why.deferred.market_closed` |
| Web3 API | 40374 | No liquidity | Try the next issuer → SKIPPED(no_instrument) | `why.skipped.no_liquidity` |
| Web3 API | 40375 | Below the issuer minimum order (Ondo "Minimum order amount is 5 USD.") | Try the next issuer → SKIPPED | `why.skipped.below_min` / `why.skipped.no_liquidity` |
| Trading | Quote `executionMode: RFQ` | Signed-order path (Q-15 not approved) | Not executed, next issuer | `why.skipped.no_liquidity` |
| Web3 API | 40365–40375 other | Trading error | Map per code, then FAILED | `err.trade` |
| HTTP | 429 | Rate limit | Wait for Retry-After, retry once | — |
| Transaction API | simulate failure | Revert, etc. | FAILED(fundsMoved=false) | `why.failed.simulation` |
| Chain | Receipt status 0 | Failure | FAILED(fundsMoved=gas only) | `why.failed.onchain` |
| Internal | Cap exceeded | — | SKIPPED(daily_cap) | `why.skipped.daily_cap` |
| RWA | ASSET_PAUSED/LIMITED | Corporate action | SKIPPED(corporate_action) | `why.skipped.corporate_action.<reason>` |

v2 additions:
- `FAILED.fundsMoved` is `none` (simulation or quote failure) or `gas_only` (on-chain failure). An uncertain state after broadcast is not FAILED but outbox `PENDING`.
- The keys that are missing from UX_COPY and that a human must add are:
  - `err.internal`, `err.region`, `err.trade` (used in the table but not in UX_COPY)
  - other corporate actions (merger, acquisition, spinoff, maintenance)
  - session about to expire (`session_expiring`)
  - no data (RWA status lookup failed)

## 12. Tests, execution modes, CI
- `packages/core`: unit tests for the decision engine, guardian and amount math (boundary values: minimum order, caps, window boundary times, multiplier changes).
- `packages/binance`: signature vector tests (same result as the connector source), envelope parsing, rate limiting.
- Integration: fixture replay (`fixtures/`), the full loop with `EXECUTION_MODE=simulate`.
  - v2: measured fixtures are **replayed as is** in parser and executor tests: 40401, 42900 (429), 40375, simulate `FAILED` inside code 0.
  - `packages/core` keeps 100% branch coverage.
  - `decide.test.ts` checks whyKey and its parameters against the UX_COPY §4 table.
- Manual live trade: `pnpm cycle:once --plan <id> --live` prints the amount, addresses and simulation result, and requires typing `y`.
- CI (GitHub Actions): typecheck, lint, test. No secrets. Deploys are manual.

## 13. Deploy and operations
- Web: Vercel (fra1). Worker: Fly/Render Frankfurt, restart policy always, 1 instance (the lock prevents duplicates).
- Uptime monitor: `/api/judge/smoke` every 5 minutes, Telegram on failure.
- Runbook (`docs/RUNBOOK.md`, written in M3): worker restart, DB recovery, house wallet top-up, cap change procedure, daily checklist for the judging window.
- No deploys after 10/9 (hotfixes excepted, smoke required).

## 14. Security rules
- The server **never stores** user keys, seeds, Agentic Wallet sessions or API keys. In mode C, signing happens on the user's device.
- The house key lives only in the server env; balance ≤ $300. Exact approvals only. Caps are enforced in code. v2: among the servers, it lives **only in the worker's (Fly) env**. It is not placed in the web (Vercel) (§5, one signer).
- Auth and rate limiting on every write route. CSP, HSTS. Dependency audit (`pnpm audit`) in M3.
- Mask keys and addresses in logs and fixtures. gitignore `.env*`, `.studio/` and baw session files.
- Token addresses come only from the registry that passed API + on-chain verification. No user-entered addresses.
