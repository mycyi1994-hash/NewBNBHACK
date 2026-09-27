# GOALS.md — `/goal` directives (for Opus 5.5)

Authors: Jiwoo Park, Dohyun Lee. With `/goal`, Claude keeps taking turns on its own until the condition is met, and at the end of every turn a separate evaluator model judges it "met/not met/impossible" (official docs: https://code.claude.com/docs/en/goal.md). The directives are therefore written to the principles below.

## 0. Usage principles
1. **One goal at a time.** In the order below. Do not give the next goal before the previous one is finished.
2. **Work that needs human hands does not go inside a goal.** A human finishes each goal's "prerequisites" first. (API keys, accounts, funds, the Telegram answer)
3. **The evaluator model sees only Claude's output.** That is why every goal is written to "report, at the end of every turn, a `GOAL STATUS` block with PASS/FAIL per condition and evidence (quoted command output)". If Claude leaves this block out, the evaluation becomes unreliable.
4. A **turn cap** is included to prevent infinite loops. On hitting the cap, Claude is told to write down the remaining items and the reason, then stop.
5. Recommended setup: open Claude Code in **auto mode** at the repo root and enter `/goal <condition>`. Check progress with `/goal`; stop with `/goal clear`. The check-in interval for background work is `CLAUDE_CODE_GOAL_CHECKIN_MINUTES` (default 30 minutes).
6. If a goal ends as "impossible", read the reason, fix the prerequisites, then give the same goal again.
7. What a human does between goals: check `git log` and the changes to `docs/TASKS.md`, add `- Impression:` to `dx/LOG.md`, and check the receipts if anything was spent.

## 0-1. When `/goal` is not available (alternative ways to run)

According to the official docs, there are three reasons `/goal` can be missing from the slash-command list (https://code.claude.com/docs/en/goal.md).
1. **The version is too old.** The docs do not state the version that introduced it, but the minimum versions of related features are in the v2.1.234~2.1.269 range. Check with `claude --version`, update with `claude update` (for an npm install, `npm i -g @anthropic-ai/claude-code@latest`; for Homebrew, `brew upgrade claude-code`), then press `/` and see whether `goal` is there.
2. **A setting is blocking it.** If `~/.claude/settings.json` or the project's `.claude/settings.json` has `disableAllHooks: true`, or the organization's managed settings have `allowManagedHooksOnly`, `/goal` is disabled (it is part of the hooks system). In that case, typing the command tells you why.
3. **The workspace is not trusted.** It follows the same trust rules as hooks. Mark the repo folder as trusted.

If it is still missing, run the same directive in one of the three ways below. Do not change the directive text.

**Alternative A — `/loop` self-paced (recommended).** `/loop` re-sends the same prompt at every interval; if you omit the interval, the model sets its own pace, and it stops when the model judges that it is "done". Add two sentences before and after the goal text:

```
/loop Keep working on the following goal until every condition is PASS. At the end of each round, write a GOAL STATUS block; when every condition is PASS and the work is committed, write "GOAL COMPLETE" and end the loop. If you reach the turn cap, write "GOAL STOPPED: reason" and end the loop. --- [paste the G0~G9 text here verbatim] ---
```

**Alternative B — plain prompt + manual continue.** Send the goal text as an ordinary message. When Claude stops, reply `Continue only with the items that are FAIL in GOAL STATUS`. This is the simplest, and for G4, which spends money, this way is actually the safer one.

**Alternative C — automatic continue with a Stop hook (docs: https://code.claude.com/docs/en/hooks-guide.md).** A prompt-type `Stop` hook sends a condition prompt to a small model at the end of every turn; on `{"ok": true}` Claude stops, and on `{"ok": false, "reason": "..."}` the reason is handed back to Claude so it keeps working. It is the closest to `/goal`, but differs in two ways: (a) it lives in a settings file, so it applies to **every session** in that scope → put it in **`.claude/settings.local.json`** (gitignored), not in `.claude/settings.json`, which is committed to the repo, and delete it when you are done. (b) Consecutive blocking is limited to **at most 8 times**, after which it stops → a human typing "continue" once gives another 8. `/loop`'s self-pacing also ends after at most 7 days.

`.claude/settings.local.json`:
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Read the assistant's final message. It must contain a GOAL STATUS block that lists every numbered goal condition as PASS or FAIL with evidence. Respond {\"ok\": true} if (a) every condition is PASS and the message states the work is committed with a clean git status, or (b) the message says GOAL STOPPED because the turn cap was reached, or (c) the message states that the next step needs a human (API key, account, funds, a y-confirmation for spending). Otherwise respond {\"ok\": false, \"reason\": \"<name the FAIL conditions and tell Claude to keep working on exactly those, ending the turn with a GOAL STATUS block>\"}."
          }
        ]
      }
    ]
  }
}
```
With this hook on, just send the goal text as an ordinary message. **Turn the hook off for G4, which spends money.**

## 1. Sequence

| Goal | Content | Prerequisites (human) | Fund movement | Turn cap |
| --- | --- | --- | --- | --- |
| G0 | Repo bootstrap · doc verification · client offline part | None | None | 30 |
| G1 | API reachability · inventory · small quotes · Venus spike · tape running locally | API key, local Postgres, house wallet address | None | 40 |
| G2 | Deploy the tape to a Frankfurt host | Neon DB, Fly/Render app and token, env setup | None | 15 |
| G3 | Finish the M1 core (schema, decision engine, execution adapter) in simulate mode | None | None | 40 |
| G4 | First mainnet receipts (1 safe, 3 yield mode) — human present | House wallet top-up, regular hours, a human types `y` | **Yes (≤$60)** | 15 |
| G5 | Scheduler · idempotency · 2 house plans running on the host | G2 host | Yes (automatic, within caps) | 20 |
| G6 | Web: Watch · Judge Mode · stop · risk disclosure · i18n · copy lint | None | None | 40 |
| G7 | Guardian · corporate actions · /dx · smoke · monitor alerts | Telegram bot token, uptime monitor account | None | 30 |
| G8 | Skill API + Wallet Skill + Agent Studio code part | `bag` spike result (Q-09) | None | 25 |
| G9 | M3: README judging path · security check · runbook · incident rehearsal · b402 | Deploy URL, video link | Yes (small x402 amounts, optional) | 25 |

The full text of each goal is below. Paste it as is after `/goal ` (confirmed to be within 4,000 characters).

---

## G0 — Bootstrap

```
Finish the Yieldvest M0 bootstrap. First read CLAUDE.md, docs/JUDGING.md, docs/TASKS.md. Completion conditions (all must be met):
1) M0-01: a pnpm workspace has been created and apps/web (Next.js App Router), apps/agent, packages/{core,binance,chain,db,config}, skills/yieldvest, scripts, fixtures, dx exist, and `pnpm install && pnpm typecheck && pnpm lint && pnpm test` all exit 0 (quote the last output line of each command). .github/workflows/ci.yml runs the same three commands. packages/config validates every variable in .env.example with zod, and the cap constants (HOUSE_MAX_PER_TX_USD etc.) are read only there.
2) M0-02: `bash scripts/fetch-docs.sh` succeeds and docs/vendor/llms-full.txt exists (quote its line count), @binance-web3/wallet is installed as a devDependency, and docs/vendor/ENDPOINTS.md lays out in a table the paths, methods, required parameters and main response fields of each module (RWA Data, General market data, Trading, Transaction, Wallet, Address portfolio, DeFi data, DeFi transaction, b402, Authentication), citing llms-full.txt section titles as the source. For the ⚠️VERIFY items in docs/SPEC.md §3.1 that can be confirmed from the docs alone (base URL, signing string composition, header names, envelope, rate limits, quote validity time), the results are recorded in docs/DECISIONS.md §2. Leave items not found in the docs as "Unconfirmed: reason".
3) M0-03 offline part: packages/binance has a signing function, an envelope parser (including handling of errors returned with HTTP 200), a per-endpoint token bucket, an api_calls logging hook and a fixture-saving option, and a passing test name shows that the signature vector test produces the same signature as the connector source. `pnpm reach` exists and prints "UNAVAILABLE: no API key" when there is no key.
4) M0-12: doc mismatches and questions found during this work are added to dx/LOG.md in the docs/DX_PROTOCOL.md §3.1 format (if there are none, a "No findings" entry).
5) In docs/TASKS.md, M0-01, M0-02, M0-12 and the M0-03 offline items are updated to [x] with evidence, and every change is committed so `git status` is clean.
Constraints: no fund movement, do not commit .env, no mock data, no out-of-scope features, do not invent endpoints that are not in the docs. At the end of every turn, report each of conditions 1~5 as PASS/FAIL with evidence (quoted command output) in a "GOAL STATUS" block. If you cannot finish within 30 turns, write the remaining items and the reason in GOAL STATUS and stop.
```

## G1 — Reachability, spikes, tape (local)

Prerequisites: in `.env`, BINANCE_WEB3_API_KEY/SECRET, DATABASE_URL (local Postgres), HOUSE_WALLET_PRIVATE_KEY (or just the address), REGION_TAG=kr-dev. A human first writes into dx/LOG.md the time the portal was opened and the time the key was issued.

```
Finish the Yieldvest M0 spikes. Read CLAUDE.md, docs/TASKS.md M0-03~M0-08 and docs/DECISIONS.md §2. Completion conditions (all must be met):
1) M0-03/04: on this machine, `pnpm reach` prints the HTTP status, code and latency in ms for unsigned reachability and for signed calls (RWA token list, Market price batch), and rows have appeared in the api_calls table (quote the SELECT count). The UTC time of the first successful signed call, and the error codes and causes encountered before it, are recorded in dx/LOG.md. If a regional block such as 40304 appears, write that fact in DECISIONS Q-01 and proceed with the remaining conditions as far as possible.
2) M0-05: the BSC token list has been fetched with the RWA Data API (fallback: the public bapi list type 1/2/3) and a per-issuer existence matrix for NVDA, TSLA, AAPL, MSFT, QQQ is recorded in DECISIONS; the symbol/decimals of each existing token have been verified on-chain (for bStocks, uiMultiplier too); and `pnpm registry` fills the instruments table (quote the row count). The code has no stock-token address constants.
3) M0-06: $1/$5/$50 quotes have been requested for at least 2 instruments (NVDA's bStocks and Ondo first), and expectedOut, priceImpact, route/vendor and error codes are recorded as a table in dx/LOG.md. If it is not the regular session (13:30~20:00 UTC), record only the off-hours results and write "Needs re-measurement in the regular session" in DECISIONS Q-03. A provisional MIN_BUY_USD value and a default issuer have been proposed in DECISIONS D-09/D-10.
4) M0-07: Venus protocol info (security score, TVL, APY) and the USDT investment item from the DeFi API have been saved as fixtures; the vUSDT address has been verified on-chain with symbol()/underlying(); and the functions that read exchangeRateStored and utilization and the interest calculation function (packages/core/amounts.ts) pass their tests. DeFi API deposit and redeem calldata has been taken as far as a Transaction API simulation with the house wallet address (no broadcast), and the results are recorded in fixtures and DECISIONS Q-05.
5) M0-08 local: the tape job in apps/agent records into tape_samples, every 10 minutes and per instrument, the on-chain price, reference price, market state and $5/$50/$500 quotes, and it has run locally for 60 minutes or more so rows have accumulated (quote the count at two points in time). `pnpm tape:once` works.
6) DECISIONS Q-03, Q-04, Q-05, Q-06, Q-12, Q-13, Q-14 are filled with an answer or "Unresolved: reason", the matching tickets in TASKS are updated to [x]/[~] with evidence, and everything is committed so git status is clean.
Constraints: no broadcasts or fund movement (keep EXECUTION_MODE=simulate), mask keys and addresses in logs and fixtures, respect rate limits (5/s per endpoint). At the end of every turn, report conditions 1~6 as PASS/FAIL with evidence in a GOAL STATUS block. If you cannot finish within 40 turns, write down the remaining items and the reason and stop.
```

## G2 — Tape host deploy

Prerequisites: a Neon (Frankfurt) DATABASE_URL, a Fly.io or Render app created plus a CLI token, the API key, DATABASE_URL and REGION_TAG=fra set in the host env. Banned regions: ams, lhr, nrt, sin.

```
Run the Yieldvest tape on a Frankfurt host. Read docs/SPEC.md §13 and docs/TASKS.md M0-08. Completion conditions: 1) apps/agent is deployed to the Frankfurt region of Fly.io or Render and its state is running (quote the platform CLI status output, with the region stated). 2) A reachability check equivalent to `pnpm reach` has succeeded on the host, and api_calls has rows with REGION_TAG=fra (quote the SELECT). 3) tape_samples increased between two points in time 30 minutes apart after the deploy (quote both counts). 4) The restart policy is always, there is 1 instance, and the job has a lock or an idempotency key so there are no duplicate records even if the worker dies and comes back (quote the code location). 5) The final region decision and its rationale are recorded in DECISIONS D-06/Q-01, and TASKS M0-08 is updated to [x] and committed. Constraints: no fund movement; secrets only in the platform env, not in the repo. At the end of every turn, report conditions 1~5 as PASS/FAIL with evidence in a GOAL STATUS block. If you cannot finish within 15 turns, write down the remaining items and the reason and stop.
```

## G3 — M1 core (simulate)

```
Finish the core of Yieldvest M1 with EXECUTION_MODE=simulate. Read CLAUDE.md, docs/SPEC.md §4~§7 and §11, and docs/TASKS.md M1-01~M1-04, M1-07 and M1-08. Completion conditions (all must be met):
1) M1-01: the Drizzle schema has plans, cycles, receipts, holdings, instruments, api_calls, tape_samples, guardian_events, judge_codes, skill_tokens, spend_ledger; the migrations round-trip (up/down); and the seed creates the house plans H-SAFE (NVDA, safe, $5, daily, regular_session) and H-YIELD (the ticker from DECISIONS D-10, yield, weekly).
2) M1-02: decideCycle in packages/core is a pure function that implements WINDOW (regular session judged by our NYSE calendar, next open + 2 min), BUDGET (interest calculation, contribution, caps, MIN_BUY accumulation), ASSET (SKIPPED per corporate-action code, issuer fallback, issuer minimum order; sector targets excluded until the REPLAN R10 decision), PRICE (2% premium vs an independent stock price, SPEC §5.5 v2) and QUOTE (if price impact exceeds 1%, 2 re-quotes at half the amount; re-request a quote older than 25 seconds; no RFQ execution), and returns a CycleOutcome and a whyKey (only keys from docs/UX_COPY.md §4). There are 30 or more tests and packages/core coverage is 100% (quote the coverage summary).
3) M1-03/04: HouseWalletExecutor is implemented in the order exact-amount approval calldata → Transaction API simulation → (only when live) sign and broadcast → receipt polling → parse the amount actually received; and in simulate mode `pnpm cycle:once --plan H-SAFE` goes through all of DUE→RECORD and prints exact-amount approval simulation SUCCESS, a fresh quote, the swap calldata and the swap simulation result (if it fails on allowance because the approval is not on chain yet, state that reason in plain words; simulation is 1 tx at a time, so approval→swap success is confirmed in G4), and the conversion to amount and number of shares, and creates a cycles row (quote the output). Show in the code that the --live flag has a prompt that shows the amount, addresses and simulation result and requires typing y.
4) M1-07: the code mapping in docs/SPEC.md §11 is implemented with a unit test per code; 429 follows Retry-After; and the first time an unknown code is seen, a dx event is recorded.
5) M1-08: holdings keep a multiplier snapshot and shares=tokens×multiplier, and the multiplier-change detection test passes.
6) `pnpm typecheck && pnpm lint && pnpm test` exit 0, TASKS updated, committed, git status clean.
Constraints: no broadcasts or fund movement, no LLM calls in the decision path, no mocks (fixtures only in tests/ and fixtures/), no copy keys that are not in UX_COPY. At the end of every turn, report conditions 1~6 as PASS/FAIL with evidence in a GOAL STATUS block. If you cannot finish within 40 turns, write down the remaining items and the reason and stop.
```

## G4 — First mainnet receipts (human present)

Prerequisites: USDT ≥ $80 and BNB for gas ≥ $5 in the house wallet. US regular hours (KST 22:30~05:00). A human is at the terminal and types `y` at the `--live` prompt. Leave EXECUTION_MODE in `.env` as simulate and run only with the `--live` flag.

```
Produce Yieldvest's first mainnet receipts. Read docs/TASKS.md M1-03 and M1-05. A human is present, and every real spend happens only when the human types y at the `pnpm cycle:once ... --live` prompt. Completion conditions: 1) Safe mode: 1 buy of $5 or less with the H-SAFE plan is confirmed on mainnet; receipts has a swap row (and approve if needed) with a BscScan link; holdings reflects the number of shares; and the whyKey is why.bought.regular (quote the tx hash). 2) Yield mode: with the H-YIELD plan there is a deposit receipt for depositing the principal from DECISIONS D-10 (start with ≤ $50) into Venus, a redeem receipt for redeeming MIN_BUY_USD or more, and a swap receipt for buying with that amount. If the interest falls short of MIN_BUY_USD, fill the buy with a contribution alongside it, but record interest and contribution separately in the receipt amounts. 3) Every approval was for the exact amount (quote the amount on the approve receipt), and the broadcast path (transaction_api or rpc) is recorded in receipts.broadcastVia. 4) spend_ledger reflects today's total spend exactly (quote the SELECT). 5) The errors, latency and doc mismatches encountered are recorded in dx/LOG.md, and TASKS M1-03 and M1-05 are updated to [x] and committed. Constraints: do not exceed $25 per tx or $60 for this whole goal. Do not change caps. Do not add a code path that spends without a prompt. On failure, do not automatically retry the same spend; record the cause, then ask the human. At the end of every turn, report conditions 1~5 as PASS/FAIL with tx hashes in a GOAL STATUS block. If you cannot finish within 15 turns, write down the remaining items and the reason and stop.
```

## G5 — Scheduler and house plans running

Prerequisites: the G2 host, a house wallet balance, HOUSE_WALLET_PRIVATE_KEY and EXECUTION_MODE=live in the host env, cap values checked.

```
Make the Yieldvest worker run the 2 house plans autonomously on the host. Read docs/SPEC.md §5 and docs/TASKS.md M1-06 and M1-09. Completion conditions: 1) A test passes showing that the 5-minute tick prevents duplicate runs with the plans.lock_until lock and an idempotency key (planId:dueAt). 2) A tick while the market is closed creates a DEFERRED(market_closed) cycle whose retryAt is the RWA nextOpenTime, and nextDueAt is updated to nextOpenTime+2 min (quote the DB row). 3) On the host, H-SAFE and H-YIELD are active and the worker log shows ticks for both plans (quote the log). 4) A test message has confirmed that a Telegram ops alert is sent 1 time when a FAILED occurs (or, if there is no token, substitute a log alert and record that in DECISIONS). 5) Within 24 hours of the deploy, cycle records accumulate during the regular session as BOUGHT or as SKIPPED/DEFERRED with a reason (quote the count and the whyKey of the latest 3). If you cannot wait 24 hours, quote the results of the latest 2 ticks and the next scheduled time, and leave TASKS M1-09 at [~]. 6) TASKS M1-06 [x], committed, git status clean. Constraints: do not change caps, no new spending paths. At the end of every turn, report conditions 1~6 as PASS/FAIL with evidence in a GOAL STATUS block. If you cannot finish within 20 turns, write down the remaining items and the reason and stop.
```

## G6 — Web product (Watch, Judge Mode, stop, risk disclosure, i18n)

```
Finish the core screens of the Yieldvest web product. Read CLAUDE.md, docs/PLAN.md §5, docs/SPEC.md §8, docs/UX_COPY.md and docs/TASKS.md M2-01~M2-05. Completion conditions (all must be met):
1) `/` (Watch): 2 house plan cards (principal, interest accrued, shares collected, next buy), a receipt feed (one-line reason + BscScan link), a market status badge, data status LIVE/STALE/UNAVAILABLE and 2 CTAs render with real data. Even without an API key the page loads and shows the UNAVAILABLE reason.
2) `/judge`: code entry → stock/sector → mode (safe by default; turning on yield requires agreeing to the risk disclosure) → amount → preview (the Transaction API simulation shown via UX_COPY judge.preview.line) → 3 execution progress steps → receipt → [Stop this plan] works. Per-code caps, automatic stop after 7 days, and reset are implemented. The Playwright e2e `pnpm e2e` passes this flow end to end in simulate mode (quote the output).
3) `/plans/[id]`: timeline, limit usage, [Stop]. When a yield-mode plan is stopped, the full-redeem step is simulated and shown.
4) `/risk`: the full text of UX_COPY §5 (KR/EN). The yield-mode toggle does not turn on without consent.
5) Every string is based on UX_COPY keys and the screens are English only (9/27 D-26 — former condition: KR/EN toggle), and `pnpm lint:copy` reports 0 hits from §6 Banned words. A Playwright screenshot at a 375px viewport has no horizontal scroll (quote the passing document.scrollWidth<=375 assert).
6) `/api/judge/smoke` returns, as JSON, Web3 API reachability, RPC, DB, last tick, house balance, last receipt and latest tape time, and shows ok per item locally.
7) `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` exit 0, TASKS M2-01~05 [x], committed, git status clean.
Constraints: no mocks (e2e uses only simulate mode and fixtures), no hex addresses or token quantities on the first screen (use share counts and dollars), no MetaMask-style wallet connection, no fund movement. At the end of every turn, report conditions 1~7 as PASS/FAIL with evidence in a GOAL STATUS block. If you cannot finish within 40 turns, write down the remaining items and the reason and stop.
```

## G7 — Guardian, corporate actions, /dx, monitoring

Prerequisites: TELEGRAM_BOT_TOKEN/OPS_CHAT_ID, an uptime monitor account (a human registers the smoke URL).

```
Finish Yieldvest's guardian, corporate-action handling, /dx page and monitoring. Read docs/PLAN.md §7, docs/SPEC.md §6 and §10, and docs/TASKS.md M2-06, M2-07, M2-11 and M2-12. Completion conditions: 1) packages/core/guardian.ts implements the rules of PLAN §7 (protocol pause, TVL 24h −30%, utilization 95%, USDT<0.99 for 30 min, gap 2%, price impact 1%, limits, stock status, AW session) as GuardianInputs→GuardianAction[], and the per-rule tests pass. Show the code path by which the full-redeem action broadcasts only when the Transaction API simulation succeeds. 2) Guardian triggers are recorded in guardian_events and shown on Watch and the plan detail page with UX_COPY copy (quote the path of a screenshot of a manual trigger). 3) With RWA stock status ASSET_PAUSED/ASSET_LIMITED fixtures, SKIPPED(corporate_action) and the whyKey why.skipped.corporate_action.<reason> come out, and a test passes in which a sector plan is substituted with the next candidate. 4) `/dx` renders with real data a per-endpoint table of count, p50, p95, error codes and region based on api_calls, and 3 charts based on tape_samples (regular session vs off-hours gap, price impact by size, issuer comparison), and each chart has a caption on the measurement method. `pnpm dx:metrics` generates dx/metrics.md (quote the first 10 lines). 5) `/api/health` exists, and a test has confirmed that a Telegram alert is sent 1 time when smoke fails (if there is no token, substitute a log and record that in DECISIONS). 6) Tests exit 0, TASKS updated, committed, git status clean. Constraints: no fund movement, no mocks. At the end of every turn, report conditions 1~6 as PASS/FAIL with evidence in a GOAL STATUS block. If you cannot finish within 30 turns, write down the remaining items and the reason and stop.
```

## G8 — Skill API, Wallet Skill, Agent Studio (code part)

Prerequisites: answers to DECISIONS Q-07 (baw support for RWA and Venus) and Q-09 (bag runtime). The real baw run test (the [HUMAN] part of M2-09) is done together with a human after this goal.

```
Finish Yieldvest's Skill API and Wallet Skill. Read docs/SPEC.md §8.2 and §9, docs/TASKS.md M2-08~M2-10, and the format of docs/vendor/binance-skills-hub/skills/binance-web3/binance-agentic-wallet/SKILL.md. Completion conditions: 1) POST /api/plans (issues a skill token), POST /api/plans/:id/preview, GET /api/plans/:id/next, POST /api/plans/:id/report and POST /api/plans/:id/stop are implemented with token auth, rate limiting and cap checks, and the /next response contains what to do now (none|deposit|redeem|buy|stop), the amount, token addresses (with the registry source noted), baw command parameters (binanceChainId, fromToken, toToken, fromTokenQty etc.), a reason whyKey and an expiry time. An OpenAPI document is in docs/api/openapi.yaml and the integration tests pass with fixtures. 2) skills/yieldvest/SKILL.md follows the Skills Hub format (frontmatter name/description/metadata, requires bins baw, a check for the prerequisite skill binance-agentic-wallet), and references/plan.md, run.md, safety.md exist. safety.md states explicitly: read the risk disclosure aloud and get consent; preview and confirm before any state change; cross-check server-provided addresses against the public RWA list API; orderId≠fill (confirm FINISHED with market-order list); alert 2 hours before the session expires; pass errors on verbatim. 3) The procedure in run.md is, in order, /next → baw defi deposit|redeem or market-order quote→swap → check with market-order list → /report, and there are example conversations in KR/EN. 4) The `/skill` page shows the one-line install (final path), the 3-step guide and the "Yieldvest's server only decides. Signing always happens on your device." copy via UX_COPY keys. 5) Agent Studio: leave in docs/agent-studio.md a house-agent identity registration script and a registration procedure document if DECISIONS Q-09 is go, or a script and document for identity registration only if it is no-go (the real registration tx only after a human confirms). 6) Tests exit 0, TASKS M2-08 [x], M2-09 and M2-10 [~] (human parts left), committed, git status clean. Constraints: no code in which the server stores users' keys or sessions, no fund movement. At the end of every turn, report conditions 1~6 as PASS/FAIL with evidence in a GOAL STATUS block. If you cannot finish within 25 turns, write down the remaining items and the reason and stop.
```

## G9 — M3 polish (README judging path, security, runbook, incident rehearsal, b402)

Prerequisites: deploy URLs (web and worker), video link (placeholder copy if there is none), house wallet balance (if the optional x402 calls are made).

```
Finish Yieldvest M3. Read docs/TASKS.md M3-01~M3-06, docs/DEMO.md §2, and docs/SPEC.md §13 and §14. Completion conditions: 1) The top of README.md is filled in with the DEMO.md §2 structure (one sentence; live, video and DX links; the 3-minute trial steps; the house real-record table; the module matrix; the one-line Agentic Wallet install; risks; how to run; license), and the real-record table is generated from the DB by `pnpm receipts:table` (quote the first 5 rows of the table). 2) Security check: 0 hits in a secret scan (including git history), 0 unlimited-approve code sites (quote the grep), auth, rate-limit and cap-check tests on every write route, CSP and HSTS headers confirmed, 0 findings of high or above in `pnpm audit --prod` or the reason for the exception recorded. 3) docs/RUNBOOK.md: worker restart, DB recovery, house wallet top-up, the cap-change procedure (human approval required), a daily checklist for the judging window (10/12~10/23). 4) Incident rehearsal: prove with logs that for each of Web3 API blocked, RPC blocked and worker force-killed, the UI shows the STALE/UNAVAILABLE reason and the worker resumes without duplicates after restarting. 5) b402 (cut-line ranks 6 and 7, only if there is time): the paid plan report endpoint passes the 402→payment verification→200 flow with fixtures, or, if there is no time, mark TASKS M3-01 as [-] and record the reason in DECISIONS. 6) The draft of the 10/8 row of the JUDGING §4 self-assessment table (agent estimates; a human finalizes) is filled in, tests exit 0, committed, git status clean. Constraints: follow the no-deploys-after-10/9 rule, do not change caps, fund movement only for x402 calls, at most 0.2 U each and at most 2 U in total. At the end of every turn, report conditions 1~6 as PASS/FAIL with evidence in a GOAL STATUS block. If you cannot finish within 25 turns, write down the remaining items and the reason and stop.
```

---

## 2. What humans do between goals (summary)
- After G0: put the API key, local Postgres and house wallet address in `.env`. Record the portal and key-issue times in dx/LOG.md.
- After G1: record the Telegram answer in DECISIONS Q-02. Neon and Fly/Render accounts, env.
- After G3: top up the house wallet. Run G4 during regular hours (human present).
- After G5: first self-assessment (9/27 or 10/4).
- After G7: run the skill for real with baw (M2-09 [HUMAN]), confirm the Agent Studio registration, register the smoke URL with the uptime monitor.
- After G9: shoot and edit the video, write the DX report (human), submit.
