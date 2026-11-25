# Moa — AI money assistant on HSK Chain

Entry for the HSK Chain Horizon Hackathon · Seoul (AI Agent Trading track).

Tell Moa the result you want ("Collect $10 of HSK every day for 2 weeks, sell half if it drops 15%, then stake idle USDT").
Moa turns it into a plan of steps (collect, protect, take profit, earn), asks when something is missing, and creates a bot
that owns that goal.

## Status

| Part | State |
| --- | --- |
| Web app (home, Ask Moa chat + plan panel, bots, markets) | Working |
| Market data: HSKSwap pool price read from HSK Chain mainnet (chain 177) + Gate spot price | Live, refreshed every 30 s |
| Moa's brain (`server/moaAgent.ts`) | Claude Sonnet 5.5, effort high, tools: `get_market`, `propose_plan`, `execute_trade`. Falls back to the on-device parser (`src/intent.ts`) when the API is unreachable |
| Execution (`server/executor.ts`, `contracts/src/MoaVault.sol`) | Runs only when the user's latest message says “실행” / “execute”. The vault enforces a per-trade cap, a daily cap, a slippage floor and owner-only withdrawals. Tested end to end on a local fork of HSK mainnet (11/11 checks pass); **not deployed to mainnet yet** |
| Bots | Saved in the browser as drafts |

UI reference: Hume AI web app (via Mobbin).

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
npm test         # parser tests
npm run build
```

### Try execution on a local fork of HSK mainnet (no real funds)

```bash
cd contracts && npm install && node scripts/compile.cjs
node --experimental-strip-types scripts/fork-test.mjs      # vault + executor checks
npx hardhat node --port 8546 &                              # keep running
node scripts/fork-setup.mjs                                 # deploys a funded test vault, writes ../.env.fork.local
cd .. && npx vite --mode fork                               # chat “ETH 15달러어치 지금 실행해줘”
```
