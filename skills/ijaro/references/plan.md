# Plans: create, fund, check, stop

All requests go to `$IJARO_URL`. Bodies are JSON. Amounts are decimal strings (`"5"`, `"2.50"`).

## Create a plan

1. Read the risk disclosure to the user (see [safety.md](safety.md)) and get a clear yes.
2. Get the wallet address: `baw wallet address --json` (BSC).
3. Agree on the plan with the user:
   - `ticker` — a US ticker in Ijaro's verified list: `curl -sS "$IJARO_URL/api/instruments"`.
   - `mode` — `safe` (a fixed amount per buy, default) or `yield` (interest of a Venus USDT deposit).
   - `contributionUsd` — per buy in safe mode; `"0"` for yield mode (interest only).
   - `cadence` — `daily` or `weekly` (default `weekly`).
   - `window` — `regular_session` (default, recommended) or `anytime`.
   - `maxPerBuyUsd`, `maxDailyUsd` — hard limits; per buy at most the site's per-transaction cap,
     per day at least per buy. The server refuses anything else (`bad_limits`).
4. Create it:

```bash
curl -sS -X POST "$IJARO_URL/api/plans" -H 'content-type: application/json' -d '{
  "owner": "skill",
  "walletAddress": "<address from step 2>",
  "ticker": "NVDA",
  "mode": "safe",
  "contributionUsd": "5",
  "cadence": "weekly",
  "window": "regular_session",
  "maxPerBuyUsd": "5",
  "maxDailyUsd": "5"
}' > /tmp/ijaro-plan.json   # run with umask 077: the answer holds the token
```

5. The answer (`201`) holds `plan.id` and `token` (`ijr_…`). **The token is shown once.** Save both
   without echoing the token:

```bash
umask 077 && mkdir -p ~/.config/ijaro
[ -f ~/.config/ijaro/config.json ] || echo '{}' > ~/.config/ijaro/config.json
jq --slurpfile p /tmp/ijaro-plan.json --arg url "$IJARO_URL" \
  '.url = $url | .plans[$p[0].plan.id] = {token: $p[0].token, ticker: $p[0].plan.target.ticker}' \
  ~/.config/ijaro/config.json > /tmp/ijaro-config.json \
  && mv /tmp/ijaro-config.json ~/.config/ijaro/config.json && chmod 600 ~/.config/ijaro/config.json \
  && rm /tmp/ijaro-plan.json
```

   Tell the user the plan id and where the token is stored; never show the token.

Errors: `400 unknown_ticker` (not in the list), `400 bad_limits`, `429 too_many_plans` (five open
plans per wallet) — relay them as returned.

## Use the token

```bash
PLAN=<plan id>
AUTH="Authorization: Bearer $(jq -r --arg id "$PLAN" '.plans[$id].token' ~/.config/ijaro/config.json)"
curl -sS -H "$AUTH" "$IJARO_URL/api/plans/$PLAN/next"
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
  "$IJARO_URL/api/plans/$PLAN/report" -d '{"kind": "deposit", "txHash": "<data.txHash>"}'
```

   `202 pending` — not mined yet; wait ~15 s and report again. `200 recorded` — the principal is on
   record and the plan starts. `422 rejected` — relay the reason.

## Check a plan

`curl -sS "$IJARO_URL/api/plans/$PLAN"` — status, limits (with today's use), history with reasons,
receipts with BscScan links, holdings in shares. The same page is at `$IJARO_URL/plans/$PLAN`.

## Stop a plan

```bash
curl -sS -X POST -H "$AUTH" "$IJARO_URL/api/plans/$PLAN/stop"
```

The answer is a job (`202`, poll `GET $IJARO_URL/api/jobs/<jobId>`). The plan stops buying. In
yield mode the principal stays in the user's own Venus position: offer to take it out with
`baw defi preview --action REDEEM …` → confirm → `baw defi redeem … --ratio 1 --json`, then report
it with `{"kind": "redeem", "txHash": …}`. The shares already bought stay in the wallet.
