# Ondo quotes refuse exactly the stated minimum

- **Where:** Trading API `GET /api/v1/dex/aggregator/quote`, Ondo tokens (e.g. NVDAon, QQQon)
- **Logged:** dx/LOG.md, 2026-09-24 00:46 UTC
- **Last run:** not re-run since 9/24 (needs a Binance Web3 API key): `pnpm dx:repro --only ondo-minimum-order`

## Reproduce
Quote 5 USDT → NVDAon with a `userWalletAddress`.

## Expected / actual
- Expected: the docs put the Ondo minimum in `msg` (their example: "20 USD"); a quote at the minimum passes.
- Actual: $1 and $5 → code 40375 "Minimum order amount is 5 USD."; $5.01, $5.05, $5.10 and $6 pass. bStocks quote at $0.10.

## Impact
A $5 plan can only buy bStocks; Yieldvest's per-venue minimum for Ondo is $5.01 (`packages/core/src/venues.ts`).

## Evidence
`fixtures/trading/getAggregatedQuote-20260924-4.json` (40375).

## Ask
Make the message match the boundary ("more than 5 USD"), and return the minimum as a field.
