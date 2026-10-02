# The public RWA list repeats each ticker once per chain, Ethereum first

- **Where:** `GET https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1` (no key), as documented in Skills Hub `binance-tokenized-securities-info/SKILL.md` API 1
- **Logged:** dx/LOG.md, 2026-10-01 06:04 UTC
- **Last run:** 2026-10-01T16:52:29Z — REPRODUCED — 1,366 entries for 459 tickers (chain "56" 458, "1" 457, "CT_501" 451); 457 tickers repeat; NVDA in order: 1 → 56 → CT_501

## Reproduce
`pnpm dx:repro --only rwa-list-tickers-per-chain`.

## Expected / actual
- Expected: one entry per ticker for the list type asked for, or a chain filter.
- Actual: one entry per ticker per chain, all with the same symbol (`NVDAon`), Ethereum first. The skill doc's field table lists chain `1` and `56` only, not `CT_501`, and calls `type=1` (Ondo) "currently the only supported tokenized stock provider", while `type=3` returns 87 bStocks entries.

## Impact
A lookup by ticker alone returns the Ethereum token. Our Wallet Skill filters by `chainId "56"` and compares address, symbol and the quote's `toCoinSymbol` (`skills/yieldvest/references/safety.md`).

## Ask
A `chainId` filter on the list endpoint, and one sentence in the skill doc that tickers repeat per chain.
