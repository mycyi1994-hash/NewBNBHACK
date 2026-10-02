# The DeFi deposit build approves type(uint256).max

- **Where:** DeFi API `POST /api/v1/defi/transaction/deposit` (`dataList` item `APPROVE`); docs § Integration Flow (DeFi API) › Calldata Validity & Approvals
- **Logged:** dx/LOG.md, 2026-09-23 18:00 UTC and 2026-09-24 00:49 UTC
- **Last run:** not re-run since 9/24 (needs a Binance Web3 API key): `pnpm dx:repro --only defi-unlimited-approve`

## Reproduce
Build a Venus USDT deposit of 1 USDT with `simulate: false`; decode the `APPROVE` item's calldata.

## Expected / actual
- Expected: an approval for the deposit amount, or an option for one.
- Actual: `USDT.approve(0xfD58…0255 (vUSDT), type(uint256).max)`; the Transaction API simulation shows the allowance going from 0 to 2^256 − 1. Documented (10/1): "**APPROVE is an unlimited allowance (EVM only)**"; the build body has no approval-amount field.

## Impact
Products that must approve exact amounts cannot sign the item as built. Yieldvest does not sign it: it encodes `approve(spender, amount)` itself for the spender named by the item, checked against the `DEPOSIT` item's `to` (DECISIONS Q-16, D-17).

## Evidence
`fixtures/defi-transaction/buildDeFiDepositTransaction-20260924-3.json`; `fixtures/transaction/simulateTransactions-20260924-1.json`.

## Ask
An exact-amount approval option on the build.
