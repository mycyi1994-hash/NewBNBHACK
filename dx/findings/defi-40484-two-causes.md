# One DeFi error code for two different causes (40484)

- **Where:** DeFi API `POST /api/v1/defi/transaction/deposit` and `/redeem` with `simulate: true`
- **Logged:** dx/LOG.md, 2026-09-24 00:49 UTC
- **Last run:** not re-run since 9/24 (needs a Binance Web3 API key): `pnpm dx:repro --only defi-40484-two-causes`

## Reproduce
Build a Venus USDT deposit and a redeem with `simulate: true` for an address that holds nothing (`dx:repro` makes a fresh one).

## Expected / actual
- Expected: distinct codes for "no balance" and "no position", or a documented preview for an unfunded wallet.
- Actual: both HTTP 200 with code 40484, which the DeFi error table (10/1) defines as "Transaction reverted during simulation — a preview simulation (`simulate=true`) reverted, but the `errorMessage` did not match any configured revert-substring mapping" — deposit: "Insufficient balance. Please cancel the transaction, check your balance, and try again."; redeem: "You don't have any position in this investment product." With `simulate: false` both return calldata (code 0).

## Impact
A client cannot tell the causes apart by code. We build with `simulate: false` and simulate each call through the Transaction API ourselves.

## Evidence
`fixtures/defi-transaction/buildDeFiDepositTransaction-20260924-1.json`, `buildDeFiRedeemTransaction-20260924-1.json`.

## Ask
A separate code per cause.
