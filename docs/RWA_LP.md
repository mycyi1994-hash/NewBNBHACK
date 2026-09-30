# RWA_LP.md — Session-aware liquidity for tokenized stocks (Uniswap v4 hook)

Status (2026-09-30): built and tested in `packages/rwa-lp`; rehearsed on a local fork of BSC mainnet; **not deployed**. A mainnet deployment, seeding the pool with money and running a price keeper are new spend paths and wait for a human yes (CLAUDE.md rule 5, TASKS LP-08 and LP-09). Decision record: DECISIONS D-29.

## 1. Why

A tokenized stock trades on-chain around the clock, but the stock's price is only discovered while the US market is open. A liquidity provider in a plain pool quotes the same fee at 11:00 on a Tuesday as at 22:00 on a Saturday, and sells the overnight and weekend gap to whoever trades first at the open. On BSC this is already visible: tokenized stocks sit in hookless, fixed-fee Uniswap v4 pools whose prices drift apart.

| Pool (Uniswap v4, BSC, block 124826328, 2026-09-30 02:11 UTC, US overnight) | Price, USD per token | Active liquidity |
| --- | --- | --- |
| NVDAB/USDT 0.01% | 224.85 | 0 |
| NVDAB/USDT 1% | 205.48 | 0 |
| NVDAB/USDC 0.3% | 221.97 | 0 |
| NVDAon/USDT 0.01% | 228.30 | 1.68e19 |
| NVDAon/USDT 0.05% | 212.03 | 1.40e18 |
| NVDAon/USDT 1% | price at the tick limit (drained) | 0 |
| Binance token price, NVDAB (public RWA Dynamic V2, 02:11:39 UTC) | 228.15 | `stockInfo.price` null (market closed) |

Raw reads and the method are in dx/LOG.md 2026-09-30 02:11.

## 2. What is in `packages/rwa-lp`

| Part | Role |
| --- | --- |
| `contracts/NyseMarketCalendar.sol` + `libraries/NyseTime.sol` | The agent's NYSE calendar (`packages/core/src/session.ts`) on chain: New York time with US daylight-saving rules, weekends, holidays, 13:00 early closes; a year without a holiday table counts as closed. Checked against 12,944 vectors generated from the TypeScript calendar. |
| `contracts/RwaSessionHook.sol` | The Uniswap v4 hook (permissions: beforeInitialize, beforeAddLiquidity, beforeSwap; address flags `0x2880`). Sets every swap's LP fee (§3), halts, gates who may add liquidity, and creates the pools that use it. |
| `contracts/KeeperReferenceOracle.sol` | Reference prices pushed by a reporter: share price × shares-per-token multiplier. For bStocks the multiplier must equal the token's on-chain `uiMultiplier()` when posted and when read. |
| `contracts/RwaLiquidityVault.sol` | One full-range position per pool, ERC-20 shares, pro-rata deposits and withdrawals with slippage limits and a deadline, optional allowlist. |
| `contracts/script/DeployRwaLp.s.sol` | Calendar → hook (CREATE2, mined address) → oracle → pool → vault. Moves no tokens. |
| `src/` (TypeScript) | ABIs generated from the build, verified Uniswap v4 addresses on BSC, deployment manifests, the price arithmetic (equal to the contract's to the wei), and a read-only status reader behind `pnpm lp:status`. |

## 3. How the fee of a swap is decided

In this order, from the pool's fee schedule:

1. **Corporate action.** The token is a bStocks token and a multiplier change (`effectiveAt`) is within `corporateActionWindow` of now, or the multiplier cannot be read → `closedFee`.
2. **Extended hours** (pre-market 04:00–09:30, after-hours to 20:00 New York) → `extendedFee`.
3. **Closed** (overnight, weekend, holiday, a year without a holiday table) → `closedFee`.
4. **Regular session** → `regularFee`, except during `openingRamp` after the bell, when the fee falls linearly from `closedFee` to `regularFee`.
5. **Reference gap** (regular session only). With a reference price no older than `maxReferenceAge`: a swap that moves the pool price toward the reference pays `gapCaptureBps` of the gap on top; a swap that moves it away pays nothing extra. The total is capped at `maxFee`.

Default schedule (agent proposal, D-29; the owner can change it within hard caps):

| Parameter | Default | Hard cap |
| --- | --- | --- |
| `regularFee` / `extendedFee` / `closedFee` | 0.05% / 0.30% / 1.00% | ordered, each ≤ `maxFee` |
| `maxFee` | 3.00% | 5.00% (`MAX_FEE_CAP`) |
| `openingRamp` | 30 min | 2 h |
| `gapCaptureBps` | 50% of the gap | 100% |
| `maxReferenceAge` | 15 min | 1 h |
| `corporateActionWindow` | 1 day on each side | 3 days |

Example from the fork rehearsal (§6): pool 228.14 USD, reference 225.99 USD (gap 0.95%). Selling the stock closes the gap and pays 0.05% + 0.475% = 0.525%; buying widens it and pays 0.05%.

Why a surcharge rather than a block: the arbitrage still happens, so the pool converges to the reference, but LPs keep half of what the arbitrageur would have taken. Off-hours the independent stock price is null (DECISIONS Q-06), so the reference is only used in the regular session; the rest of the time the session fee does the work.

## 4. Safety properties and trust model

- **LP funds can never be frozen by the hook.** The hook has no remove-liquidity permission, and a vault withdrawal never touches its add-liquidity check. Tested: a halted pool still pays every withdrawal.
- **A wrong or failing reference price is fee-bounded.** Fees stay within [session fee, `maxFee`]; the oracle call runs with a 100k gas cap and its answer must be exactly two words, so a reverting, gas-burning, malformed or missing source changes nothing (tested for each).
- **The owner** (a multisig after `LP_OWNER` handover) can create pools, change fees within the hard caps, set the reference source, the quote-token allowlist and the liquidity gate, and halt. It cannot move LP funds. **The guardian** can halt and resume. **The vault operator** can only compound idle fees inside a price band it checks off-chain; the vault owner can toggle the allowlist.
- **Pools are created only by the hook.** `beforeInitialize` rejects every other caller; the hook's own `initialize` call skips its hooks (Uniswap v4 `noSelfCall`).
- **Vault accounting.** Deposits round up (⌈L·s/S⌉ liquidity, ⌈idle·s/S⌉ tokens), withdrawals round down; fees are collected before either. Invariant tests show the liquidity and the idle tokens behind one share never shrink, shares add up, and everyone can always withdraw (a stress run: 32,768 random deposits, withdrawals, swaps and waits, 0 reverts). The first deposit locks 1,000 shares at a dead address. With the allowlist on, only listed accounts may deposit or receive shares; burning is always allowed.
- **Exact approvals.** Depositors approve what `previewDeposit` returns; the rehearsal left 0 allowance on both tokens. The vault itself approves nothing.
- **Not audited.** No external audit has been done.

## 5. Deploy runbook (every live step is a human decision)

1. Dry run against BSC state (simulation only; no key, nothing sent):
   ```bash
   cd packages/rwa-lp
   RWA_TOKEN=<address from the RWA registry> RWA_PRICE_E18=<USD per token × 1e18> \
     forge script contracts/script/DeployRwaLp.s.sol --fork-url "$BSC_RPC_URL"
   ```
2. Live (after a human yes): the same command plus `--broadcast` and a fresh deployer key (never the house key). Set `LP_OWNER` to the owner multisig; it must call `acceptOwnership()` on the calendar, hook, oracle and vault. The script writes `packages/rwa-lp/deployments/<chainId>-<symbol>.json`; commit it.
3. Seed the vault in the same session, so the empty pool's price cannot be moved before the first deposit: `sharesForAmounts` → `previewDeposit` → exact approvals → `deposit` with those maxima. Seeding is a new spend path (TASKS LP-08).
4. Keeper (TASKS LP-09): a reporter address posts `(token, sharePriceE18, multiplierE18, observedAt)` during the regular session from the public RWA Dynamic V2 `stockInfo.price` and the RWA Data API multiplier. Posting costs gas: a new spend path.
5. `pnpm lp:status` reads every manifest live: session, the fee each way and why, halt flag, pool price vs reference, vault holdings. Without a manifest it prints `UNAVAILABLE` and exits 3.

## 6. Evidence

| What | Result | Where |
| --- | --- | --- |
| Uniswap v4 on BSC | PoolManager `0x28e2…e9dF` runtime bytecode equals `@uniswap/v4-core@1.0.2` (24,009 bytes, one immutable masked); StateView, PositionManager and V4Quoter point to it; 218 swaps in 100 blocks | DECISIONS §2.3 U-01–U-03 |
| Calendar | 12,944 differential vectors match `session.ts` exactly | `contracts/test/NyseMarketCalendar.t.sol`, `vectors/nyse-sessions.json` |
| Foundry suite | 128 tests pass (hook and vault suites run with the stock on either side of the pool); fuzz 512 runs locally, 4,096 in CI, 5,000 in a stress run; invariants 64 runs × 64 calls (256 × 128 in a stress run) | `pnpm lp:test` |
| Coverage (production contracts) | lines 100% (485/485), statements 99.58%, branches 96.84%, functions 100% | `forge coverage` |
| BSC fork | NVDAB (bStocks) and NVDAon (Ondo) through the deployed PoolManager: deposit, swaps at the regular and the overnight fee, the on-chain multiplier in the oracle, full withdrawal — block 124829943 | `contracts/test/BscFork.t.sol` (`BSC_FORK_URL=… pnpm lp:test`) |
| Deploy dry run | 13,542,268 gas ≈ 0.00068 BNB at 0.05 gwei (02:43 UTC) | §5 step 1 |
| Local fork rehearsal | block 124831596: deploy broadcast to anvil, deposit 380,956 gas with 0 allowance left, reference posted, Uniswap's deployed V4Quoter quotes through the hook (sell 1 NVDAB → 206.416 USDT), `pnpm lp:status` LIVE | TASKS LP-06 |
| Hook cost | +33.4k gas per swap in its most expensive state (fresh reference, multiplier read) over a hookless pool with the same liquidity: ≈88k vs ≈55k | `test_swapGasOverheadIsBounded` |
| TypeScript | 30 vitest tests; price math equal to the contract's on shared vectors | `pnpm test` |

## 7. Limits and open questions

- Does the Binance Trading API (and its aggregator) route through hooked Uniswap v4 pools? Unknown until a pool exists (DECISIONS Q-18).
- Who runs the reporter and the guardian, and with which key? (Q-19.)
- The holiday table covers 2026–2027 like `session.ts`; 2028 must be added (`setYearCovered`, `setDays`) or the pool charges the closed fee all year.
- No page in the web app yet: a page without a deployed pool would only say "Unavailable" (CLAUDE.md rule 4). Copy would go to UX_COPY §7 as an agent draft (TASKS LP-10).
- A reference price is trusted within the fee bounds above: a wrong reporter can cost LPs the gap surcharge they would have earned and overcharge traders up to `maxFee`, nothing more.

## 8. Judging criteria

| Criterion | What this adds |
| --- | --- |
| Technical 30% | A Uniswap v4 hook on the deployed BSC PoolManager, with the agent's own calendar on chain, fork tests on real bStocks and Ondo tokens, invariant tests, a pinned CI job |
| Creativity 25% | Liquidity pricing for problems only tokenized stocks have: the US session, the opening gap, dividends and splits that change the multiplier |
| DX 25% | Tokenized-stock facts from BSC (pool prices, multipliers, transferability) in dx/LOG.md |
| Product & UX 20% | Not yet — no page until a pool is deployed (LP-10) |
