# Moa app: how it works and how to run it

See the [root README](../README.md) for what Moa is, what is on mainnet, and where the code comes from.

## Run

Server-side secrets go in `.env.local` (git-ignored):

```
ANTHROPIC_API_KEY=...            # Moa's chat; without it the chat falls back to the on-device parser
# optional: real vaults. The factory makes one vault per logged-in wallet; the agent key trades for them.
MOA_FACTORY_ADDRESS=0x...
MOA_AGENT_PRIVATE_KEY=0x...
MOA_RPC_URL=https://mainnet.hsk.xyz
# optional: MOA_DATA_DIR, MOA_SESSION_SECRET, MOA_MAX_VAULTS_PER_DAY
```

```bash
npm install
npm run dev        # http://127.0.0.1:5180
npm test           # rules, backtests, recommendation, runner, sessions, auto runner, LP math
npm run build      # typecheck + production build
npm start          # production server (after build); see DEPLOY.md
```

Without a factory address, or before a wallet logs in, the app is a **demo**: agents ask, nothing is sent.

## Parts

| Part | Files | Notes |
| --- | --- | --- |
| Agents and backtests | `src/agents.ts`, `src/spec.ts`, `src/ruleText.ts` | Each agent is one rule on one coin, scored on 3 years of daily candles (HashKey Global; Gate spot joined in front where HashKey's history is shorter, marked on the chart). Made agents may use 4-hour or hourly candles (1 year / 90 days). 0.3% fee per trade on HSKSwap, no slippage modelled. |
| Recommendation | `src/recommend.ts` | A fixed order, no model. 1. Agents that can trade on HSKSwap, for the coin asked about. 2. Risk the user's level allows. 3. Working now. 4. Beat just holding. 5. Published classics first. 6. Smallest worst fall. Agents the user already hired are skipped when another fits. |
| Making an agent | `src/Builder.tsx`, `src/madeStore.ts` | The rule is data ("this is above/below that"), read by one interpreter that decides on past candles only, long only. A sentence reader with fixed patterns (no model) can start one. |
| Hiring and running | `src/HireSheet.tsx`, `src/runner.ts`, `server/autoRunner.ts` | **Asks first:** each order waits for the user's OK while the app is open. **On its own:** the server checks every 5 minutes, on the agent's own candle interval, and sends orders inside the agent's budget and the vault's limits. |
| Vault and execution | `contracts/src/MoaVault.sol`, `contracts/src/MoaVaultFactory.sol`, `server/executor.ts` | One vault per user. Only the owner withdraws. The agent key may only `trade` (USDT ↔ WHSK/WETH/WBTC on HSKSwap) and `stopOut`. Per-trade and per-day limits, and a worst accepted price. Anyone may trigger a due stop-loss, which is refused while the pool price is away from its 10-minute average. Orders go only to the logged-in wallet's vault. |
| Moa (chat) | `server/moaAgent.ts`, `src/MoaFeed.tsx` | Claude through the Anthropic API, with tools to read the market, recommend an agent, draft a plan, set a liquidity plan, and execute a trade. Execution needs the user's explicit "실행"/"execute" in that message. Answers stream; on timeout the browser answers with the on-device parser, marked offline. |
| Liquidity on HSKSwap | `src/lp.ts`, `src/LpStudio.tsx`, `src/LpBlocks.tsx`, `src/lpStrategies.ts`, `src/lpAmount.ts` | Liquidity in blocks: each block is one Uniswap V3 position through HSKSwap's own position manager (`0xDF0A9b83…0cad5`), all minted in one transaction from the user's wallet after exact-amount approvals. Six ready-made strategies (no past or expected returns shown), three plain questions, or a block-by-block editor. Positions can be collected or removed. |
| Pool depth | `src/depth.ts`, `src/dex.ts` | Read from the pool's price, in-range liquidity and initialized ticks on HSK Chain (chain 177). |
| Heatmap | `src/ChartExtras.tsx`, `server/nanoFrame.ts` | The "Heatmap" switch shows the fire chart of nanotradingclub, a separate project by the same author, in a frame from its development site. The server reads that site's frame headers and links out instead when framing is not allowed. |
| Account | `src/account.ts`, `server/session.ts` | Login is one wallet signature (no transaction). The server pays the gas to make the user's vault. |

## Contracts on a local fork of mainnet (no real funds)

```bash
cd contracts && npm install && node scripts/compile.cjs
node --experimental-strip-types scripts/fork-test.mjs     # vault and factory checks
node scripts/lp-fork-test.mjs                              # liquidity blocks: mint, earn fees, collect, remove
npx hardhat node --port 8546 &                             # then: node scripts/fork-setup.mjs; cd .. && npx vite --mode fork
```

Mainnet deployment steps: [`contracts/MAINNET.md`](contracts/MAINNET.md). The scripts check every address on-chain,
show the plan and gas first, and ask for a typed word before each transaction. Keys are typed into a hidden prompt
and never stored.

## Deploy

[`DEPLOY.md`](DEPLOY.md) (Render, root directory `hsk-agent`). The service has a persistent disk, so each deploy
takes it offline for a minute or two.
