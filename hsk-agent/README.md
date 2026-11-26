# Moa — AI money assistant on HSK Chain

Entry for the HSK Chain Horizon Hackathon · Seoul (AI Agent Trading track).

Moa watches the coin market with you, picks a trading agent that fits you, and hands it the job. Each agent follows
one fixed rule on one coin, asks you before every trade, and trades from your own vault on HSKSwap inside limits the
vault contract enforces.

## How the screen is organised

| | Agent market (left menu) | Moa (right, on every screen) | My agents (bar on top + page) |
| --- | --- | --- | --- |
| Job | Shows which agents exist, with their backtests | Explains, recommends, asks before each trade, reports | Shows what each hired agent is doing now |
| The user | Browses, compares, saves | Asks, approves | Watches, pauses |
| Never does | Set amounts or trade | Trade on its own, invent numbers, store settings | Recommend or explain |
| AI | None (backtests only) | Classifies free text and answers general questions | None (rules only) |

- **One conversation.** Moa sits on the right of every screen and keeps the same conversation when you move between
  screens. On screens under 1180px it slides up as a sheet.
- **From the conversation to an agent.** "Can you buy for me?", "pick one for me", the bar's "Get a pick from Moa",
  or the AI's `recommend_agent` tool all end in the same agent card inside the conversation, with "Hire",
  "Other agents" and "Why this one?". You never have to open the market to hire.
- **The trade screen is one screen.** Market and price on top, the chart in the middle, and under it a panel with
  the agents for that market. Picking an agent moves no money: the chart switches to daily candles and marks every
  buy and sell of its backtest, and the panel shows the result against just holding, the two curves and the list of
  trades (`src/Dock.tsx`; the trades come from `marks` in `src/agents.ts`). Hiring is a button on that backtest.
  Moa's agent card and the agent market open the same view ("See the backtest").
- **Two pages in the market.** "Top agents" ranks the agents that can trade (steady = Sharpe ratio, bold = period
  return) with their equity curves on one chart; "Marketplace" is the searchable, filterable card grid with a "Hire"
  button on every card. Both read `src/agents.ts`; nothing on them is invented (no creators, no subscriber counts).
- **Moa's briefing.** The conclusion for the coin on screen first, the numbers in one table, one leading choice that
  goes to an agent. Moving to another coin's chart gets that coin's briefing, and a choice always acts on the coin
  it names.
- **Sizes follow the screen.** `src/styles.css` is written in the pixels measured at a 1440px screen; the build
  (`pxToRem` in `vite.config.ts`) turns them into rem and the root font size steps up on wider screens, so a 2560px
  monitor gets a proportionally larger interface instead of small type in a wide frame. Latin and digits are
  Google Sans Flex, Korean is Pretendard.
- **The recommendation is a rule, not a model** (`src/recommend.ts`): only agents that can trade on HSKSwap → the coin
  on screen or named → risk 1–2 for first-timers, 1–3 otherwise → the smallest worst drop in the backtest.
  The AI only says which coin the user means.
- **The hire sheet is the only place money settings change** (`src/HireSheet.tsx`): amount per buy, total budget,
  "asks me before each trade", the vault limits. Hiring from the market, from Moa's card, from a plan Moa drafted,
  and changing the amount later all open this sheet.
- **Ask before each trade** (`src/runner.ts`): while the app is open, each hired agent's rule decides its next order
  (position agents buy when their signal turns on and sell when it turns off; collect agents buy once a day; custom
  plans follow their steps, stop-loss and take-profit first). Moa asks; "Buy $10" sends it to the vault through
  `/api/agent-trade`, "Skip this time" records the skip. No model is involved in that path.
- **Pause** is a button on each chip in the bar and works without Moa or the AI.
- **Same agent, same numbers.** `src/agents.ts` scores every agent once, over the same last 365 days; the market,
  the agents under the chart, Moa's cards and the server tool all read it.

## Status

| Part | State |
| --- | --- |
| Web app (trade, agent market, my agents, Moa on every screen) | Working |
| Market data: HashKey Global candles, HSKSwap pool price from HSK Chain mainnet (chain 177), Gate spot | Live |
| Agents (`src/agents.ts`) | 47 agents: 27 can be hired (BTC, ETH, HSK on HSKSwap; 0.3% fee in the backtest), 20 "signal only" for coins HSKSwap does not list (**demo**, 0.1% fee) |
| Moa's brain (`server/moaAgent.ts`) | Claude Sonnet 5.5, tools `get_market`, `propose_plan`, `recommend_agent`, `execute_trade`. Falls back to the on-device parser when the API is unreachable. Agent requests (pick one, stop, how is it doing) are answered without the AI |
| Hired agents | Saved in this browser. Ask before each trade while the app is open. Running with the app closed comes with the mainnet vault |
| Execution (`server/executor.ts`, `contracts/src/MoaVault.sol`) | Approved agent orders and “실행”/“execute” in the chat. The vault enforces per-trade and daily caps, a slippage floor and owner-only withdrawals. Tested end to end on a local fork of HSK mainnet; **not deployed to mainnet yet**. Without a vault the app is a **demo**: agents ask, nothing is sent |
| Pause | In the app it stops new orders. Locking the vault and withdrawing are done from the vault owner's wallet (**demo** until the mainnet vault) |

UI reference: Google AI Studio web (via Mobbin). `src/styles.css` is built from measured captures: 208px sidebar, hairlines, 14/20 type, outlined buttons, grey selected chips with a dot, blue links and assistant marks. The layout (sidebar, screen, Moa on the right) is Moa's own.

## Run

Put the server-side secrets in `.env.local` (git-ignored):

```
ANTHROPIC_API_KEY=...
# optional: execute through a deployed MoaVault
MOA_VAULT_ADDRESS=0x...
MOA_AGENT_PRIVATE_KEY=0x...
MOA_RPC_URL=https://mainnet.hsk.xyz
```

```bash
npm install
npm run dev      # http://127.0.0.1:5180
npm test         # parser, agent scoring, recommend rule and runner tests
npm run build
```

### Try execution on a local fork of HSK mainnet (no real funds)

```bash
cd contracts && npm install && node scripts/compile.cjs
node --experimental-strip-types scripts/fork-test.mjs      # vault + executor checks
npx hardhat node --port 8546 &                              # keep running
node scripts/fork-setup.mjs                                 # deploys a funded test vault, writes ../.env.fork.local
cd .. && npx vite --mode fork                               # hire a collect agent and approve its first buy, or chat “ETH 15달러어치 지금 실행해줘”
```
