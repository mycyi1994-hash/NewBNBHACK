# Running a plan: `/next` → steps → report

```bash
curl -sS -H "$AUTH" "$YIELDVEST_URL/api/plans/$PLAN/next"
```

## Answers

- `decision: "wait"` — nothing to do now. Tell the user the reason (`why` is a sentence key with
  params, e.g. `why.deferred.market_closed` with `open`; `reason` is `not_due` (the plan's
  cadence: the last buy was recent), `data_stale`, `data_unavailable`, `venus_unavailable` or
  `chain_unavailable`) and when to ask again (`retryAt`).
- `decision: "skip"` — this cycle is skipped (`why`: below the minimum, daily limit reached,
  guardian holding, corporate action…; or `reason: plan_paused` / `plan_stopped` /
  `no_principal`). Nothing to run.
- `decision: "failed"` — relay the reason; do not improvise a trade.
- `decision: "buy"` — run `steps` in order, before `expiresAt` (five minutes). Show the user
  `spendUsd`, the stock (`instrument.symbol`, full `instrument.address`) and `estimate.shares`
  (a planning estimate from Yieldvest's recordings — the wallet quotes again).

## Steps

Each step has `run` (argv for `baw`), and may have `preview`, `acceptMinToCoinAmount`, `confirm`
and `report`. Placeholders in angle brackets come from the previous command's JSON.

Before the first step, everything that only reads, so a failed check leaves nothing half-done:

- `baw wallet tx-lock --binanceChainId 56 --json` says `UNLOCKED` (see SKILL.md).
- `baw wallet left-quota --json`: `data.quotaLeft` is at least `spendUsd`, or the wallet's own
  daily limit would refuse the swap (see [safety.md](safety.md)).
- `baw wallet balance --binanceChainId 56 --json` lists BNB for gas (tokens worth under $0.01 are
  not listed, so no BNB entry means none); in safe mode, USDT covers `spendUsd`.
- Every step's `run` passes the check in SKILL.md.
- Run the `quote` step's `run` once now: it only reads. Do the token check in
  [safety.md](safety.md) and the swap pre-check of `binance-agentic-wallet` (its
  `query-token-audit` audit; if that skill is missing or the audit is unavailable, say so and go
  on only on an explicit yes).

Only then take the interest out (step 1); the quote is asked again just before the swap.

1. `redeem` (yield plans: take this cycle's interest out of Venus)
   - Run `preview`; show the fee and balance changes; ask; on yes run `run`.
   - Report `{"kind": "redeem", "txHash": "<data.txHash>"}` once it is mined (retry on `202`).
2. `quote`
   - Run it. **Stop** unless `data.toCoinAmount` ≥ `acceptMinToCoinAmount` (the price moved more
     than Yieldvest's 1 % impact limit) and the quote's `toCoinSymbol` matches `instrument.symbol`.
     Both amounts are in shares (`baw` prints a tokenized stock as tokens × its multiplier); compare
     them as decimals, never as text.
   - Do the token check in [safety.md](safety.md).
3. `swap`
   - Complete the `binance-agentic-wallet` swap security pre-check; show amount, token, slippage
     (`--slippage 0.5` is in the command); ask; on yes run `run`.
   - `data.orderId` is only a submission. Poll `confirm` (`baw market-order list --orderId … --json`)
     every few seconds until `FINISHED` or `FAILED`.
   - An error that still carries `data.orderId` (for example `Confirmation required on App`) is an
     order waiting for the user: tell them to approve or reject it in the Binance App (five
     minutes) and poll that `orderId` the same way.
   - Still `PENDING` after about 30 s: tell the user it is still processing, keep its `orderId` in
     the plan's entry of `~/.config/yieldvest/config.json` (`openOrders`), and at the start of the
     next run poll it and report it before asking `/next` again: a fill nobody reported is a buy
     the plan's limits do not know about.
   - `FINISHED`: report `{"kind": "swap", "txHash": "<txHash>", "orderId": "<orderId>"}`.
     `FAILED`: tell the user it failed; report only if a `txHash` exists (a failed swap that spent
     gas is still a fact).

```bash
curl -sS -X POST -H "$AUTH" -H 'content-type: application/json' \
  "$YIELDVEST_URL/api/plans/$PLAN/report" -d '{"kind": "swap", "txHash": "0x…", "orderId": "…"}'
```

## Report answers

- `200 recorded` — with `why` (e.g. `why.bought.regular`: ticker, shares, dollars). Tell the user.
- `200 already_recorded` — fine; nothing else to do.
- `200 recorded` with `paused: "report_over_limit"` — the swap spent more than the plan allows; the
  plan is paused. Tell the user; do not continue until they decide.
- `202 pending` — not mined yet; report again in ~15 s.
- `422 rejected` — the chain does not show what was reported (reverted, another sender, no tokens
  received, older than the plan, a transaction of Yieldvest's own house wallet), or the transaction
  is already recorded on another plan. Relay the reason verbatim.

## Scheduling

The skill runs when the user asks. To keep a schedule, the user can ask their assistant to check
`/next` at the plan's cadence during the US regular session; each run still asks before signing.
A recorded swap moves the plan to its next due time, so asking again sooner answers `wait`
(`not_due`) with that time in `retryAt`.

## Example conversations

Values in backticks come from the answers; nothing here is a real amount or hash.

Outside the regular session:

> **User:** Run my Yieldvest plan.
>
> **Assistant:** _(preflight: `baw cli-check`, `baw wallet status` → `CONNECTED`; `GET /next` →
> `decision: "wait"`, `why.deferred.market_closed`)_ Nothing to buy now: the US market is closed.
> Yieldvest retries at `retryAt` (shown in your time zone). Shall I check again then?

A safe-mode buy during the session:

> **User:** What should Yieldvest do now?
>
> **Assistant:** _(`GET /next` → `decision: "buy"`; every `run` matches the plan: USDT in,
> the plan's token out, `spendUsd` within `maxPerBuyUsd`)_ Yieldvest wants to buy $`spendUsd` of
> `instrument.symbol` (`instrument.address`), about `estimate.shares` shares by its recordings.
> _(`tx-lock` `UNLOCKED`; `left-quota` ≥ `spendUsd`; BNB for gas; `quote`; `toCoinAmount` ≥
> `acceptMinToCoinAmount`; the token check and the audit pass)_ Your wallet quotes `toCoinAmount`
> shares for `fromCoinAmount` USDT. Swap, slippage 0.5 %? Do your own research (DYOR).
>
> **User:** Yes.
>
> **Assistant:** _(`swap` → `data.orderId`; `market-order list` until `FINISHED`; `POST /report` →
> `200 recorded` with `why.bought.regular`)_ Bought `shares` shares of `ticker` ($`usd`) during
> regular hours. Transaction: `txHash`.

If the user says no, nothing is signed and nothing is reported; `/next` answers again later.
