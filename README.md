# Moa: AI trading agents for beginners, on HSK Chain

Moa is an entry for the **HSK Chain Horizon Hackathon · Seoul, Track 1 (AI Agent Trading)**.

Moa lets people who have never traded do three things:
- give a trading agent a small amount of money and let it work;
- see in plain words what that agent does;
- stop it or take the money out at any time.

Every agent follows one fixed rule on one coin. It trades on HSKSwap from **the user's own vault**: a contract on
HSK Chain that only the user can withdraw from, with the user's limits and stop-loss enforced on-chain.

**Live app:** https://grabitmoa.onrender.com · any vault, read-only, no login: `https://grabitmoa.onrender.com/?vault=<address>`
(`?vault` alone lists every vault the factories made) · how Moa earns and its risks: `?trust`

Log in with a wallet on HSK Chain. Without one, the whole app works as a demo that sends nothing.

## Where this code comes from

- **Built for this hackathon, from scratch.** Everything in `hsk-agent/` was written between 21 and 27 November 2026.
- **The repository is reused.** This repository and branch first held an unrelated project (an entry for BNB Hack,
  "Ijaro/Yieldvest"). That code was deleted on 27 November 2026. Commits before 21 November 2026 in the history
  belong to that project and are not part of Moa.
- **AI-assisted.** Moa was built with an AI coding agent (Claude Code) working from the author's instructions and
  reviews.

## On HSK Chain mainnet (checked on-chain, 27 Nov 2026)

| What | Address / transaction |
| --- | --- |
| MoaVaultFactory, source published | [`0xd6bF84aF1a81EB88EF2fD0c5B254b955E8256546`](https://hsk.blockscout.com/address/0xd6bF84aF1a81EB88EF2fD0c5B254b955E8256546) |
| A user's vault, made by the factory when that wallet logged in | [`0x6A355aE335f06971C337c900783C2e016410b33C`](https://hsk.blockscout.com/address/0x6A355aE335f06971C337c900783C2e016410b33C) · [creation tx](https://hsk.blockscout.com/tx/0x3b69260d046140866ca1b5429c625c69e9a5f1cf93efd3c54c5d84f60f1afb0b) · [in the app, read-only](https://grabitmoa.onrender.com/?vault=0x6A355aE335f06971C337c900783C2e016410b33C) |
| First trade through a vault ($1 of WBTC on HSKSwap; an earlier vault version) | [tx](https://hsk.blockscout.com/tx/0x955cd89b5e89200d606300df1afeca3c3adb337c200e6743af7b64595c2441ee) |
| Agent wallet (may call `trade` and `stopOut` only; cannot withdraw) | [`0x8C35f99f3c0D210EA54fe4AF68d5f548cCCC1bAE`](https://hsk.blockscout.com/address/0x8C35f99f3c0D210EA54fe4AF68d5f548cCCC1bAE) |

**Moa AI is live** on the deployed server: its first decisions were recorded on 28 Nov 2026 (BTC, ETH and HSK; for
example the HSK decision with hash `0x9be4247b…79b9c884`). Anyone can read them at
[`/api/ai/decisions?asset=HSK`](https://grabitmoa.onrender.com/api/ai/decisions?asset=HSK). No vault has traded on a
Moa AI decision yet.

**Not yet done on mainnet** with the current version:
- an agent trade;
- a stop-loss;
- a liquidity supply.

They have been run on a local fork of mainnet only (scripts in `hsk-agent/contracts/scripts/`). The contracts are
**unaudited**.

**Vault version 3 is not deployed.** It is compiled and tested only, on 27 Nov 2026:
- fork tests: `fork-test.mjs` 69/69 and `fee-fork-test.mjs` 51/51;
- a randomized fork fuzz test: over 3,400 invariant checks, 0 failed;
- Foundry: 20 tests, 5 of them invariants (256 runs × 80 calls); MoaVault line coverage 99% (`contracts/audit/coverage.txt`);
- Slither: 0 high findings; 12 rated medium, each reviewed and kept with reasons in `contracts/MAINNET.md`
  (`contracts/audit/slither.txt`).

Version 3 adds:
- a price floor from the pool's 10-minute average instead of the price now;
- safe starting limits that the owner can change;
- a per-vault agent session with an expiry, coins and a per-trade cap, which the owner can revoke;
- optional on-chain budgets per agent;
- a guardian that can halt agent trading on every vault (funds, withdrawals and stop-loss untouched);
- creator fees approved per hired agent;
- a platform-fee switch that is 0 and capped at 0.2% in the contract, and charged to a vault only up to the rate its owner
  accepted (`acceptPlatformFee`).

Until the owner deploys it, new vaults are version 2; the server tells versions apart and sends version-2 vaults only
the calls they have. [`docs/MAINNET_CHECKLIST.md`](docs/MAINNET_CHECKLIST.md) lists what will be run and recorded here.

## What a user sees

- **Trade.** A coin's chart, from the exchange (HashKey Global) or from HSKSwap.
  - Under the chart: the agents doing well right now for that coin.
  - On HSKSwap: the pool's liquidity in blocks and six ready-made liquidity strategies.
- **Spread.** A tab under the chart compares the HSKSwap pool price with HashKey Global and shows what is left after
  the 0.3% pool fee, an assumed 0.1% exchange fee and the pool's price impact, for $10/$100/$1,000, with the
  break-even size and a recorded gap history (every 5 minutes, 14 days). Moving money between venues is not
  modelled and is said so. A "spread hunter" agent buys on HSKSwap when the pool is cheaper than the exchange by
  more than a round trip costs and sells when the gap closes; it shows no past result until a day of records exists.
- **Moa AI.** One agent per coin (BTC, ETH, HSK) whose decision is made by an AI model: every 4 hours it reads a
  snapshot of numbers (returns, averages, volatility, the HSKSwap pool against the exchange, HSK's on-chain flow) and
  answers with the share of the budget to hold and a reason. Code, not the model, sets the limits (see below). Every
  decision is recorded with a hash and is public: `/api/ai/decisions?asset=BTC`. It has no backtest and says so; its
  result is counted from its first recorded decision.
- **Agent market.** One card per agent: a mark, a plain one-line rule, and what 1,000,000 won (or $1,000) given to it
  would be now, with just holding the coin under it, for 3 months, 1 year or 3 years (one switch for the page).
  Agents are grouped, not ranked: Moa's default, the ones that beat holding, the calmer ones, classics, and a lab for
  experimental short-term agents (folded, with a warning). Agents come from published research (each cites its
  paper), classic rules, short-term versions on 1h/4h candles, and agents other people made and shared.
- **Make an agent.** Four short steps (coin, starting point, when to buy and sell, name), with the past result
  redrawn on every change. You can choose to check the price daily, every 4 hours or every hour.
- **Share an agent.** A made agent can be shared with a link. Others can hire it; the market shows the maker and a
  real hire count, and labels it "made by a person, not verified". New shares carry no creator fee for now: the fee
  path exists only in vault version 3, which is not deployed (see above).
- **My agents.** Each agent's money, holdings and profit or loss, a portfolio ring, and a running indicator.
- **Moa** sits on the right of every screen. It explains, recommends an agent, asks before each trade (or lets the
  agent run on its own), and reports.

## What is a model and what is not

- **Moa AI's decisions are made by a model** (Claude, through the Anthropic API): one call per coin per closed
  4-hour candle, answering in a fixed form (a target share from 0 to 1, a reason in English and Korean, the numbers
  it leaned on). The model never trades and never sees an instruction from outside: its input is numbers the server
  computed. **Code sets the limits** (`src/aiPilot.ts`, `server/aiPilot.ts`):
  - the target is clamped to 0–100% and rounded to 5%;
  - it moves at most 25 points per decision, and a change under 10 points is no change;
  - old data, a failed or late call, a refusal, or an answer that does not fit the form all mean "hold the last
    target", and are recorded as such;
  - orders go through the same path as every other agent: inside the agent's budget, the vault's per-trade and daily
    limits and its stop-loss, which the contract enforces;
  - `MOA_AI_TRADER=off` switches it off; without an API key it shows "AI not connected" and cannot be hired on auto.
- **Every other agent is a fixed rule, not a model.** An agent's rule is data (`src/spec.ts`, `src/agents.ts`).
  **Moa's recommendation is a fixed rule too** (`src/recommend.ts`): the default chosen in advance from the
  literature (a basket: half held, half a slow trend blend on BTC and ETH; plain daily buying on HSK), never a
  backtest winner and never a lab agent.
- **The chat uses Claude through the Anthropic API.** It answers questions and fills forms. It never places an
  order on its own: it can only propose one, and the order runs from the card's Confirm button, which carries a
  one-time signed ticket for that wallet and that exact order (5 minutes). Agents the user set to run on their own
  trade inside their budget and the vault's limits. The chat endpoint is same-origin only and rate-limited.

## Honest numbers

- Backtests are past results on daily candles over 3 years (90 days or 1 year for hourly and 4-hour agents). Every
  trade pays HSKSwap's 0.3% fee, the moving gap between the pool and the exchange price (measured from the pool's
  recent swaps, or a stated 0.5% when there are too few), and price impact from the pool's real depth at the
  hire-default size of a $100 budget. The detail view shows the same backtest at $1,000 and $10,000 and warns where
  the pools are too thin. Past results do not promise future ones.
- **The label "beat holding" is hard to earn.** An agent gets it only if, over the full window and after costs, its
  excess over holding clears a luck hurdle (excess Sharpe ≥ √(2·ln 30 / years): what the best of 30 agents with no
  skill would show), it beat holding in at least 2 of the 3 twelve-month blocks, and it held the coin at least a
  quarter of the time. **Today no agent on any coin earns it, and the app says so** instead of showing a winner.
- A walk-forward check of fourteen ways to pick an agent (pick with data before a date, score the next 90 days,
  monthly) found none that reliably beat holding. That is why Moa's default is fixed in advance and not picked from
  these backtests. The published strategies use their published parameters, not ones tuned on this data.
- Each backtest still shows its last three months separately in the detail view.
- Short-term agents (1h/4h) mostly lost money after costs. They sit in the lab, are never recommended, and can be
  hired only after ticking "it's experimental, hire it anyway".
- Each live order carries a keccak256 hash of the inputs it was decided on in the vault's trade note; the app shows
  those inputs and recomputes the hash.
- Lists are ordered by group, then by whether an agent is working now, then by the smaller worst drop. Moa has no
  usage or popularity data and does not claim any.

## Repository

```
hsk-agent/            the whole app (Render root directory)
  src/                React 19 + TypeScript app: screens, agents, rules, LP math
  server/             Node server: API, Moa AI and chat (Anthropic), sessions, auto runner, executor
  contracts/          MoaVault + MoaVaultFactory (Solidity), fork tests, mainnet scripts
  tests/ui/           screen checks (Playwright): every screen at 1440 and 390, key flows
docs/                 demo script, mainnet checklist
```

`hsk-agent/README.md` covers how to run it and the details of each part.
