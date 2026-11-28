# Pitch: Moa in four boxes

For the HSK Chain Horizon Hackathon · Seoul, Track 1 (AI Agent Trading). Each box is one slide and about 40 seconds.
Say only what the app and the chain show. Facts and links are in the [README](../README.md).

## 1. Problem

- A beginner cannot judge a trading bot. Most bots show a backtest winner and hide that it rarely beats just holding.
- Handing money to an AI means trusting two things at once: its judgement and its access to your funds.
- On a young chain the pools are thin, so costs decide the result, and most tools ignore them.

**One line:** people need an AI agent they can read, limit and stop, on a chain where they keep the keys.

## 2. Technical features

| What | How | Where to look |
| --- | --- | --- |
| An AI makes the trading decision | Every 4 hours a model reads a snapshot of numbers and answers with a target share and a reason, in a fixed form | Agent market → Moa AI → decision log; `/api/ai/decisions?asset=BTC` |
| Code sets the limits, not the model | Clamp, 5% steps, at most 25 points per decision, a 10-point band; any bad or missing answer holds the last target | `src/aiPilot.ts` (`guard`), tests in `src/aiPilot.test.ts` |
| The chain enforces the rest | Each user has their own vault: only the owner withdraws; the agent key can only trade listed coins on HSKSwap inside per-trade and daily limits; stop-loss on-chain | `contracts/src/MoaVault.sol`, the vault on the explorer |
| Every decision can be checked | Each decision and each order carries a keccak256 hash of its inputs; the app recomputes it | "해시 확인" in the decision log; the trade note on the explorer |
| Costs are in every number | 0.3% pool fee, the pool's gap to the exchange, price impact from real depth | `src/fills.ts`, the Spread tab |

**One line:** the model proposes, code limits, the vault enforces, and everything is recorded in public.

## 3. User experience

- **One sentence per agent, one number per card:** what 1,000,000 won would be now, with "just holding" under it.
- **No fake winners:** when no agent clearly beat holding, the app says so and starts from a default chosen in advance.
- **Three choices to start:** how much, ask me every time or run on its own, and a stop.
- **Moa is on every screen:** it explains, proposes, and waits for the Confirm button. It never moves money by itself.
- **Risky things are behind a door:** short-term agents sit in a lab and need an explicit tick.

**One line:** a first-timer can hire an agent in under a minute and can always see what it did and why.

## 4. Future plans

1. **Vault version 3** (written and tested, not deployed): a 10-minute average price floor, agent sessions with an
   expiry, per-agent budgets on-chain, a guardian halt, creator fees.
2. **A track record for Moa AI:** its paper result and its real trades accumulate from the first decision; publish
   them monthly, next to holding.
3. **An agent market with creators:** shared agents with an on-chain fee the hirer approves.
4. **An audit** before any marketing of real money, and more HSK Chain venues as liquidity grows.

## If asked

- **"Does it beat holding?"** Over three years, after real costs, no agent here clearly did, and we show that. Moa AI
  has no backtest at all; its record starts at its first decision. The product is control and honesty, not a promise.
- **"What if the model is wrong or goes down?"** It can move at most 25 points every 4 hours, inside the budget and
  the vault's limits; with no answer it holds. The owner can pause or withdraw at any time.
- **"Who can take the money?"** Only the vault's owner. The agent key can trade, never withdraw.
- **"Is it audited?"** No. The contracts are open; version 3 has fork, fuzz and Foundry tests and a Slither run.
