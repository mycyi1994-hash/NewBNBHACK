# Moa app: how it works and how to run it

See the [root README](../README.md) for what Moa is, what is on mainnet, and where the code comes from.

## Run

Server-side secrets go in `.env.local` (git-ignored):

```
ANTHROPIC_API_KEY=...            # Moa AI's decisions and Moa's chat; without it Moa AI is off and the chat uses the on-device parser
# optional: MOA_AI_TRADER=off      # switch Moa AI off (it holds its last target; nothing follows it)
# optional: real vaults. The factory makes one vault per logged-in wallet; the agent key trades for them.
MOA_FACTORY_ADDRESS=0x...
MOA_AGENT_PRIVATE_KEY=0x...
MOA_RPC_URL=https://mainnet.hsk.xyz
# optional: MOA_DATA_DIR, MOA_SESSION_SECRET, MOA_MAX_VAULTS_PER_DAY
```

```bash
npm install
npm run dev        # http://127.0.0.1:5180
npm test           # rules, backtests, fills, journal, spread, recommendation, runner, sessions, auto runner, sharing, moving vaults, LP math
npm run test:ui    # screen checks: starts the built server in demo mode and runs Playwright (needs Playwright installed)
npm run lint:css   # reports CSS selectors no source file uses
npm run build      # typecheck + production build
npm start          # production server (after build); see DEPLOY.md
```

Without a factory address, or before a wallet logs in, the app is a **demo**: agents ask, nothing is sent.

## Parts

| Part | Files | Notes |
| --- | --- | --- |
| Agents and backtests | `src/agents.ts`, `src/spec.ts`, `src/ruleText.ts` | Each agent is one rule on one coin, scored on 3 years of daily candles (HashKey Global; Gate spot joined in front where HashKey's history is shorter, marked on the chart). Made agents may use 4-hour or hourly candles (1 year / 90 days). Every trade pays the 0.3% pool fee, the pool's gap to the exchange and price impact (`src/fills.ts`, below). |
| Moa AI | `src/aiPilot.ts`, `server/aiPilot.ts`, `server/aiStore.ts`, `src/AiPanel.tsx` | One agent per coin (BTC, ETH, HSK). Once per closed 4-hour candle the server builds a snapshot of numbers and asks Claude for a target share (structured output: target, reason in two languages, signals). Limits in code: clamp 0–1, round to 5%, at most 25 points per decision, a 10-point band, a cool-down; stale data, a failed or late call, a refusal, a cut-off or malformed answer all hold the last target. Decisions are stored with a keccak256 hash in `MOA_DATA_DIR/ai-decisions.json` and served at `GET /api/ai/decisions?asset=`; the chat has a `get_ai_decision` tool. Orders use the weight path every research agent uses (budget, band, the vault's limits). No backtest: a paper result from the first decision. |
| Recommendation | `src/recommend.ts` | A fixed rule, no model. 1. Agents that can trade on HSKSwap, for the coin asked about. 2. The coin's default, chosen in advance from the literature: the basket (half held, half × the share of positive 3/6/12-month returns, read monthly) on BTC and ETH, daily buying on HSK. 3. If already hired, the next in list order within the user's risk level. Lab agents are never recommended. |
| Agent list cache | `server/agentCache.ts`, `src/agentWire.ts`, `src/agentsClient.ts` | The server scores every agent every 5 minutes and serves the lists at `GET /api/agents` with the time they were scored; the browser shows "as of N min ago" and scores the list itself only if the server does not answer in 8 seconds. A user's own made agents are always scored in the browser. |
| Making an agent | `src/Builder.tsx`, `src/madeStore.ts` | The rule is data ("this is above/below that"), read by one interpreter that decides on past candles only, long only. A sentence reader with fixed patterns (no model) can start one. |
| Research-based agents | `src/agents.ts`, `src/quantText.ts`, `src/shortText.ts` | Volatility-targeted holding, a Donchian ensemble, multi-horizon momentum, core plus trend, a moving-average ensemble, a breakout with a 3×ATR trailing stop, and that stop added to Turtle/Donchian, with published parameters and the paper cited on each. These hold a share of their budget and rebalance when the target moves past a band (10–15 points); a buy never goes past the agent's budget or the vault's per-trade limit. Short-term versions run on 1h/4h candles and are labelled as Moa's versions with no published test. |
| Sharing | `src/share.ts`, `src/Shared.tsx`, `server/shareStore.ts` | A made agent can be published with a link and a creator fee (0–1%). A fee can be asked only where the server's current factory makes version-3 vaults, which can pay it (`creatorFees` in `/api/terms`); otherwise the picker is not shown and the server refuses a fee. The server stores the rule (checked with the same validator), the name, the creator's wallet from the login session, the fee and a real hire count, in `MOA_DATA_DIR/shared.json`. Limits: 40-character names, 10 live and 50 total shares per wallet. |
| Hiring and running | `src/HireSheet.tsx`, `src/runner.ts`, `server/autoRunner.ts` | **Asks first:** each order waits for the user's OK while the app is open. **On its own:** the server checks every 5 minutes, on the agent's own candle interval, and sends orders inside the agent's budget and the vault's limits. |
| Vault and execution | `contracts/src/MoaVault.sol`, `contracts/src/MoaVaultFactory.sol`, `server/executor.ts` | One vault per user. Only the owner withdraws. The agent key may only `trade` (USDT ↔ WHSK/WETH/WBTC on HSKSwap) and `stopOut`. Per-trade and per-day limits, and a worst accepted price. Version 3 (factory on mainnet since 28 Nov 2026; `contracts/MAINNET.md`, *Version 3 hardening*): a price floor from the pool's 10-minute average; vaults start with $50 per trade, $100 a day and a 15% stop-loss the owner can change; the agent key works only inside a **session** the owner sets per vault (until a date, on chosen coins, at most so much per buy) and can revoke; optional on-chain budgets per hired agent; a factory guardian that can halt agent trading everywhere (never funds); creator fees approved per hired agent (at most 1%); a platform-fee switch that is 0 and can never exceed 0.2%. The executor reads each vault's version and session and never sends a call the vault lacks or a trade its session does not cover. Anyone may trigger a due stop-loss, which is refused while the pool price is away from its 10-minute average. Orders go only to the logged-in wallet's vault. |
| Runner status | `server/autoRunner.ts`, `src/RunnerPanel.tsx` | `GET /api/auto/status`: whether the auto runner is alive, its last and next check, and errors, for anyone; each agent's last decision and reason only for its own logged-in wallet. Shown on My agents and in the vault view. |
| Chat orders and vault changes | `src/chatOrders.ts`, `POST /api/moa/propose` | "BTC 1달러 사줘" becomes a proposed order with a one-time ticket, run only from the card's Confirm. "하루 한도 30달러로", "손절 10%로", "잠가줘" become a card the owner's wallet signs (`setLimits` / `setStopLoss` / `setPaused`); Moa never signs. Works without the AI. |
| Moa (chat) | `server/moaAgent.ts`, `src/MoaFeed.tsx` | Claude through the Anthropic API, with tools to read the market, recommend an agent, draft a plan, set a liquidity plan, read Moa AI's decisions, and propose a trade. A proposed trade runs only from the card's Confirm button, which carries a one-time signed ticket for that wallet and that exact order. Answers stream; on timeout the browser answers with the on-device parser, marked offline. |
| Liquidity on HSKSwap | `src/lp.ts`, `src/LpStudio.tsx`, `src/LpBlocks.tsx`, `src/lpStrategies.ts`, `src/lpAmount.ts` | Liquidity in blocks: each block is one Uniswap V3 position through HSKSwap's own position manager (`0xDF0A9b83…0cad5`), all minted in one transaction from the user's wallet after exact-amount approvals. Six ready-made strategies (no past or expected returns shown), three plain questions, or a block-by-block editor. Positions can be collected or removed. |
| Spread | `src/spread.ts`, `src/SpreadPanel.tsx`, `server/spreadStore.ts` | Pool price vs HashKey Global (Gate as fallback): gross gap, net after the pool fee, an assumed 0.1% exchange fee and price impact, break-even size. The server records the gap every 5 minutes for 14 days (`/api/spread`); Moa has a `get_spread` tool. The spread hunter agent trades on HSKSwap only. |
| HSK on-chain watch | `src/onchain.ts`, `src/OnchainPanel.tsx`, `server/onchainStore.ts` | The server reads the WHSK/USDT pool's Swap logs from HSK Chain (30 days on the first read, then new blocks every 10 minutes) and the liquidity within ±2%; `/api/onchain`. A watch signal in its own tab and in Moa's market answer, not a hireable agent: 30 days is too short to backtest. |
| Pool depth | `src/depth.ts`, `src/dex.ts` | Read from the pool's price, in-range liquidity and initialized ticks on HSK Chain (chain 177). |
| Heatmap | `src/ChartExtras.tsx`, `server/nanoFrame.ts` | The "Heatmap" switch shows the fire chart of nanotradingclub, a separate project by the same author, in a frame from its development site. The server reads that site's frame headers and links out instead when framing is not allowed. |
| Vault view and trust page | `src/VaultView.tsx`, `src/vaultRead.ts`, `src/Trust.tsx` | `?vault=0x…` shows any vault's holdings, limits, stop-loss and history (HSK Chain RPC + Blockscout, read in the browser) without login. `?trust` explains who earns what (no platform fee), custody, and the risks, with live pool depth. |
| Account | `src/account.ts`, `server/session.ts` | Login is one wallet signature (no transaction). The server pays the gas to make the user's vault. |
| Moving to a new vault | `src/move.ts`, `src/MoveVault.tsx`, `server/executor.ts` (`moveStatus`, `upgradeVault`) | Vaults cannot be upgraded. A wallet whose vault an earlier factory made is shown one card with three steps: Moa makes the new vault (`POST /api/vault/upgrade`, no signature), the owner takes everything out of the old one and puts the USDT into the new one (two wallet confirmations when it holds only USDT). The step that is waiting is read from the chain (`GET /api/vault`: `upgrade`, `moved`, `old`), so it survives a closed tab; an old vault that still holds anything stays on screen. Only USDT is moved: a coin sent into a vault has no cost on its books, so the stop-loss would not cover it. The wallet's agents on auto are paused, with the reason, until the owner resumes them. `contracts/MAINNET.md`, *Moving an existing wallet to a new vault*. |

## How agents are scored (and what "beats holding" means)

- **Fills** (`src/fills.ts`): each trade pays, per side, the 0.3% HSKSwap fee, the pool's moving gap to the exchange
  (measured from the pool's own swaps, or a stated 0.5% when there are too few), and price impact from the pool's real
  depth at a $100 budget. The detail view repeats the backtest at $1,000 and $10,000 and flags where impact passes 1%.
- **Three parts of every backtest** (`run` in `src/agents.ts`): the early part; the year that ends three months ago;
  and the last twelfth (about three months of three years), shown on its own in the detail view.
- **One definition of "beats holding"** (`beatsHold`, `holdTest`): over the full window, net of costs, the excess
  over holding clears the luck hurdle (annualised excess Sharpe ≥ √(2·ln 30 / years)), the agent beat holding in at
  least 2 of the 3 twelve-month blocks, and it held the coin at least 25% of the time on average. No agent passes
  today; the lists then show one line saying so.
- **Tiers, not ranks** (`tierOf`): default, ahead (passes the rule above), calmer (a smaller worst drop than holding
  while holding the coin at least a quarter of the time), classic, lab (hourly and 4-hour agents and the 7/28/91-day
  momentum agent; hired only after an explicit confirmation). Inside a tier: working now first, then the smaller
  worst drop.
- **Cards show money for a period** (`src/Perf.tsx`, `periodResult`): what a stake would be now over 3 months, 1 year
  or 3 years, with holding under it.
- **Nothing is picked from these backtests.** The label rule reads the whole window; Moa's default was fixed in
  advance, so no data is held back for it.
- No rule's numbers were tuned on this data (published or standard settings); agents users build are flagged as
  possibly tuned by hand.

## Contracts on a local fork of mainnet (no real funds)

```bash
cd contracts && npm install && node scripts/compile.cjs
node --experimental-strip-types scripts/fork-test.mjs     # vault and factory checks
node --experimental-strip-types scripts/fee-fork-test.mjs # creator and platform fees, budgets (version 3) and the version-2 path
node --experimental-strip-types scripts/upgrade-fork-test.mjs # moving a wallet from a version-2 vault to a version-3 vault
node --experimental-strip-types scripts/fuzz-fork-test.mjs # random steps against a model of the vault (FUZZ_RUNS, FUZZ_SEED)
sh scripts/foundry-setup.sh && forge test                  # Solidity unit and invariant tests (Foundry), mock pool
node scripts/lp-fork-test.mjs                              # liquidity blocks: mint, earn fees, collect, remove
npx hardhat node --port 8546 &                             # then: node scripts/fork-setup.mjs; cd .. && npx vite --mode fork
```

Mainnet deployment steps: [`contracts/MAINNET.md`](contracts/MAINNET.md). The scripts check every address on-chain,
show the plan and gas first, and ask for a typed word before each transaction. Keys are typed into a hidden prompt
and never stored.

## Deploy

[`DEPLOY.md`](DEPLOY.md) (Render, root directory `hsk-agent`). The service has a persistent disk, so each deploy
takes it offline for a minute or two.
