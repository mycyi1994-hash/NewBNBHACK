# RUNBOOK — Operating procedures (M3-06, SPEC §13)

Author: the coding agent (9/26). Commands run from the repo root. Secrets are never written here — they live only in the platform env.

## 0. Components at a glance

| Part | Where | What it does | Secrets |
| --- | --- | --- | --- |
| Worker `apps/agent` | Fly.io `yieldvest-agent` (fra, 1 machine, restart always) | Tape every 10 min, scheduler tick every 5 min (outbox settlement, guardian, jobs, plans that are due), web jobs every 3 s, registry every 24 h, Venus check every 6 h. **The only signer**. Outbox settlement (reconcile with the chain → finish the cycles that were waiting → apply txs from outside a cycle) runs **on every tick, whatever the mode** (DECISIONS D-23) | Binance Web3 API key and secret, house key, DB URL, Telegram |
| Web `apps/web` | Vercel (fra1), planned | Screens and API. Does not sign and does not call the Web3 API (only the DB the worker writes + public BSC RPC) | DB URL, `SESSION_SECRET`, `JUDGE_CODES` |
| DB | Neon Postgres | All state (plans, cycles, ledger, outbox, jobs, tape, api_calls) | — |
| Monitor | GitHub Actions `monitor.yml` | `pnpm smoke --alert` every 30 min (only on the default branch, only when the `YIELDVEST_APP_URL` variable exists) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPS_CHAT_ID` |

Execution mode: `EXECUTION_MODE=simulate` (the default) signs nothing. `live` signs **only for active plans**, within the caps. House plans are seeded as `paused(awaiting_funding)` and a human turns them on.

## 1. Daily checks (judging window 10/12~10/23, KST 09:00 and 21:00)

1. `pnpm smoke --url https://<web>` → is everything green? If something is degraded, write down which item.
2. Worker logs: `fly logs -a yieldvest-agent --no-tail | tail -100` (without `--no-tail` it never ends) — check that a `tick: <time> <mode> cycles [...]` line is printed **every tick (5 min)** (a quiet tick also gets one line), that `tape:` comes at 10-minute intervals, and that there is no `FAILED` or `errors:`. If smoke `worker` is degraded, the last tick had an error (the public response carries only the count and the source — the raw message is in this log).
3. `pnpm plan:status` — are the house plans' state and next time as expected?
4. House balance (smoke `house`): if the USDT is less than the daily cap ($50) × the days left, go to §5.
5. If `/dx` shows new findings (dx_events), copy the `pnpm dx:events` output into `dx/LOG.md`.
6. Write anything odd into `dx/LOG.md` with the UTC time (CLAUDE.md judging-window rule). Deploys are hotfixes only, with `pnpm smoke` after the deploy.

## 2. Stopping (do this first when anything looks wrong)

- Stop all signing: switch to `EXECUTION_MODE=simulate` on Fly and restart — `fly secrets set EXECUTION_MODE=simulate -a yieldvest-agent` (this includes the restart). From then on the worker signs nothing.
- One plan: `pnpm plan:status --plan <id> --pause --reason ops_hold`.
- Block one judge code: remove it from the web env `JUDGE_CODES` and redeploy → the web syncs the table at the first code check (codes not in the list are deactivated, only hashes are stored; if the list is empty, nothing changes). `pnpm db:seed` does the same sync.
- Revoke a skill token: set `skill_tokens.revoked_at` in the DB (`revokeSkillToken`) — skill plans are signed by the user's wallet, so none of our funds move.

## 3. Procedures by incident

### 3.1 Binance Web3 API errors or outage
- Symptoms: smoke `web3api` degraded/red, a spike in tape `quote errors`, tick `errors:`.
- Check: `pnpm dx:metrics` (code distribution per endpoint), `/dx`. 403/40304 means region or compliance (Q-01: the key is used from fra only); 429 is the rate limit (the client retries once, using Retry-After).
- Impact: decisions stop (nothing is signed without a quote and a simulation). The screens show the tape as STALE/UNAVAILABLE — this is expected behavior.
- Action: wait. After 30 minutes, check the Telegram alert and record it in `dx/LOG.md` (with the request id).

### 3.2 BSC RPC down
- Symptoms: smoke `rpc` red (the message is only `rpc unreachable` — the raw text is in the web log), the worker waiting for receipts.
- Action: switch `BSC_RPC_URL`/`BSC_RPC_URL_FALLBACK` to another public RPC and restart. If no receipt arrives within 3 minutes of a broadcast, the outbox row stays PENDING and new signing is blocked (§3.4).

### 3.3 Worker restart or crash
- `fly machine restart <id> -a yieldvest-agent`. A restart is safe: a tape slot is recorded only once (`tape_samples_slot_uq`), cycles are unique per (plan, due_at), the outbox is reconciled with the chain, and jobs the previous worker left `running` are closed as failed at boot (they are not run again — they may already have broadcast, and the awaiting-cycle handling finishes that result from the chain; the screen shows "see the plan history").
- Check: the log lines `agent: configuration valid`, `agent: scheduler registered`, then the next `tick:` line. At boot the worker checks that every RPC is on chain ID 56: on another chain the worker does not start, and an RPC that does not answer only leaves an `agent: … did not answer eth_chainId` warning.
- A cycle that a dead worker left `running` is cleaned up by the next holder of that plan's lock: if something was signed, it is finished from the chain (awaiting cycle); if not, it is closed as FAILED `INTERRUPTED`, its cap reservation is released and the plan moves on to its next time (DECISIONS D-23).

### 3.4 Outbox PENDING does not clear
- Symptoms: ticks report `outbox_busy`, no new cycle gets signed. After 30 minutes, Telegram sends `[yieldvest] outbox 0x…: … New signing stays blocked until a human checks it on BscScan`.
- Check: `select tx_hash, kind, status, broadcast_via, nonce, created_at, error from tx_outbox where status in ('SIGNED','PENDING');`, and look up the hash and that nonce of the house address on BscScan.
- What the worker does on its own: once the tx is mined, it sets CONFIRMED and applies the effects (holdings, ledger, principal) only once, together with the receipt. Bytes the node does not know are resent as the same bytes — but **a swap older than 10 minutes is not resent** (its quote is stale). Bytes still not mined 30 minutes after signing are put to a human: when the node does not hold them (refused at every resend, e.g. by an RPC node whose minimum gas price is above ours, or dropped every time) with the refusal text, and when it holds them but no validator mines them (under their gas floor). If the broadcast outcome is unclear (`broadcast_via='unknown'`), it treats the tx as possibly sent and leaves it PENDING. It never marks FAILED on a guess.
- What a human does (only when the alert has come in, and after finding the cause):
  - (a) **Our hash is mined** on BscScan: do nothing — once the node catches up, the worker confirms and applies it. If it still does not, switch `BSC_RPC_URL` to another RPC (§3.2).
  - (b) **Another tx used** that nonce (meaning the same key was used somewhere else — a possible key leak; do the full stop in §2 first): `update tx_outbox set status='FAILED', error='nonce used by another transaction (human, <date>)' where tx_hash='0x…';` → the next tick closes the cycle as FAILED and releases the reservation.
  - (c) **Bytes that are nowhere** (nonce unused: a stale swap, or a tx every resend was refused): if you decide not to send it, `update tx_outbox set status='FAILED', broadcast_via=null, error='dropped; not sent again (human, <date>)' where tx_hash='0x…';` — only with `broadcast_via=null` can the next tx reuse that nonce.
  - In every case, write the UTC time, the hash and the reasoning into `dx/LOG.md` (fund decisions = human).

### 3.5 DB outage and recovery
- The web does not die without the DB: the screens show "Unavailable (database unavailable)", the API returns 503 UNAVAILABLE, smoke is red 503 (rehearsal: `apps/web/test/read.test.ts` "answers 503 UNAVAILABLE, not a 500 page…", plus a local `next start` pointed at a DB on a closed port, which confirmed 7 screens at 200 with the reason shown).
- Recovery: point-in-time restore in the Neon console (branch restore) → replace `DATABASE_URL` → `pnpm db:migrate` (advisory lock, safe to run many times) → restart the worker.
- Rollback: `pnpm db:rollback <tag> --yes` (most recent migration only, `packages/db/drizzle-down/`).

### 3.6 Guardian triggered
- Telegram `[yieldvest] guardian …`. `redeem_all` (Venus paused, TVL −30%) pauses the yield plans (including **stopped** house and judge plans that still hold a position; their state stays as it is) and, in live only, redeems after the simulation passes. If a cycle of that plan holds the lock, or an earlier deposit or redeem has not settled yet, it does not redeem on this tick (`…:redeem_locked`/`…:redeem_pending`; it tries again on the next tick while the rule keeps firing). If the redeem fails, the plan stays paused and an alert goes out — a human decides. A worker in simulate mode signs nothing: a plan that holds a position is marked `…:redeem_not_live` and the alert says to run `pnpm yield:redeem --plan <id> --live` (since 10/1; before, it said nothing). The same marks apply to a stop (`stopped_by_owner:…`) and to an expired judge plan, which only a live worker stops while it still holds a deposit.
- A tick that could not read TVL or the USDT price (including 0 or empty values) is "no data", not "normal": that rule neither fires nor clears.
- A skill plan's principal is in the user's wallet, so the worker never redeems it (`redeemPlanPosition` owner check, test "never redeems a skill plan's position from the house wallet").
- Clearing is automatic (when the inputs read normal again). After it clears, a human turns paused house plans back on with `plan:status --activate`.

### 3.7 A cycle held for review (PD-07)
- Symptoms: Telegram `[yieldvest] <plan> cycle #<n> needs review: …` (a swap confirmed and no tokens arrived) or `… was interrupted after signing with no recorded decision`; the plan is paused (`needs_review`) and every cycle of it answers `outbox_busy`. `pnpm live:check` shows `review ✗ held for review: <plan> cycle #<n>`, and `pnpm plan:status --plan <plan> --activate` refuses with the cycle's number.
- Check: the cycle's transactions — `select tx_hash, kind, status, nonce from tx_outbox where cycle_id = <n>;` — each on BscScan: what left the house wallet and what arrived. Write the UTC time, the hashes and what you found into `dx/LOG.md` (fund decisions = human).
- Close it once every one of them is mined or settled (`CONFIRMED` or `FAILED`; while one is `SIGNED` or `PENDING` the close is refused and §3.4 applies): `pnpm plan:status --plan <plan> --close-review <n>` → it lists the transactions and asks for `y`. The cycle ends FAILED `CLOSED_AFTER_REVIEW` ("Held for review. A person checked its transactions on BscScan and closed it."), its cap reservation counts as spent, and the plan stays paused (`paused_by_operator`). A confirmed transaction of the cycle that is not written down yet is applied by the next tick like any finished cycle's late transaction; a swap with no recorded decision stays a human's to write down.
- Then `pnpm plan:status --plan <plan> --activate` when you want it to run again.

## 4. Changing caps (limits) — a human's explicit "yes" comes first (CLAUDE.md rule 5)

1. Write the new value and the reason in the conversation or in an issue, and get approval.
2. Set the same values in both the worker env and the web env: `HOUSE_MAX_PER_TX_USD`, `SANDBOX_MAX_PER_PLAN_USD`, `DAILY_SPEND_CAP_USD`, `MIN_BUY_USD`, `MAX_PRINCIPAL_USD`. The config is validated at boot: minimum ≤ per-tx ≤ daily, sandbox cap ≤ per-tx cap (the house wallet signs judge plans too), and each value must be **a plain decimal only** (up to 6 decimal places, greater than 0 and at most 1,000,000, `MIN_BUY_USD` ≥ 0.01). `25.`, `.5`, `+5`, `1e3` and `0x19` stop the boot — before deploying, check that the Fly and Vercel values set before the 9/27 audit are in this format (`fly secrets list` does not show values, so whoever set them checks). A cap left empty does not shadow the value in `.env`.
3. Restart → `pnpm smoke` → check the first cycle's log.

## 5. Topping up the house wallet

- The operator who created the wallet knows the address (it is masked in logs, screens and alerts). Smoke `house` shows only the balance. The key lives only in Fly secrets. The worker writes the address to the DB at `worker_status.house` (it never goes out through the public API) — the web uses it to refuse a skill plan created with this address, or a report of a tx the house sent.
- Balance ceiling $300 (SPEC §14). BNB: a small amount, for fees.
- Yield plan principal: `pnpm yield:deposit --plan H-YIELD --usd <amount>` (simulation first; live requires typing `y`; at most `MAX_PRINCIPAL_USD`).
- Taking principal back: `pnpm yield:redeem --plan H-YIELD` (preview) → `EXECUTION_MODE=live pnpm yield:redeem --plan H-YIELD --live` (`y`). It takes the whole position back to the house and pauses the plan (`operator_redeem`). Skill plans are refused (D-19, D-21).
- Run live commands inside the worker machine (`fly ssh console -a yieldvest-agent`, `cd /app`). Leave the worker in simulate and put `EXECUTION_MODE=live` on the one command line only. A simulate worker also settles the outbox every tick, so if a tx the command gave up waiting for gets mined, the worker applies it (`--record` is the backup). A live command first checks that every RPC is on chain 56, and signs only when the outbox is settled and it holds the plan lock. Order and stop conditions: `docs/LIVE_TEST.md`.

## 6. Deploy

- Worker: `fly deploy -a yieldvest-agent` (the Dockerfile fails the build if `.env*` is present). After the deploy, check the config-validation line in the log.
- Web: Vercel (`apps/web`, build `pnpm --filter @yieldvest/web build`). env: `DATABASE_URL`, `SESSION_SECRET` (32 characters or more), `JUDGE_CODES`, `NEXT_PUBLIC_APP_URL`. The web holds no house key and no API key.
- Always after a deploy: `pnpm smoke --url https://<web>`, `pnpm ui:check --url https://<web>` (375/1440px, English only, no CSP violations), `pnpm qa:check --url https://<web>` (accessibility, keyboard, motion, phone performance).
- After 10/9: hotfixes only.

## 6.1 Rename migration (D-24, once only)

The repo became Yieldvest on 9/27 (Fly app `ijaro-agent` → `yieldvest-agent`). Fly cannot rename an app, so create a new app and move over. **Always only one signer** — stop the old worker first.

1. Stop the old worker: `fly scale count 0 -a ijaro-agent` → check that `fly status -a ijaro-agent` shows no running machine. The outbox and cycles are in the DB, so the new worker picks them up as they are (the new worker's first tick settles any pending tx).
2. New app: `fly apps create yieldvest-agent` (the region is `fra` from `fly.toml` — the Web3 API key is used from fra only, DECISIONS Q-01).
3. Set the secrets again: check **only the names** with `fly secrets list -a ijaro-agent` (the values cannot be seen) → `fly secrets import -a yieldvest-agent < file` with the values from the password manager (the file stays outside the repo; delete it when done). Start with `EXECUTION_MODE` set to `simulate`. Check that the cap values are in the new format from §4.
4. Deploy: `fly deploy -a yieldvest-agent` → in `fly logs -a yieldvest-agent --no-tail | tail -50`, look for `agent: configuration valid`, no RPC chain-check warning, and a `tick:` line.
5. `pnpm smoke --url https://<web>` → `worker` green. After seeing a day of normal operation, `fly apps destroy ijaro-agent`.
6. GitHub: recreate the repository variable `IJARO_APP_URL` as `YIELDVEST_APP_URL` (the monitor reads only the new name). Likewise change `IJARO_TEST_DATABASE_URL` to `YIELDVEST_TEST_DATABASE_URL` in local dev shells.
7. The web (Vercel) keeps its env names. The cookie name changed, so existing judge sessions must enter their code again, and `ijr_` skill tokens are no longer accepted (new tokens are `yv_…`) — skill users use `YIELDVEST_URL` and `~/.config/yieldvest`.

## 6.2 Agent identity (ERC-8004), once, after the web deploy (DECISIONS D-33)

The agent's identity on the BSC registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` points at the file the web serves at `/api/agent`. `pnpm agent:register` puts exactly that file on chain, one transaction per run, and signs only with `AGENT_IDENTITY_PRIVATE_KEY` — **a fresh wallet, never the house key** (the config refuses the house key). It spends gas only: about 0.00005 BNB per transaction at 0.05 gwei (dx/LOG 10-02 14:17), refused above 0.001 BNB.

1. Make a fresh wallet and send it about 0.0002 BNB (two transactions and a margin). Keep its key in the password manager only — not a Fly secret, not a Vercel variable, not a file.
2. Run it in the worker machine, so the Transaction API simulation stays in `fra` (Q-01): `fly ssh console -a yieldvest-agent` → `cd /app` → `read -rs AGENT_IDENTITY_PRIVATE_KEY && export AGENT_IDENTITY_PRIVATE_KEY` (paste; nothing is echoed or kept in history).
3. Dry run: `pnpm agent:register --site https://<web>` — the file it read, the registry check (`AgentIdentity`/`AGENT`), "it would be agent N", the Transaction API simulation `SUCCESS`, and the gas. Nothing is signed.
4. `pnpm agent:register --site https://<web> --broadcast` → type `y`. It prints the BscScan link and `registered: agent <id>`.
5. Set `AGENT_ID=<id>` on the web (Vercel) and redeploy; `curl https://<web>/api/agent` now lists the registry entry, and `/skill` links to the agent.
6. In the same worker shell: `AGENT_ID=<id> pnpm agent:register --site https://<web> --broadcast` → `y`: `setAgentURI` writes the file with its registry entry (the SDK's second phase).
7. Check, any time: `AGENT_ID=<id> pnpm agent:register --site https://<web>` prints `current: agent <id> on chain holds the site's file byte for byte`. Then `unset AGENT_IDENTITY_PRIVATE_KEY` and leave the shell. Record the two tx hashes in TASKS M2-10.

## 7. Command list

| Command | Purpose |
| --- | --- |
| `pnpm smoke [--url] [--strict] [--alert]` | Check everything judging depends on, in one go |
| `pnpm ui:check [--url] [--out dir]` | 9 screens × Korean and US browsers × 375/1440px: horizontal scroll, page errors, CSP violations, non-English text (D-26) |
| `pnpm qa:check [--url] [--only a11y,keyboard,motion,perf]` | 9 screens: axe-core WCAG 2.1 A/AA at 375/1440px (serious or critical fails), skip link by keyboard, looping motion pauses and reduced motion stops it, phone profile (4× CPU, 150 ms / 1.6 Mbps) LCP, CLS, TBT and JS size (M3-02) |
| `pnpm plan:status [--plan id --activate/--pause \| --close-review <cycle>]` | List plans, turn them on, turn them off; close a cycle held for review after checking it (§3.7) |
| `pnpm plan:set --plan <id> [--contribution] [--per-buy] [--daily] [--cadence] [--window]` | Change a house plan's amounts and cadence within the caps (an active plan needs `y`) |
| `pnpm live:check [--usd 1]` | Check before a live trade (read-only, no Web3 API calls) → GO / NO-GO |
| `pnpm cycle:once --plan <id> [--live]` | 1 cycle (simulation first; live needs `y`) |
| `pnpm yield:deposit --plan <id> --usd <n>` | Deposit a yield plan's principal |
| `pnpm yield:redeem --plan <id> [--live] \| --record <tx>` | Redeem a yield plan's whole position (preview first; live needs `y`) |
| `pnpm agent:register [--site <url>] [--broadcast]` | The agent's ERC-8004 identity: register, then write the file with its id (dry run first; `--broadcast` needs `y`), §6.2 |
| `pnpm dx:metrics` · `pnpm dx:events` | DX metrics, new findings |
| `pnpm tape:summary [--days 30]` | The tape's numbers for the DX report: refusals, price impact, the gap to the US price, codes and token statuses → `dx/tape-summary.md` |
| `pnpm receipts:table` | README receipts table |
| `pnpm db:migrate` · `pnpm db:seed` · `pnpm db:rollback <tag> --yes` | DB |
| `pnpm alert:test` | Send one test Telegram alert |
