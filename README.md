# Moa: AI trading agents for beginners, on HSK Chain

Moa is an entry for the **HSK Chain Horizon Hackathon · Seoul, Track 1 (AI Agent Trading)**.

Moa lets people who have never traded do three things:
- give a trading agent a small amount of money and let it work;
- see in plain words what that agent does;
- stop it or take the money out at any time.

Every agent follows one fixed rule on one coin. It trades on HSKSwap from **the user's own vault**: a contract on
HSK Chain that only the user can withdraw from, with the user's limits and stop-loss enforced on-chain.

**Live app:** https://grabitmoa.onrender.com

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
| A user's vault, made by the factory when that wallet logged in | [`0x6A355aE335f06971C337c900783C2e016410b33C`](https://hsk.blockscout.com/address/0x6A355aE335f06971C337c900783C2e016410b33C) · [creation tx](https://hsk.blockscout.com/tx/0x3b69260d046140866ca1b5429c625c69e9a5f1cf93efd3c54c5d84f60f1afb0b) |
| First trade through a vault ($1 of WBTC on HSKSwap; an earlier vault version) | [tx](https://hsk.blockscout.com/tx/0x955cd89b5e89200d606300df1afeca3c3adb337c200e6743af7b64595c2441ee) |
| Agent wallet (may call `trade` and `stopOut` only; cannot withdraw) | [`0x8C35f99f3c0D210EA54fe4AF68d5f548cCCC1bAE`](https://hsk.blockscout.com/address/0x8C35f99f3c0D210EA54fe4AF68d5f548cCCC1bAE) |

**Not yet done on mainnet** with the current version:
- an agent trade;
- a stop-loss;
- a liquidity supply.

They have been run on a local fork of mainnet only (scripts in `hsk-agent/contracts/scripts/`). The contracts are
**unaudited**. [`docs/MAINNET_CHECKLIST.md`](docs/MAINNET_CHECKLIST.md) lists what will be run and recorded here.

## What a user sees

- **Trade.** A coin's chart, from the exchange (HashKey Global) or from HSKSwap.
  - Under the chart: the agents doing well right now for that coin.
  - On HSKSwap: the pool's liquidity in blocks and six ready-made liquidity strategies.
- **Agent market.** One card per agent: a mark, a plain one-line rule, and one number (how it did against simply
  holding the coin), plus a ranking by coin.
- **Make an agent.** Four short steps (coin, starting point, when to buy and sell, name), with the past result
  redrawn on every change. You can choose to check the price daily, every 4 hours or every hour.
- **My agents.** Each agent's money, holdings and profit or loss, a portfolio ring, and a running indicator.
- **Moa** sits on the right of every screen. It explains, recommends an agent, asks before each trade (or lets the
  agent run on its own), and reports.

## What is a model and what is not

- **Trading decisions are fixed rules, not a model.** An agent's rule is data (`src/spec.ts`, `src/agents.ts`).
  Moa's pick is a fixed order (`src/recommend.ts`):
  1. agents working now (holding, or traded in the last 30 days);
  2. among those, the ones that made more than just holding;
  3. the smallest worst fall.
- **The chat uses Claude through the Anthropic API.** It answers questions and fills forms. It never places an
  order on its own; an order needs the user's OK or an agent the user set to run on its own.

## Honest numbers

- Backtests are past results on daily candles over 3 years (90 days or 1 year for hourly and 4-hour agents), with
  a 0.3% fee per trade and no slippage. Past results do not promise future ones.
- Over the last 3 years, simply holding BTC returned about +62%. **Most agents did not beat that.** The ones that
  did are shown first, and every card states its number against holding.
- Rankings are ordered by these backtests and by recent activity. Moa has no usage or popularity data and does not
  claim any.

## Repository

```
hsk-agent/            the whole app (Render root directory)
  src/                React 19 + TypeScript app: screens, agents, rules, LP math
  server/             Node server: API, Moa chat (Anthropic), sessions, auto runner, executor
  contracts/          MoaVault + MoaVaultFactory (Solidity), fork tests, mainnet scripts
docs/                 demo script, mainnet checklist
```

`hsk-agent/README.md` covers how to run it and the details of each part.
