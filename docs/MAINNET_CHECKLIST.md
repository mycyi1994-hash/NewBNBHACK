# Mainnet record: what to run and what to write down

Each run below is done by the owner, from the owner's wallet, on HSK Chain mainnet (chain 177), with a few dollars.
Nothing here is sent by the server on its own except where a step says "auto". After each step, put the
transaction link into the table at the end and into the root README.

## Before

- A wallet on HSK Chain with a little HSK for gas and 5–10 USDT.
- Open https://grabitmoa.onrender.com and log in (one signature). The account menu shows your vault address.

## 1. Deposit

Account menu → Deposit → send 5 USDT to the vault.
Record the deposit transaction.

## 2. An agent trade that you approve

1. Agent market → pick a BTC agent → 맡기기.
2. Set "한 번에 $1", "총 예산 $2" and the mode "매번 묻기".
3. When the agent asks in Moa's chat, press buy.

Record the trade transaction (the vault's `trade` call, sent by the agent wallet).

If the agent's rule does not ask today, a direct order shows the same path: type "BTC 1달러 사줘" in the chat;
Moa proposes the order as a card, and it runs only when you press the card's Confirm button (a one-time ticket for
your wallet and that order, valid for 5 minutes).

## 3. An agent on its own (auto)

1. Hire an agent with "알아서 하기", "$1" per buy and a "$2" budget.
2. Set a daily limit when the sheet asks (one owner transaction).
3. Wait for the agent's next decision. The server checks every 5 minutes; an hourly made agent decides on each
   closed hourly candle.

Record the limit transaction and the first auto trade.

## 4. Stop-loss

In the account menu, set a stop-loss (e.g. 5%) on the vault (one owner transaction). A stop-out happens only if a
holding really falls that far: record it if it happens, otherwise record only the setting transaction and say
"not triggered".

## 5. Liquidity blocks

DEX tab → 유동성 공급 전략 → 조금씩 모으기 → 넣을 돈 $5 → 공급하기.
Your wallet signs the exact-amount approval, then one transaction that mints every block. Then remove it again
from 이 풀의 내 포지션.

Record the approval, the mint and the removal.

## 6. Withdraw

Account menu → Withdraw everything.
Record it.

## Record

| Step | Transaction | Date |
| --- | --- | --- |
| Deposit | | |
| Approved agent trade | | |
| Daily limit (owner) | | |
| Auto trade | | |
| Stop-loss setting (owner) | | |
| Liquidity: approval / mint / removal | | |
| Withdraw | | |
