# Yieldvest — Interest becomes ownership.

> **In one line:** an agent that keeps your principal in a USDT savings pool (Venus on BNB Smart Chain) and buys tokenized US stocks (bStocks / Ondo) with the interest — or a fixed amount in safe mode — **only during the US regular session**, under hard caps, with an on-chain receipt and a one-sentence reason for every action.

An entry for BNB Hack: Tokenized Stocks Edition. Build 9/23 → internal submission 10/9 → deadline 10/11 12:00 UTC.

**Live:** filled in after deploy · **Video:** M4-02 · **DX report:** M4-01 · **Judge Mode:** the judge code in the submission form

## 60-second summary

The principal stays in a USDT interest account (Venus), and pieces of tokenized US stocks are bought **only with the interest (or a set contribution)** and **only during the US regular session**. Safe mode (contribution only) is the default. Decisions are made by decision rules (`packages/core` `decideCycle`, 100% coverage), not by a model, and every buy is signed **only after a dry run through the Binance Web3 Transaction API**. Every cycle leaves a receipt (BscScan) and a one-line reason (`why.*`), and the reasons it cannot buy (market closed, price gap, limits, guardian) are shown as they are, too.

## Not on the organizers' ideas list

The official "Ideas to Build" include "Auto-DCA and rebalancing" and "Buy your first stock on-chain" ([JUDGING §1](docs/JUDGING.md)); Judge Mode's default, a fixed $5 contribution, is exactly that. What Yieldvest adds:

- **Interest buys the stock.** The DeFi API and the Trading API in one cycle: a yield plan takes the interest its Venus deposit has earned out of Venus and buys the stock with it (`apps/agent/src/cycle.ts`).
- **Tokenized-stock rules in the engine.** Buys only in the NYSE regular session (holidays, early closes, daylight saving); the RWA Data API's `ASSET_PAUSED` / `ASSET_LIMITED` codes hold a buy around earnings, dividends and splits; amounts are shown in shares, tokens × the bStocks multiplier read on chain. Each hold is a sentence the user sees (`packages/core`).
- **The server decides, the user's AI assistant signs.** The Wallet Skill gets exact `baw` commands from `/next`, runs them in the user's Agentic Wallet after the user says yes, and reports back; the server checks every report on chain and holds no key or session (`skills/yieldvest`).
- **A Uniswap v4 hook priced by the NYSE session**, so LPs of tokenized stocks are paid for the overnight gap risk only these assets carry (`packages/rwa-lp`, tested on a BSC fork, not deployed).

## 3-minute trial (Judge Mode, `/invest` — the old address `/judge` also leads here)

**Try it** or the Invest tab → code → stock (NVDA, etc.) → Contribution only · $5 · regular session → **Dry-run it** (the worker simulates it on-chain) → **Buy now** → a receipt or "Waiting" (if the market is closed, it buys automatically at the next open +2 min) → **Stop this plan**.
1 code = up to $5, and the money comes from Yieldvest's house wallet. The plan ends automatically after 7 days.

## What Yieldvest ran itself

`pnpm receipts:table` builds this table from the DB (time · plan · action · outcome/reason · receipt). **Currently 0 receipts** — topping up the house wallet and switching to live are waiting on the humans' money decisions (REPLAN R1–R4). They get pasted here as they come in.

## Module matrix (PLAN §6.1 + status as of the code)

| Module | Where Yieldvest uses it | Status |
| --- | --- | --- |
| RWA Data API | Token list (address, multiplier, status code, next open), RWA prices — registry, tape, decisions | In use (Frankfurt worker, tape every 10 min) |
| Public bapi RWA Dynamic V2 (outside the Web3 API) | US stock price (`stockInfo.price`, null off-hours) — gap calculation, tape. A public endpoint with no key; the only docs are Skills Hub `binance-tokenized-securities-info` | In use (`apps/agent/src/stock-price.ts`) |
| Market API | USDT price (depeg guardian) | Code done |
| Trading API | Quotes (price impact, route), exact-amount approval calldata, swap calldata | Quotes in use (tape); signing path waiting for live |
| Transaction API | Simulation before every signature, gas limit estimation, broadcast (an alternative path to RPC) | Code done, waiting for live. Status lookup (transaction-detail) is not used: receipts are checked over BSC RPC |
| DeFi API | Venus USDT investment and APY (`apyDisplay`), TVL and security score (guardian, risk disclosure), deposit and redeem calldata | Code done |
| Wallet API | — (the house balance is read over BSC RPC) | Not used |
| Agentic Wallet / Wallet Skills | `skills/yieldvest`: the server hands out only `baw` commands via `/next` (and `/position` to take a stopped plan's own deposit out), signing happens on the user's device, `/report` is checked on chain. Every `baw` command and flag is tested against the real CLI's recorded help (`pnpm baw:help`, `baw` 1.10.0), and the quote check is in the shares `baw` prints | Code and docs done; the real-run demo is done by a human (M2-09) |
| b402 Payments | — | Not built (M3-01, cut candidate) |
| BNB Agent Studio | — | Not built (M2-10) |
| BSC | viem reads and writes, amounts confirmed from the receipt's Transfer logs, Venus vToken | In use |

## Use it with my AI assistant (Agentic Wallet, mode C)

```bash
git clone --depth 1 https://github.com/mycyi1994-hash/NewBNBHACK yieldvest-src \
  && mkdir -p ~/.claude/skills && cp -r yieldvest-src/skills/yieldvest ~/.claude/skills/
export YIELDVEST_URL=<site URL>
```

Then say "Start Yieldvest". Requires: `baw` 1.10.0 (`npm i -g @binance/agentic-wallet@1.10.0`), the `binance-agentic-wallet` and `query-token-audit` skills (`npx skills add binance/binance-skills-hub/skills/binance-web3/<skill>`), USDT to buy and a little BNB for gas. Before each signature the skill checks the command against the plan the user agreed (token, chain, amount within the plan's per-buy limit), that the wallet is not locked by a pending transaction, and the token against the official list; the user confirms with the wallet's own quote in front of them. The server only decides (it stores no keys or sessions); every transaction is signed by the user's wallet after the user confirms. API contract: `/api/openapi` (OpenAPI 3.1).

## RWA liquidity (Uniswap v4 hook)

[`packages/rwa-lp`](packages/rwa-lp) lets tokenized stocks be supplied as liquidity without selling the overnight gap for free: a Uniswap v4 hook on BSC's deployed PoolManager charges each swap for the US session it happens in (0.05% regular, 0.30% pre/after-hours, 1.00% closed, a 30-minute ramp after the open), makes the swap that closes a gap to a fresh reference price pay half of that gap, and prices a scheduled bStocks multiplier change (dividend, split) as closed. The session comes from the same NYSE calendar the agent uses, checked on chain against 12,944 vectors. An ERC-20 vault holds the full-range position; withdrawals can never be blocked. Built, fork-tested on real NVDAB and NVDAon, not deployed: deploying and seeding are a human decision. Details: [`docs/RWA_LP.md`](docs/RWA_LP.md).

```bash
pnpm lp:test      # forge: 144 tests (BSC fork suite: BSC_FORK_URL=… pnpm lp:test)
pnpm lp:market    # the tokenized-stock pools already on Uniswap v4 on BSC, live, vs Binance's price
pnpm lp:status    # live state of deployed pools; UNAVAILABLE until one is deployed
```

## Structure

**Frontend design:** The approved BNB-style UI and the Yieldvest logo (source: [frontend-preview](frontend-preview/README.md), handoff: [FRONTEND_HANDOFF.md](FRONTEND_HANDOFF.md)) have been moved into the real web app, `apps/web` (DECISIONS D-25). All 4 tabs — Overview, Earn, Invest (= the judge trial) and Activity — show only real values from the server and the chain. `frontend-preview/` remains as the original design, running on example data.

```
apps/web        Next.js: screens (Overview, Earn, Invest (trial), Activity, Plan, Assistant, Data, Risk) and API. Does not sign and does not call the Web3 API
apps/agent      Worker (the only signer): tape every 10 min, tick every 5 min (outbox, awaiting cycles, guardian, jobs, plans that are due), web jobs every 3 s
packages/core   Decision rules (decideCycle), guardian rules, amount and share-count math, NYSE calendar — pure functions, 100% coverage
packages/binance  Web3 API client: HMAC signing, rate limit, error taxonomy (SPEC §11), call instrumentation (api_calls)
packages/chain  viem: ERC-20, Venus, receipt logs
packages/db     Drizzle schema, migrations (with rollback), spend ledger (advisory lock), outbox, jobs
packages/rwa-lp Uniswap v4 hook, NYSE calendar, reference oracle and LP vault (Foundry) + a read-only TypeScript reader
skills/yieldvest    Wallet Skill (SKILL.md + references)
```

## Safety measures (summary — details in [`docs/SECURITY.md`](docs/SECURITY.md))

- Hard caps are read from one place in env and enforced by code: $25 per tx and $50 per day (house), $5 per judge code. Spending is reserved in the ledger under a lock.
- Exact-amount approvals only; calldata is decoded and verified before signing (a swap may only call the approved router); **no signature without a simulation SUCCESS**; if there is no receipt within 3 minutes, the outbox stays PENDING and new signing is blocked. Effects confirmed on chain are recorded exactly once, in one transaction together with the receipt — when the outcome is unclear, it does not guess but asks a human ([DECISIONS D-23](docs/DECISIONS.md)).
- Guardian: Venus paused, TVL −30% in 24 hours, utilization 95%, USDT at 0.99 for 30 minutes → stop buying / redeem everything (in live, only when the simulation passes).
- Every data block is one of Live / n min old / Unavailable (reason). It does not make up numbers.
- CSP (a nonce per request), HSTS, no horizontal scroll on a 375px screen, English only (D-26) (`pnpm ui:check`).

## Risk

[`/risk`](apps/web/app/risk/page.tsx) — Yieldvest is not a bank. You can lose principal (a Venus hack, a USDT depeg). Interest rates change daily and stock prices go up and down. Safe mode (contribution only) is the default.

## Run

**With Docker, nothing else to install** (simulate mode: nothing is signed, no wallet key is used):

```bash
docker compose up --build    # http://localhost:3000 · judge code LOCAL-JUDGE
docker compose down -v       # stop and delete the local database
```

Postgres, migrations and seed, the web app and the worker start together (`compose.yaml`, `Dockerfile.local`). Without a Binance Web3 API key every screen says what it cannot show and why, and `/api/judge/smoke` shows the RPC and the database green and the rest red with its reason (checked 10/1). With `BINANCE_WEB3_API_KEY` and `BINANCE_WEB3_API_SECRET` in your environment the worker records live quotes and market status every 10 minutes. Judge Mode's dry runs also need a house wallet, which this setup leaves out on purpose; the whole Judge Mode flow runs in `pnpm e2e` (below) and on the live site.

**With pnpm:**

```bash
pnpm i
cp .env.example .env          # EXECUTION_MODE=simulate (the default) signs nothing. The web starts without keys;
                              # the worker's tape and decisions need a Binance Web3 API key (Q-01: use it from one region only)
pnpm db:migrate && pnpm db:seed   # needs DATABASE_URL (Postgres)
pnpm dev                      # web + worker. With no data, the screens honestly show "Unavailable (reason)"
pnpm typecheck && pnpm lint && pnpm test   # test DB: YIELDVEST_TEST_DATABASE_URL
pnpm --filter @yieldvest/web build && pnpm e2e --database postgres://…/yieldvest_e2e
                              # Judge Mode in Chromium, simulate mode, no network; the DB name must contain e2e
pnpm smoke --url http://localhost:3000     # /api/judge/smoke
```

Operating procedures: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Document map

| Document | Purpose |
| --- | --- |
| [`docs/JUDGING.md`](docs/JUDGING.md) | Official judging criteria (verbatim) and how features map to them |
| [`docs/PLAN.md`](docs/PLAN.md) | Plan: goals, users, scope, flows, schedule, cut lines |
| [`docs/SPEC.md`](docs/SPEC.md) | Technical spec: modules, data model, agent loop, guardian, error taxonomy |
| [`docs/TASKS.md`](docs/TASKS.md) | Tickets and evidence |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Locked decisions, open questions |
| [`docs/DX_PROTOCOL.md`](docs/DX_PROTOCOL.md) · [`dx/LOG.md`](dx/LOG.md) | Developer-experience evidence |
| [`docs/UX_COPY.md`](docs/UX_COPY.md) | UI copy (English only, D-26 and D-27) |
| [`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Security review, operations |
| [`docs/RWA_LP.md`](docs/RWA_LP.md) | RWA liquidity: the Uniswap v4 hook, vault, evidence and deploy runbook |
| [`CLAUDE.md`](CLAUDE.md) · [`docs/GOALS.md`](docs/GOALS.md) | Operating rules and goals for the coding agent |

## License

To be decided before submission (MIT recommended).
