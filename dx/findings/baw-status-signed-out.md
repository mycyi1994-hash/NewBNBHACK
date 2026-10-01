# `baw wallet status --json` reports success when signed out

- **Where:** Binance Agentic Wallet CLI `@binance/agentic-wallet` 1.10.0 (latest on npm, 2026-10-01)
- **Logged:** dx/LOG.md, 2026-10-01 06:19 UTC
- **Last run:** 2026-10-01T16:52:31Z — REPRODUCED — `success true`, `data.status UNCONNECTED` (fresh `HOME`, never signed in)

## Reproduce
`npm i -g @binance/agentic-wallet@1.10.0`, then `pnpm dx:repro --only baw-status-signed-out --baw "$(command -v baw)"` (it runs `baw wallet status --json` with an empty `HOME`).

## Expected / actual
- Expected: a signed-out wallet makes `wallet status` fail, like every other command (`market-order quote` answers `success: false`, `NOT_LOGGED_IN`, code 10003000).
- Actual: exit 0 and `{"success": true, "data": {"status": "UNCONNECTED"}}`. The Skills Hub `wallet-view.md` lists the three statuses but not that `success` stays true.

## Impact
A skill that checks `success` before planning goes on with a signed-out wallet. Ours requires `data.status = CONNECTED` (`skills/yieldvest/SKILL.md`, preflight).

## Ask
Exit non-zero (or `success: false`) when the session is not usable, or document that `success` only means the call ran.
