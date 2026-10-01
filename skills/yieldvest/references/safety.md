# Safety

## Risk disclosure (read before creating a yield plan, and whenever asked)

Yieldvest is not a bank. The interest account is a lending service on BSC (Venus); the interest is paid
by people who borrow there.
1. You can lose principal. If Venus is exploited or USDT loses its peg, you may not get it back.
2. The rate changes daily (show `apyDisplay` from `baw defi investment-list` verbatim).
3. Share prices go up and down.
4. You can withdraw any time, but if the service pauses it may take longer.
5. Yieldvest's guardian stops buying on warning signs, but cannot prevent every incident. In skill
   plans the principal is in the user's own wallet: only the user can move it.

Get a clear "I understand, I will only use money I can afford to lose" before a yield plan. Safe
mode (a fixed amount, no interest account) is the default.

## Token check before every swap

The server's `instrument.address` must be the official token for that ticker and issuer:

```bash
# The list for instrument.issuer — bstocks: type=3 (symbols end in B) · ondo: type=1 (symbols end in "on")
curl -sS 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=3'
```

Each ticker is listed once per chain: take the entry whose `ticker` is the plan's and whose
`chainId` is `"56"` (BNB Smart Chain). Compare its `contractAddress` with `instrument.address`
(case-insensitive) and its `symbol` with `instrument.symbol` and the quote's `toCoinSymbol`. Any
mismatch → stop and tell the user; never swap to an address you could not verify. Show full
addresses, never shortened ones.

## Wallet session

`baw wallet settings --json` shows when the session expires (`data.sessionExpireTime`) and when an
idle one signs out (`data.inactiveSignOutTime`); `baw wallet status` only says whether it is signed
in. Warn the user when either is less than two hours away; an expired session logs out silently, and a half-finished cycle (a redeem without its
swap) should not be left behind — finish or report what happened.

## Limits

- The plan's `maxPerBuyUsd` and `maxDailyUsd` are the most a cycle may spend; `/next` never asks for
  more. A report that shows more pauses the plan.
- The wallet's own daily trading limit applies as well: `baw wallet left-quota --json` gives
  `data.quotaLeft` (USD, today in UTC). If it is under `spendUsd`, the wallet would refuse the
  swap — stop before the redeem and tell the user, rather than leave interest half-spent.

## Never

- Never print, paste or send the plan token anywhere but the `Authorization` header to `$YIELDVEST_URL`.
- Never send a swap or a redeem the server did not return, or change its amounts, tokens or flags
  (the other `baw` commands here only read, except a deposit the user asks for in plan.md). Never
  redeem with `--ratio 1`: the wallet's Venus USDT is not all this plan's.
- Never treat an `orderId` as a finished trade.
- Never retry a swap from an old `/next` answer; ask again.
- Never describe returns as certain or give investment advice.
