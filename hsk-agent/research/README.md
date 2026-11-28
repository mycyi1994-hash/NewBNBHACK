# Research behind Moa's default and its label rule

- `strategy-selection.md`: what the literature says about picking one winner from about 30 backtested rules on about
  three years of data (written 28 Nov 2026; every source opened is linked in it).
- `rank-sim.ts`: a walk-forward check on Moa's own agents. Each of fourteen picking rules chooses with data before a
  cut date; the score is its pick over the next 90 days against holding the coin. Run it from `hsk-agent`:

  ```bash
  node --experimental-strip-types research/rank-sim.ts
  ```

  It reads live candles and writes `rank-sim.md` (the copy here was written on 28 Nov 2026; numbers move a little with
  each new day of candles).

What followed from them is in `src/agents.ts` (the basket, `holdTest`, `tierOf`) and `src/recommend.ts`.
