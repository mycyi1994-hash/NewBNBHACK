---
name: yieldvest
description: |
  Use when the user wants Yieldvest to collect tokenized US stocks (bStocks / Ondo on BNB Smart
  Chain) in their own Binance Agentic Wallet — with a fixed amount per buy (safe mode) or with the
  interest of a USDT deposit in Venus (yield mode), on a daily or weekly schedule, only during the
  US regular session, under hard per-buy and per-day limits. Triggers: "start Yieldvest",
  "run my Yieldvest plan", "what should Yieldvest do now", "Yieldvest status", "stop my Yieldvest plan".
metadata:
  author: yieldvest
  version: '0.2.0'
  # The baw version every command and amount here is checked against (as binance-agentic-wallet 1.12.0).
  requiredCliVersion: '1.10.0'
  requires:
    skills:
      - binance-agentic-wallet
  openclaw:
    requires:
      bins:
        - baw
        - curl
        - jq
---

# Yieldvest Wallet Skill

Yieldvest decides; the user's wallet signs. The Yieldvest server runs a deterministic engine (no model in
the decision) over its own market recordings and the wallet's on-chain position, and answers with
the exact `baw` commands to run. **It never sees keys, never holds a session, never builds
calldata.** Every transaction is signed by the user's Binance Agentic Wallet on their device, after
the user confirms, and then reported back — the server records only what the chain shows.

## Preflight (every conversation)

0. `baw cli-check --required-version 1.10.0 --json` (`metadata.requiredCliVersion`). If `data.needUpdateCli` is `true`, stop: this
   skill's commands and amounts are checked against `baw` 1.10.0 (its quotes print a tokenized stock
   in shares) — the user updates the Binance Agentic Wallet CLI first.
1. The `binance-agentic-wallet` skill is installed and `baw` is signed in: `baw wallet status --json`
   must say `data.status` = `CONNECTED` (`success` is `true` either way: signed out is
   `UNCONNECTED`, a wallet still being created is `CREATING`). If not, follow that skill's
   authentication reference. Then `baw wallet settings --json`: if
   `data.sessionExpireTime` is less than two hours away, say so before starting anything (see
   [safety.md](references/safety.md)).
2. The Yieldvest server URL: `YIELDVEST_URL` in the environment, else the `url` in `~/.config/yieldvest/config.json`,
   else ask the user for the site address (it is in the project README). Check it answers:
   `curl -sS "$YIELDVEST_URL/api/health"`.
3. Plans and their tokens live in `~/.config/yieldvest/config.json` (mode 600). Never print a token in
   the chat; pass it to `curl` from the file (see [plan.md](references/plan.md)).

## Command Routing

| User intent | What to do | Reference |
| --- | --- | --- |
| Start / create a plan ("start Yieldvest") | Risk disclosure → `POST /api/plans` with `owner: "skill"` → save the token | [plan.md](references/plan.md) |
| Put principal in (yield mode) | `baw defi preview --action DEPOSIT …` → confirm → `baw defi deposit …` → `POST /report` | [plan.md](references/plan.md) |
| Run the plan / "what now?" | `GET /api/plans/{id}/next` → run its `steps` in order, confirming each | [run.md](references/run.md) |
| Status / history | `GET /api/plans/{id}` (public view: limits, history, receipts, holdings) | [plan.md](references/plan.md) |
| Stop the plan | `POST /api/plans/{id}/stop`; in yield mode, `GET /api/plans/{id}/position` → its redeem step, with the user | [plan.md](references/plan.md) |
| Anything about risks | Read the disclosure; never promise returns | [safety.md](references/safety.md) |

The API contract (every route, body and answer) is published at `$YIELDVEST_URL/api/openapi`.

## Rules that always apply

- **Confirm every state change.** Show the preview (`defi preview`, `market-order quote`) and ask;
  proceed only on a clear yes. The server's answer is advice to the wallet, not permission.
- **Run exactly what `/next` returned, before its `expiresAt`.** Never change amounts, tokens or
  flags; never reuse an expired answer — ask `/next` again.
- **Verify the token.** Before a swap, check the `toToken` address against the official RWA list
  and the symbol in the quote (see [safety.md](references/safety.md)). On any mismatch, stop.
- **An orderId is not a trade.** Poll `baw market-order list --orderId <id> --json` until `FINISHED`
  or `FAILED`, then report the result as it is — including failures.
- **Report every mined transaction** with `POST /report` so the plan's limits, history and receipts
  stay true. A report is checked against the chain; a rejected report is shown to the user verbatim.
- **Errors are relayed exactly** as `baw` or the server return them.
- **No advice, no promises.** Yieldvest is not a bank; principal can be lost. Never describe returns as
  certain.
