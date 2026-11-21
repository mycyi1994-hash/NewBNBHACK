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
| Goal → plan parser (`src/intent.ts`) | Rule-based, tested; an LLM stage will produce the same `Plan` shape |
| Bots | Saved in the browser as drafts |
| On-chain execution (vault contract, HSKSwap swaps) | Not built yet: no trades are sent |

UI reference: Hume AI web app (via Mobbin).

## Run

```bash
npm install
npm run dev      # http://127.0.0.1:5180
npm test         # parser tests
npm run build
```
