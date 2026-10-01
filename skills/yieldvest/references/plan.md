# Plans: create, fund, check, stop

All requests go to `$YIELDVEST_URL`. Bodies are JSON. Amounts are decimal strings (`"5"`, `"2.50"`).

## Create a plan

1. Read the risk disclosure to the user (see [safety.md](safety.md)) and get a clear yes.
2. Get the wallet address: `baw wallet address --json` (BSC).
3. Agree on the plan with the user:
   - `ticker` — a US ticker in Yieldvest's verified list: `curl -sS "$YIELDVEST_URL/api/instruments"`.
   - `mode` — `safe` (a fixed amount per buy, default) or `yield` (interest of a Venus USDT deposit).
   - `contributionUsd` — per buy in safe mode; `"0"` for yield mode (interest only).
   - `cadence` — `daily` or `weekly` (default `weekly`).
   - `window` — `regular_session` (default, recommended) or `anytime`.
   - `maxPerBuyUsd`, `maxDailyUsd` — hard limits; per buy between the site's minimum buy and its
     per-transaction cap, per day at least per buy. The server refuses anything else
     (`bad_limits`). Off-hours an `anytime` plan buys at half the per-buy limit; when half is under
     the minimum it waits for the regular session.
4. Create it. The answer holds the plan's token, so it goes straight into a private file: the
   `umask 077` comes first, and the file sits in `~/.config/yieldvest` (mode 700), never in `/tmp`.
   Each block sets the umask itself, because a shell does not keep it from one command to the next.

```bash
umask 077 && mkdir -p ~/.config/yieldvest && chmod 700 ~/.config/yieldvest
curl -sS -X POST "$YIELDVEST_URL/api/plans" -H 'content-type: application/json' -d '{
  "owner": "skill",
  "walletAddress": "<address from step 2>",
  "ticker": "NVDA",
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
  '.url = $url | .plans[$p[0].plan.id] = {token: $p[0].token, ticker: $p[0].plan.target.ticker}' \
  ~/.config/yieldvest/config.json > ~/.config/yieldvest/config.json.new \
  && mv ~/.config/yieldvest/config.json.new ~/.config/yieldvest/config.json \
  && chmod 600 ~/.config/yieldvest/config.json && rm ~/.config/yieldvest/new-plan.json
```

   Tell the user the plan id and where the token is stored; never show the token.

Errors: `400 unknown_ticker` (not in the list), `400 bad_limits`, `429 too_many_plans` (five open
plans per wallet) — relay them as returned.

## Use the token

```bash
PLAN=<plan id>
AUTH="Authorization: Bearer $(jq -r --arg id "$PLAN" '.plans[$id].token' ~/.config/yieldvest/config.json)"
curl -sS -H "$AUTH" "$YIELDVEST_URL/api/plans/$PLAN/next"
```

## Fund a yield plan (put principal in the interest account)

A yield plan starts paused (`awaiting_deposit`) until its Venus deposit is reported.

1. Find the Venus USDT investment: `baw defi investment-list --investType Earn --defiProtocolId venus --binanceChainId 56 --json`
   and take the USDT entry's `investmentId`. Show its `apyDisplay` verbatim.
2. Preview, confirm, deposit (USDT `0x55d398326f99059fF775485246999027B3197955`):

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
   The next deposit asks for a new approval.

## Check a plan

`curl -sS "$YIELDVEST_URL/api/plans/$PLAN"` — status, limits (with today's use), history with reasons,
receipts with BscScan links, holdings in shares. The same page is at `$YIELDVEST_URL/plans/$PLAN`.

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
