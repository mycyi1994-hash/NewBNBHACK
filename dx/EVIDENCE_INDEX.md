# DX evidence by report section

The official DX report has seven sections (docs/DX_PROTOCOL.md §5). This index lists, per section, the facts we have and where they are. It holds no report text: people write the report (M4-01). "LOG <time>" is a heading in [LOG.md](LOG.md); findings are in [findings/](findings/README.md) and are re-run with `pnpm dx:repro`.

## 1. Onboarding

| UTC | Step | Source |
| --- | --- | --- |
| 09-23 17:44 | The docs' LLM files fetched for agent context: HTTP 202, WAF challenge, empty body; fetched through headless Chromium | LOG 09-23 17:44, [findings](findings/docs-waf-challenge.md) |
| 09-23 18:16 | First call, unsigned: HTTP 401, 40101 "API Key is required", 641 ms | LOG 09-23 18:16 |
| 09-24 00:00 → 00:03 | Portal opened → API key issued | LOG 09-24 00:03 |
| 09-24 00:17 | First signed calls (Korean dev PC): RWA list and price batch, HTTP 200 | LOG 09-24 00:17 |
| 09-24 00:28 | First `api_calls` row written | LOG 09-24 00:28 |
| 09-24 02:31 | First call from Frankfurt (Fly): 2–4× slower than Korea, no 40303 on parallel calls | LOG 09-24 02:31 |

Key issued → first signed call: 14 minutes. Not recorded yet (people): the time lost at each step (`Time lost: [HUMAN]` lines) and the portal steps before 00:00.

## 2. Documentation issues

- All 19 documentation entries of 09-23 to 09-26 re-checked on 10-01, each with its public URL, section and current text: 13 still present, 4 found on the API reference (not proven to be changes), 2 changed — LOG 10-01 16:40.
- New on 10-01: 40314's "confirmation flag" that the Broadcast body does not have; 40102 with two messages; a "v1.1" renumbering missing from the changelog — LOG 10-01 16:52 (three entries).
- Others: multiplier functions not in the docs (LOG 09-24 00:41); the Uniswap v4 addresses page rate-limits a script (LOG 09-30 02:08); `baw` prints tokenized stocks in shares, undocumented (LOG 10-01 05:12); the public RWA list repeats tickers per chain (LOG 10-01 06:04).

## 3. API pitfalls

| Pitfall | Numbers | Source |
| --- | --- | --- |
| The per-endpoint window is the last 1,000 ms | 44 × 429 in 65 min with a 5/s token bucket; the 6th request at 422 ms got 429 | [findings](findings/rate-limit-sliding-window.md) |
| One code, two causes | 40484 for "no balance" and for "no position" | [findings](findings/defi-40484-two-causes.md) |
| DeFi deposit builds approve the maximum | `approve(vUSDT, type(uint256).max)` | [findings](findings/defi-unlimited-approve.md) |
| Ondo refuses exactly its minimum | $5.00 → 40375 "Minimum order amount is 5 USD."; $5.01 passes | [findings](findings/ondo-minimum-order.md) |
| quoteId lifetime (docs match) | `/swap` at once: 96 ms; 35 s later: 40401 | LOG 09-24 00:52 |
| Error HTTP status differs by page | HTTP 200 for every Market error vs 401/429 at the gateway | LOG 09-23 17:58 |
| Connector vs docs | header names, `simulateTransactions` requires three txs, a signed GET body | LOG 09-23 17:51, 17:53 (two) |
| Latency | Frankfurt 2–4× Korea; per-endpoint p50/p95 come from `pnpm dx:metrics` on the production database (`dx/metrics.md`, not generated yet) | LOG 09-24 02:31 |

## 4. AI stack feedback

| Tool | Facts | Source |
| --- | --- | --- |
| Agentic Wallet CLI `baw` 1.10.0 | quote amounts of tokenized stocks in shares (tokens × multiplier), not documented; `wallet status` says `success: true` while signed out | LOG 10-01 05:12, 06:19; [findings](findings/baw-status-signed-out.md) |
| Wallet Skill, as its author | every `baw` command and flag in `skills/yieldvest` and in `/next` is checked against the recorded `--help` of `baw` 1.10.0 (`fixtures/baw/1.10.0/`, `apps/web/test/baw-contract.test.ts`); the server hands out argv, never calldata | `skills/yieldvest`, `apps/web/lib/server/next.ts` |
| Agent Studio `bag` 0.0.14 | install pulls 280 packages, 469 MB; ERC-8004 registration ≈ $0.006 of gas or sponsored; seller agents only, the managed runtime is a 48-hour testnet sandbox | LOG 09-27 14:09, 14:11, 14:12; DECISIONS D-28 |
| Skills Hub `binance-tokenized-securities-info` | its public list repeats tickers per chain; `type=1` is called the only provider while `type=3` returns 87 bStocks | [findings](findings/rwa-list-tickers-per-chain.md) |

Not recorded yet (people): a signed-in `baw` run (M0-09, REPLAN R9), session expiry and re-login times, impressions.

## 5. Tokenized-stock specifics

| Fact | Numbers | Source |
| --- | --- | --- |
| Small quotes off-hours | NVDAB $1/$5/$50 at 225.10 USD per token, 0 % impact; Ondo $1 and $5 refused | LOG 09-24 00:46 |
| `referencePrice` is derived | `tokenPrice ÷ tokenToShareRatio` within 5.4e-10 | [findings](findings/reference-price-derived.md) |
| The multiplier is on chain only | `uiMultiplier`, `newUIMultiplier`, `effectiveAt` found in bytecode | LOG 09-24 00:41 |
| `statusInfo` differs by issuer | bStocks: `marketStatus`, `nextOpen`, `nextClose` null | LOG 09-24 00:45 |
| Hookless Uniswap v4 pools on BSC | the same NVIDIA exposure priced from 205 to 228 USD across pools; the three NVDAB pools have no active liquidity | LOG 09-30 02:11; `pnpm lp:market` |
| Transfers through the v4 PoolManager | bStocks and Ondo NVIDIA tokens move freely, no fee on transfer | LOG 09-30 02:38 |
| Regular session vs off-hours (tape) | not summarized yet: `tape_samples` on the production database (`/dx`, `dx/tape-summary.md`) | DX_PROTOCOL §3.4 |

## 6. Redesign suggestions (candidates; people choose)

From REPLAN §7: (1) the Agentic Wallet session makes unattended runs impossible — no log entry yet (M0-09); (2) simulating a sequence of transactions, or a state override: approve → deposit is simulated one call at a time (LOG 09-24 00:49); (3) a documented rate-limit window with a reset header ([findings](findings/rate-limit-sliding-window.md)), or a DeFi exact-amount approval ([findings](findings/defi-unlimited-approve.md)).

## 7. Requested capabilities (the "Ask" lines)

| Ask | Source |
| --- | --- |
| Serve the docs' `.txt`/`.md` files without a challenge | LOG 09-23 17:44 |
| Request body schemas for `POST /market/price`, `/price-info`, `/token/basic-info` (now on the API reference for the first) | LOG 09-23 17:51, 10-01 16:40 |
| Connector header names as documented; `simulateTransactions` as `oneOf` | LOG 09-23 17:51, 17:53 |
| A documented rate-limit window and a reset header | LOG 09-24 01:52 |
| An exact-amount approval on DeFi builds; the vToken address in investment detail; a code per cause instead of 40484 | LOG 09-24 00:49 |
| Simulating a sequence of transactions (approve → deposit) | LOG 09-24 00:49 |
| The underlying share's market price next to `referencePrice` | LOG 09-24 00:55 |
| The order minimum as a field, and a message that matches it | LOG 09-24 00:46 |
| A `chainId` filter on the public RWA list | LOG 10-01 06:04 |
| `baw`: units and the multiplier in its JSON; `wallet status` failing when signed out | LOG 10-01 05:12, 06:19 |
| An event index for BSC v4 pools, or a larger free log range | LOG 09-30 02:10 |
| The 40314 confirmation field on Broadcast | LOG 10-01 16:52 |
