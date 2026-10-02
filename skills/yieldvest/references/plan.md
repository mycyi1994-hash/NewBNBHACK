# Plans: create, fund, check, stop

All requests go to `$YIELDVEST_URL`. Bodies are JSON. Amounts are decimal strings (`"5"`, `"2.50"`).

## Create a plan

1. Read the risk disclosure to the user (see [safety.md](safety.md)) and get a clear yes. If `baw`
   ever answers `Compliance check failed`, stop: tokenized stocks may be restricted where the user is.
2. Get the wallet address: `baw wallet address --json` (BSC).
3. Agree on the plan with the user:
   - `ticker` and `issuer` — a US ticker in Yieldvest's verified list:
     `curl -sS "$YIELDVEST_URL/api/instruments"` (each entry has `ticker`, `issuer`, `symbol` and the
     full `address`). When the ticker has both a bStocks token (`…B`) and an Ondo one (`…on`), show
     both with full addresses and ask which one — never pick for the user. The plan buys only that
     token and never switches to the other. To help them choose, show the recorded facts side by
     side: `curl -sS "$YIELDVEST_URL/api/compare?ticker=NVDA"` gives, per token, the shares each
     $5 / $50 / $500 quote was worth, the price per share in it, price impact or the code it was
     refused with (`40375` is Ondo's minimum), status and minimum order, with `data.sampledAt`.
     Say when it was recorded; `sizes[].moreShares` is a fact about that quote, not advice.
   - `mode` — `safe` (a fixed amount per buy, default) or `yield` (interest of a Venus USDT deposit).
   - `contributionUsd` — per buy in safe mode; `"0"` for yield mode (interest only).
   - `cadence` — `daily` or `weekly` (default `weekly`).
   - `window` — `regular_session` (default, recommended) or `anytime`.
   - `maxPerBuyUsd`, `maxDailyUsd` — hard limits; per buy between the site's minimum buy and its
     per-transaction cap, per day at least per buy. The server refuses anything else
     (`bad_limits`). Off-hours an `anytime` plan buys at half the per-buy limit; when half is under
     the minimum it waits for the regular session.
   Before creating it, the user can see what the rules would do right now with these settings:
   `curl -sS "$YIELDVEST_URL/api/preflight?ticker=NVDA&issuer=bstocks&usd=5&window=regular_session"`
   — per token a `decision` (`buy` with about how many shares, `wait` with `retryAt`, `skip`) with
   its reason, and `checks` (each rule's input against its limit). It creates nothing and returns
   no command; a plan is still decided by its own `/next`.
4. Create it. The answer holds the plan's token, so it goes straight into a private file: the
   `umask 077` comes first, and the file sits in `~/.config/yieldvest` (mode 700), never in `/tmp`.
   Each block sets the umask itself, because a shell does not keep it from one command to the next.

```bash
umask 077 && mkdir -p ~/.config/yieldvest && chmod 700 ~/.config/yieldvest
curl -sS -X POST "$YIELDVEST_URL/api/plans" -H 'content-type: application/json' -d '{
  "owner": "skill",
  "walletAddress": "<address from step 2>",
  "ticker": "NVDA",
  "issuer": "bstocks",
  "mode": "safe",
  "contributionUsd": "5",
  "cadence": "weekly",
  "window": "regular_session",
  "maxPerBuyUsd": "5",
  "maxDailyUsd": "5"
}' > ~/.config/yieldvest/new-plan.json
```

5. The answer (`201`) holds `plan.id` and `token` (`yv_…`). **The token is shown once.** Save both
   without echoing the token:

```bash
umask 077
[ -f ~/.config/yieldvest/config.json ] || echo '{}' > ~/.config/yieldvest/config.json
jq --slurpfile p ~/.config/yieldvest/new-plan.json --arg url "$YIELDVEST_URL" \
  '.url = $url | .plans[$p[0].plan.id] = {token: $p[0].token, ticker: $p[0].plan.target.ticker,
    issuer: $p[0].plan.issuerPreference[0], maxPerBuyUsd: $p[0].plan.limits.maxPerBuyUsd,
    maxDailyUsd: $p[0].plan.limits.maxDailyUsd, openOrders: []}' \
  ~/.config/yieldvest/config.json > ~/.config/yieldvest/config.json.new \
  && mv ~/.config/yieldvest/config.json.new ~/.config/yieldvest/config.json \
  && chmod 600 ~/.config/yieldvest/config.json && rm ~/.config/yieldvest/new-plan.json
```

   Tell the user the plan id and where the token is stored; never show the token. The limits saved
   here are what SKILL.md checks every command against.
6. Offer one more limit the wallet itself enforces: in the Binance App, set the Agentic Wallet's
   daily limit (`data.dailyLimit` in `baw wallet settings --json`) to at most the plan's
   `maxDailyUsd`, so the wallet refuses more even if something else asks.

Errors: `400 unknown_ticker` (not in the list, or not with that issuer), `400 bad_limits`,
`429 too_many_plans` (five open plans per wallet) — relay them as returned.

## Use the token

```bash
PLAN=<plan id>
AUTH="Authorization: Bearer $(jq -r --arg id "$PLAN" '.plans[$id].token' ~/.config/yieldvest/config.json)"
curl -sS -H "$AUTH" "$YIELDVEST_URL/api/plans/$PLAN/next"
```

## Fund a yield plan (put principal in the interest account)

A yield plan starts paused (`awaiting_deposit`) until its Venus deposit is reported.

1. Find the Venus USDT investment: `baw defi investment-list --investType Earn --defiProtocolId venus --binanceChainId 56 --contractAddresses 0x55d398326f99059fF775485246999027B3197955 --json`
   and take the USDT entry's `investmentId`. It must say `investable: true` (`false` means delisted:
   refuse the deposit). Show its `apyDisplay` verbatim.
2. Check, preview, confirm, deposit (USDT `0x55d398326f99059fF775485246999027B3197955`):
   - `baw wallet settings --json`: `data.defiQuotaLeft` (USD) covers the amount.
   - The preview's `feeAndContract.interactWith.address` must be vUSDT
     `0xfD5840Cd36d94D7229439859C0112a4185BC0255`; anything else, stop. Show its `balanceChange`,
     `feeAndContract.estimatedNetworkFee` and every entry of `warnings` verbatim, then ask (DYOR).
   - `tx-lock` says `UNLOCKED` (SKILL.md), then deposit.

```bash
baw defi preview --action DEPOSIT --investmentId <id> --tokenAddress 0x55d398326f99059fF775485246999027B3197955 --amount <usd> --json
baw defi deposit --investmentId <id> --tokenAddress 0x55d398326f99059fF775485246999027B3197955 --amount <usd> --json
```

3. Report the transaction (the server reads the vUSDT minted and the USDT spent from the receipt):

```bash
curl -sS -X POST -H "$AUTH" -H 'content-type: application/json' \
  "$YIELDVEST_URL/api/plans/$PLAN/report" -d '{"kind": "deposit", "txHash": "<data.txHash>"}'
```

   `202 pending` — not mined yet; wait ~15 s and report again. `200 recorded` — the principal is on
   record and the plan starts. `422 rejected` — relay the reason.
4. Check what the deposit left the Venus market allowed to take (vUSDT
   `0xfD5840Cd36d94D7229439859C0112a4185BC0255`):
   `baw approvals list --spender 0xfD5840Cd36d94D7229439859C0112a4185BC0255 --json`. Yieldvest's
   own wallet approves exact amounts only; if the USDT entry's `amount` is `unlimited` (or a number
   longer than 18 digits), tell the user and offer to revoke it — a transaction, so ask first:
   `baw approvals revoke --binanceChainId 56 --tokenContract 0x55d398326f99059fF775485246999027B3197955 --spender 0xfD5840Cd36d94D7229439859C0112a4185BC0255 --type approve --json`.
   It answers `BROADCASTED`: the approval stays in force until that transaction is confirmed. The
   next deposit asks for a new approval.

## Check a plan

`curl -sS "$YIELDVEST_URL/api/plans/$PLAN"` — status, limits (with today's use), history with reasons,
receipts with BscScan links, holdings in shares. The same page is at `$YIELDVEST_URL/plans/$PLAN`.

Everything the wallet holds, not only what this plan bought:
`curl -sS "$YIELDVEST_URL/api/wallet?address=<address from baw wallet address>"` — each bStocks or
Ondo token in shares, read on chain at one block (`chain.blockNumber`), with a scheduled dividend
or split (`pendingChange`), values at the last recorded price (`prices.state`), the wallet's USDT
and Venus position, and its Yieldvest plans. The page is `$YIELDVEST_URL/wallet?address=…`.

## Stop a plan

```bash
curl -sS -X POST -H "$AUTH" "$YIELDVEST_URL/api/plans/$PLAN/stop"
```

The answer is a job (`202`, poll `GET $YIELDVEST_URL/api/jobs/<jobId>`). The plan stops buying. In
yield mode the principal stays in the user's own Venus position: offer to take this plan's part out.
The wallet can hold more Venus USDT than this plan put in (another plan's principal, or the user's
own), so never redeem with `--ratio 1`; ask the server for this plan's amount:

```bash
curl -sS -H "$AUTH" "$YIELDVEST_URL/api/plans/$PLAN/position"
```

Its `steps` hold one `redeem` step (none when nothing is left): run its `preview`, show it, ask; on
yes run its `run`, then report `{"kind": "redeem", "txHash": "<data.txHash>"}`. The shares already
bought stay in the wallet.
