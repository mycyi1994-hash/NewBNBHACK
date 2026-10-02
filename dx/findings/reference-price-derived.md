# referencePrice is the token price per share, not an independent price

- **Where:** RWA Data `GET /api/v1/dex/market/rwa/tokens` and `…/rwa/price` (`referencePrice`)
- **Logged:** dx/LOG.md, 2026-09-24 00:55 UTC
- **Last run:** not re-run since 9/24 (needs a Binance Web3 API key): `pnpm dx:repro --only reference-price-derived`; the check passes on the recorded list (`fixtures/rwa/getRwaTokenList-20260924-1.json`, 488 tokens)

## Reproduce
Read the BSC RWA token list; compare `tokenPrice ÷ tokenToShareRatio` with `referencePrice` for every token.

## Expected / actual
- Expected (from the name): an independent reference, such as the underlying share's market price.
- Actual: equal within 5.4e-10 for all 9 instruments of our tape on 9/24 (NVDAB 224.695137 = 224.695137). llms-full.txt (9/23) had no field description; the HTML API reference (`/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data`, read 10/1) says: "A per-share converted price derived from the on-chain token price, not an official quote from the traditional stock market." Its `marketData` (Get RWA Underlying Market Data) has no independent stock price either.

## Impact
A gap guard of the form `onchain ÷ reference − 1` is always about 0. Yieldvest takes the independent price from the public RWA Dynamic V2 `stockInfo.price` instead (null outside trading hours).

## Ask
Offer the underlying share's market price next to `referencePrice` (the field itself is now described in the API reference).
