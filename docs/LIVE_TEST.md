# LIVE_TEST — $1 live-trade test (DECISIONS D-21)

Author: the coding agent (9/27). A human reviews it. Human decision (9/27): live trades start at the $1 scale, minimum buy $0.25, operator redeem `pnpm yield:redeem` approved.

**Purpose.** Check the three paths where real money moves, once each at $1: Venus deposit, safe-mode buy, Venus redeem. The swap that buys with interest (GOALS G4 condition 2) is done after the principal is increased (REPLAN R1). The interest on $1 of principal is $0.0001 a day.

## 0. Principles

- **Signing happens only when a human types `y` in the terminal.** Live commands refuse to run outside an interactive terminal (`scripts/confirm.ts`). Claude (on a PC or in the cloud) only prepares, checks and records.
- **Run live commands inside the Fly worker machine**: `fly ssh console -a yieldvest-agent` → `cd /app`.
  - The API key is used from the same region (fra) and IP as the worker. Using it from a Korean PC risks concurrent multi-region access (40303) (DECISIONS Q-01).
  - The worker image contains the scripts and tsx (Dockerfile).
- **Leave the worker itself at `EXECUTION_MODE=simulate`** (fly.toml). Put `EXECUTION_MODE=live` only on the one live command line. The worker does not sign on its schedule; the only signer is that one command.
- The caps are unchanged: house $25 per tx, $50 per day, minimum buy $0.25 (D-21), principal cap $1,000. The total spend for this test is $2 + gas (a few cents).
- A failed spend is not retried automatically. Write down the cause; a human decides.

## 1. Preparation (human)

1. Merge the PR and deploy the worker.
   - `fly deploy -a yieldvest-agent`
   - It is ready when `fly logs -a yieldvest-agent` shows `agent: configuration valid` and then `tick:` lines.
   - Deploying the web app is optional (for checking the `/plans/H-SAFE` screen).
2. Check the Fly secret names: `fly secrets list -a yieldvest-agent`.
   - If `MIN_BUY_USD` is there, remove it or set it to `0.25`. The code default is now 0.25.
   - If `EXECUTION_MODE` is set to `live` as a secret, remove it (the simulate in fly.toml then applies).
3. Top up the house wallet (BSC): **USDT 3~5, BNB 0.005.**
   - The minimum is USDT 2 (buy $1 + deposit $1) and BNB 0.001. The balance cap is $300 (SPEC §14).
   - The operator who created the wallet knows the address (it is masked in logs and on screen).
4. Do the buy steps (5–6) **only during the US regular session**: 22:30–05:00 KST on a US trading day while the US is on daylight time (until 11/1; 23:30–06:00 KST after it) → start **after the open + 2 minutes** (22:32 KST). `/api/market/status` gives the next open. Deposit and redeem work at any time.

## 2. Procedure (inside `fly ssh console -a yieldvest-agent`, `cd /app`)

| # | Command | Expected result | Stop |
| --- | --- | --- | --- |
| 0 | `pnpm live:check` | Before the top-up, only `house` ✗ (`H-SAFE` also ✗ if H-SAFE is at $5) | `config`·`outbox`·`guardian`·`registry`·`web3api`·`rpc chain` ✗ |
| 1 | `pnpm plan:set --plan H-SAFE --contribution 1 --per-buy 1 --daily 1` | `changed H-SAFE (safe, paused): $5 daily … → $1 daily, per buy ≤ $1, per day ≤ $1 …` | `refused` |
| 2 | (after the top-up) `pnpm live:check` | `GO` | `NO-GO` |
| 3 | `pnpm yield:deposit --plan H-YIELD --usd 1` | Simulation JSON. Approval sim SUCCESS. Deposit sim FAILED is the expected result (in the simulation, the exact approval is not on chain yet). | Build error, approval FAILED |
| 4 | `EXECUTION_MODE=live pnpm yield:deposit --plan H-YIELD --usd 1 --live` → `y` | `approve`·`deposit` BscScan links, `deposited 1 USDT → … vTokens` | `not deposited …`. If `pending: approve <tx>` appears, nothing was deposited: once it is mined, run this step again (the allowance covers it; `--record` refuses an approval). If `pending: deposit <tx>` appears, once it is mined run `pnpm yield:deposit --plan H-YIELD --record <tx>`. The line says which |
| 5 | (regular session) `pnpm cycle:once --plan H-SAFE` | Simulation: NVDA bStocks $1 quote, approval sim SUCCESS | DEFERRED·SKIPPED (read the reason), FAILED |
| 6 | `EXECUTION_MODE=live pnpm cycle:once --plan H-SAFE --live` → `y` | BOUGHT, approval (exactly $1)·swap links, reason `why.bought.regular` | FAILED, `review` |
| 7 | `pnpm yield:redeem --plan H-YIELD` | Preview: `amountUsd` ≈ 1, `redeem.status` SUCCESS | `refused`, sim FAILED |
| 8 | `EXECUTION_MODE=live pnpm yield:redeem --plan H-YIELD --live` → `y` | `redeemed: https://bscscan.com/tx/…`, `H-YIELD is paused (operator_redeem)`, principal 0 | `not redeemed`. If `pending: <tx>` appears, after it is mined run `pnpm yield:redeem --plan H-YIELD --record <tx>` |
| 9 | `pnpm receipts:table`, `pnpm plan:status`, `pnpm live:check` | 5 receipts (approve·deposit·approve·swap·redeem), `outbox settled` | Unexpected receipts or balances |

**When it is over**, H-SAFE is halted at $1 (paused), and H-YIELD is halted with principal 0 (`operator_redeem`).

A human decides the next steps:
- Return H-SAFE to D-10's $5 per day: `pnpm plan:set --plan H-SAFE --contribution 5 --per-buy 5 --daily 5`.
- Decide the H-YIELD principal (R1, by 9/30): `pnpm yield:deposit --plan H-YIELD --usd <n>`.
- Put the worker on live and turn on both plans (G5): `plan:status --activate`.

## 3. Stop conditions (any one → stop, and do not repeat the same spend)

- `FAILED` with `fundsMoved: gas_only`, or the cycle went into `review`.
- A region or compliance code (40301~40304) shows up in a response.
- The house balance dropped by more than $1 + gas per step.
- A tx has not been mined for more than 3 minutes. New signing is blocked (`outbox`). On every tick (in simulate mode too) the worker reconciles with the chain — never a transaction a running command is still sending (that command holds the plan's lock; PD-07) — and once the tx is mined, it applies it only once, including its effects (principal, vToken, holdings, ledger) (DECISIONS D-23). When `outbox` in `live:check` becomes settled, confirm with `plan:status` that it was applied, and run `--record` only if it was not. If it has not cleared after 30 minutes, a Telegram alert arrives and a human decides per RUNBOOK §3.4.

If you stop: write the `pnpm live:check` output, the command output, the UTC time and the tx hash into `dx/LOG.md` (DX_PROTOCOL format), and a human decides.

## 4. Records

- Record the UTC time and the tx hash for every step.
- Surprises (responses that differ from the docs, slow confirmations, strange errors) go into `dx/LOG.md` the same day.
- When done, attach the evidence in `docs/TASKS.md`: M1-03 (buy receipt), M1-05 (deposit and redeem receipts).

## 5. `/goal` directive (for Claude on the PC, G4a)

Prerequisites (human): steps 1–3 of §1 done, a human at the terminal. Claude does not run `--live` commands (they are refused because there is no TTY). It tells the human the commands and checks the output the human pastes back.

```
Finish Yieldvest's $1 live-trade test. Read docs/LIVE_TEST.md and DECISIONS D-21. A human is present, and every real spend happens only when the human runs `EXECUTION_MODE=live pnpm … --live` on the Fly worker machine (fly ssh console -a yieldvest-agent, cd /app) and types y. You run only read-only checks yourself: `fly ssh console -a yieldvest-agent -C "sh -c 'cd /app && pnpm live:check'"`, simulation commands (no --live), `plan:set` (only while H-SAFE is paused), receipts:table, plan:status. Completion conditions: 1) live:check was GO before the first live step (quote the output). 2) H-YIELD $1 deposit: quote the deposit receipt tx hash and that the approve amount was exactly 1 USDT (1000000000000000000). 3) H-SAFE $1 buy BOUGHT during the regular session: quote the swap receipt hash, approve amount = 1 USDT, reason why.bought.regular. 4) H-YIELD redeem: quote the redeem receipt hash, plan paused (operator_redeem), principal 0. 5) Afterwards, outbox in live:check is settled, the errors, latency and doc mismatches encountered are written in dx/LOG.md, and the evidence is attached to TASKS M1-03 and M1-05 and committed. Constraints: total spend for this whole goal at most $2 + gas, do not change caps, no new spending paths, no Binance Web3 API calls from the Korean PC (Q-01), no automatic retry of a failed spend — record the cause and ask the human. At the end of every turn, report conditions 1~5 as PASS/FAIL with evidence (quoted tx hashes and output) in a GOAL STATUS block. If you cannot finish within 15 turns, write down the remaining items and the reason and stop.
```
