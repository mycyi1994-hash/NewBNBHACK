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
  trades (`src/Dock.tsx`; the trades come from `marks` in `src/agents.ts`). The chart also draws the lines the rule
  itself looks at (its averages, its channel, its RSI levels) and shades the days it was holding. The backtest
  covers three years by default, so agents compare like for like and a slow rule has enough trades to judge; the
  panel can switch to one year or to all history, and says the result in one sentence before the numbers. HashKey's
  own candles only start at its listing dates (2024-05-29 for the BTC and ETH perpetuals), so the days before are
  Gate spot daily candles joined in front (`dailyHistory` in `src/agents.ts`); the join is marked on the chart and
  named under the backtest, and the joined days carry no volume. Hiring is a button on that backtest.
  Moa's agent card and the agent market open the same view ("See the backtest").
- **The leaderboard is per coin.** One coin's best agents on one chart, against just holding that coin (the dashed
  line); moving over the chart reads a day, best first, and the line under the pointer comes forward.
- **Two pages in the market.** "Top agents" ranks the agents that can trade (steady = Sharpe ratio, bold = period
  return) with their equity curves on one chart; "Marketplace" is the searchable, filterable card grid with a "Hire"
  button on every card. Both read `src/agents.ts`; nothing on them is invented (no creators, no subscriber counts).
- **Moa's briefing.** The conclusion for the coin on screen first, the numbers in one table, one leading choice that
  goes to an agent. Moving to another coin's chart gets that coin's briefing, and a choice always acts on the coin
  it names.
- **A backtest you can read and replay.** The result is in money ("put in 1,000,000 won → 1,455,000; just holding →
  840,000", amount selectable, dollars in English) with the same amounts on the curve. Tags read off the backtest
  say what kind of strategy it is (risk by worst drop, how often it trades, how long it holds; cut-offs in the
  tooltip), and "About this strategy" says who it suits, where it works and fails, its source, who has used it and
  how far it has been tested, with "no published test" stated where that is the case. "Replay" plays the backtest a
  daily candle at a time from 14 days before it starts (`src/replay.ts`): candles, the rule's lines, buys and sells,
  the money and the trade list all advance together; pause, seek and 1×/4×/16×.
- **Anyone can make an agent.** "Make an agent" is one screen: pick the coin, start from a published strategy and
  change its numbers, add conditions by hand, or describe the rule in a sentence; the backtest reruns on every
  change. A made rule is data, not code (`src/spec.ts`): a few conditions of the form "this is above/below that",
  run by one interpreter that decides on past days only, long-only, daily, one coin. The sentence reader is a fixed
  set of patterns, not a model, and says what it could not read. Twelve built-in strategies are expressible as this
  data and a test checks they decide identically. Made agents are saved per account (`src/madeStore.ts`; until
  sign-in exists the account is "guest", this browser), show under their coin's chart with the full backtest and
  replay, are labelled "made by you, no published test", and are hired through the same sheet as any agent: the
  same per-trade approval and the same vault limits apply.
- **Agents have names and faces.** Each rule has a short name and its own coloured mark ("BTC Turtle", "ETH
  Guardian"); the rule it follows and where the rule comes from stay beside it as the subtitle and the origin tag.
- **The vault is on screen, not in a footnote.** `src/VaultCard.tsx` shows the same vault three ways (sidebar,
  under Moa's input, the card on "My agents"): connected or demo, the per-trade limit, and a gauge of today's
  limit. An order waiting for approval is a card that names the agent, the trade, the reason, and the limits the
  contract will check; a fill is a receipt with a link to the HSK explorer. Without a vault the app says "Demo
  mode: orders are not sent", once and calmly.
- **One accent.** Primary actions are one filled blue button everywhere; green and red mean gain, loss, buy and
  sell and nothing else. Numbers use one format (a true minus sign, one decimal).
- **When data does not load, the screen says so.** The chart, the agents under it and the agent market each show
  what failed, in one line, with "Try again" (`StateBox` in `src/ui.tsx`); loading shows a spinner with words, not
  an empty box. RSI and the momentum rule's 12-month return are drawn in a pane of their own under the price chart,
  with their own axis, scrolling in step with it.
- **Moa never leaves you waiting.** Each model call is streamed and has a 90-second deadline with one retry
  (`server/moaAgent.ts`); the server sends a line every 5 seconds while it works, and the browser stops waiting after
  25 seconds of silence or 150 seconds in total and answers with the on-device parser, marked as offline.
- **Sizes follow the screen.** `src/styles.css` is written in the pixels measured at a 1440px screen; the build
  (`pxToRem` in `vite.config.ts`) turns them into rem and the root font size steps up on wider screens, so a 2560px
  monitor gets a slightly larger interface (15px base instead of 14px) instead of small type in a wide frame. Latin and digits are
  Google Sans Flex, Korean is Pretendard.
- **Twenty published strategies, and what stands behind each.** Nineteen position rules and plain dollar-cost
  averaging come from named, public sources (`src/agents.ts`, text in `src/ruleText.ts`): 12-month time-series
  momentum, the 1/3/12-month trend blend, dual momentum, the 10-month average rule, the golden cross, Turtle
  systems 1 and 2, Donchian's four-week rule and 5/20 averages, Allen's 4-9-18, MACD, Ichimoku, Keltner, Parabolic
  SAR, ADX, Aroon, short-horizon crypto momentum, Connors' RSI(2) and Double 7's. Each carries a proof level shown
  on the agent (`PROOF`): tested in a paper, a real trading record, published by its author, a widely followed
  signal, or no published test. What differs from the source (long only, daily checks, a parameter Moa had to
  choose) is said in the text, and nothing claims a fund runs these agents. The four indicator rules and three DCA
  variations without a public source wait behind "show more". Published strategies lead every default order.
- **The recommendation is a rule, not a model** (`src/recommend.ts`): only agents that can trade on HSKSwap → the coin
  on screen or named → risk 1–2 for first-timers, 1–3 otherwise → published classics before the rest → the smallest
  worst drop in the backtest (an agent that never traded in the window does not outrank one that did).
- **The hire sheet is the only place money settings change** (`src/HireSheet.tsx`): amount per buy, total budget,
  "asks me before each trade", the vault limits. Hiring from the market, from Moa's card, from a plan Moa drafted,
  and changing the amount later all open this sheet.
- **Ask before each trade** (`src/runner.ts`): while the app is open, each hired agent's rule decides its next order
  (position agents buy when their signal turns on and sell when it turns off; collect agents buy once a day; custom
  plans follow their steps, stop-loss and take-profit first). Moa asks; "Buy $10" sends it to the vault through
  `/api/agent-trade`, "Skip this time" records the skip. No model is involved in that path.
- **Pause** is a button on each chip in the bar and works without Moa or the AI.
- **Same agent, same numbers.** `src/agents.ts` scores every agent once, over the same last three years (or all a younger coin has); the market,
  the agents under the chart, Moa's cards and the server tool all read it.

## Status

| Part | State |
| --- | --- |
| Web app (trade, agent market, my agents, Moa on every screen) | Working |
| Market data: HashKey Global candles, HSKSwap pool price from HSK Chain mainnet (chain 177), Gate spot | Live |
| Agents (`src/agents.ts`) | 47 agents: 27 can be hired (BTC, ETH, HSK on HSKSwap; 0.3% fee in the backtest), 20 "signal only" for coins HSKSwap does not list (**demo**, 0.1% fee) |
| Moa's brain (`server/moaAgent.ts`) | Claude Sonnet 5.5, tools `get_market`, `propose_plan`, `recommend_agent`, `execute_trade`. Falls back to the on-device parser when the API is unreachable. Agent requests (pick one, stop, how is it doing) are answered without the AI |
| Account (`src/account.ts`, `src/Account.tsx`, `server/session.ts`) | **Log in** at the top right with a wallet: one free signature, no transaction. The account shows a nickname and the address; its menu shows the wallet's own vault with **Deposit** and **Withdraw**, both sent by the user's wallet. Made agents, hired agents and trade history are kept per wallet (per browser before logging in) |
| Hired agents | Saved in this browser under the logged-in wallet. Ask before each trade while the app is open |
| Vaults (`contracts/src/MoaVaultFactory.sol`, `contracts/src/MoaVault.sol`) | One vault per user. The factory makes it when the wallet first logs in; the server pays the gas, the wallet is the owner and signs nothing. Each vault enforces a per-trade cap, a per-day cap and a slippage floor, and only its owner can withdraw. Tested on a local fork of HSK mainnet (22 checks). **The factory is on HSK Chain mainnet** (26 Nov 2026): [`0x49807417fcebfb90e59933f0c44e4f1edf96444c`](https://hsk.blockscout.com/address/0x49807417fcebfb90e59933f0c44e4f1edf96444c), [deployment transaction](https://hsk.blockscout.com/tx/0xedb6a15b62c220ccd46df7927685de73fa516e1fb76ad1c220a5c4c4e37f6ebf). Unaudited |
| Execution (`server/executor.ts`) | Approved agent orders and “실행”/“execute” in the chat go to the vault of the wallet that is logged in, and only with that wallet's session; an order without one is refused. Not logged in, or on a server without a factory, the app is a **demo**: agents ask, nothing is sent |
| Pause | In the app it stops new orders. Locking a vault on-chain is the owner's `pause` (`contracts/scripts/vault.mjs`) |

UI reference: Google AI Studio web (via Mobbin). `src/styles.css` is built from measured captures: 208px sidebar, hairlines, 14/20 type, outlined buttons, grey selected chips with a dot, blue links and assistant marks. The layout (sidebar, screen, Moa on the right) is Moa's own.

## Run

Put the server-side secrets in `.env.local` (git-ignored):

```
ANTHROPIC_API_KEY=...
# optional: real vaults. The factory makes one vault per logged-in wallet; the agent key trades for them.
MOA_FACTORY_ADDRESS=0x...
MOA_AGENT_PRIVATE_KEY=0x...
MOA_RPC_URL=https://mainnet.hsk.xyz
# optional: MOA_MAX_VAULTS_PER_DAY=20 (vaults this server pays to make per day), MOA_SESSION_SECRET=...
```

```bash
npm install
npm run dev      # http://127.0.0.1:5180
npm test         # parser, agent scoring, recommend rule, runner and login-session tests
npm run build
```

### Deploy the vaults to HSK Chain mainnet

[`contracts/MAINNET.md`](contracts/MAINNET.md) has the steps: make the agent key, dry run, deploy the factory (one
transaction), publish the source on the explorer, then log in to the app, deposit and trade. The scripts check every
address on-chain before sending, show the plan and gas cost first, and ask for a typed word before each transaction.
The deploying wallet's key is typed into a hidden prompt and is never stored.

### Try execution on a local fork of HSK mainnet (no real funds)

```bash
cd contracts && npm install && node scripts/compile.cjs
node --experimental-strip-types scripts/fork-test.mjs      # factory, vault and executor checks
npx hardhat node --port 8546 &                              # keep running
node scripts/fork-setup.mjs                                 # deploys the factory, gives a test wallet 500 USDT, writes ../.env.fork.local
cd .. && npx vite --mode fork                               # log in with the first Hardhat test account (add the fork to your wallet as chain 177, RPC http://127.0.0.1:8546), deposit, then hire an agent and approve its first buy
```
