# REPLAN.md — Re-plan v2 (2026-09-24)

Status: **Draft · awaiting human approval.** Written by the cloud-session Claude at the user's request. It is based on the 2026-09-24 review by 5 judges (technical, creativity, DX, UX, special prizes) and the G1 measurements.

**Progress (9/24 pm, user: "development side only").**
- The money and cap decisions (R1~R4, R9) are **on hold**. The code reads the current cap values from config. Once they are decided later, only the settings need to change.
- Among the development items, the §5 design hardening has been applied to SPEC v2. The wording of G3 conditions 2 and 3 has also been fixed.
- M1-02 `decideCycle` (a pure function) is implemented. 57 tests, 100% branch coverage in `packages/core`.
- Not executing RFQ (R6) and judging the price gap only against an independent stock price (R8) are in the code as pre-decision defaults.
Once decisions R1~R12 in §2 are approved, they are applied to PLAN, SPEC, TASKS, GOALS and DECISIONS. For UX_COPY, draft copy is proposed and a human finalizes it. This file stays as a record.

## 0. Why re-plan

| Criterion (weight) | If submitted now | If the old plan is finished as is | New plan target (10/8) |
| --- | :-: | :-: | :-: |
| Technical (30%) | 3 | 8 | 8.5 |
| Creativity (25%) | 4 | 6 | 7.5 |
| DX report (25%) | 5 | 8 | 8.5 |
| Product and UX (20%) | 1 | 6 | 7.5 |
| **Weighted total** | **3.4** | **7.1** | **about 8.0** |
| AW special prize | 1 | 5 | 7 |
| Studio special prize | 0 | 3 | Cut (identity registration only, optional) |

Even following the old plan, the score is 7.1. There are four causes.
1. **The key scene never happens.** The house yield plan's principal is $200~500 at 3.16% a year. Interest from 9/30 to 10/23 comes to $0.40~1.00. The minimum buy is $2, so interest alone never buys even once. The Judge Mode $20 deposit earns about 1 cent a week.
2. **The US regular session is 19% of the week** (KST 22:30~05:00). An Asian judge who visits during the day sees only "market closed". Binance already offers recurring bStock purchases 24 hours a day.
3. **We have not used Agentic Wallet even once yet.** It sits at the very end of the schedule (M2). According to the docs (llms-full.txt L7212), only eligible users in permitted regions can buy bStock. Whether it works from Korea (Q-02) is unknown.
4. **The live-trade design has holes.**
   - The web and the worker sign with the same house wallet. Nonces can collide, or a buy can be duplicated.
   - There is no PENDING state.
   - The 60-second quote assumption is wrong (measured: 30 seconds).
   - G3 condition 3 is contradictory. Simulation takes 1 tx at a time, so a swap simulation cannot succeed before the approval is on chain.

We also checked competing entries. All are BNB Hack entries, and none has an interest or savings feature.
- OneTicker: 5-minute tape, safety gate, $25 limit, Wallet Skill
- Roost: "the server decides, the wallet executes"
- Closing Bell Agent: market-hours blocking, multiplier correction, simulation before signing

Our one differentiator is "principal deposited, buy with the interest". That is why cause 1 is fatal.

**What does not change.**
- The product definition
- Decisions are made in code (no LLM)
- Caps, exact approvals, simulation before broadcast
- A DX report written by humans
- The PLAN §8 never-cut list

## 1. Four strategy changes

**S1. Make the scene where interest buys stock actually happen, from 10/1.**
- Set the house H-YIELD principal to $1,000 and the bStocks minimum buy to $0.25. It buys with interest alone about every 3 days. 7~9 buys are expected by 10/23.
- Put a "Bought with interest only" label on the receipt.
- Put a live interest counter on the Watch home. BSC blocks come every 0.45 seconds, so the number keeps rising.
- Show progress such as "$0.07 to the next buy".

**S2. A judge ends with a receipt, whatever time they arrive.**
- During the regular session, it buys $5.
- Off-hours, it buys at half the limit ($2.50) and first discloses the off-hours premium measured from the tape. This promotes the D-08 option to the default Judge Mode path.
- The tickers are NVDA, TSLA, MSFT and QQQ, which have bStocks. AAPL is only on Ondo and its minimum order is above $5, so it cannot be bought within the $5 limit and is dropped.
- House plans keep buying only during the regular session. That is a product principle, backed by the tape data.

**S3. Move Agentic Wallet from the very end to the very front.**
- Run the M0-09 test tonight (9/24): a small live buy, recording the session and limits.
- During 10/1~10/9, actually run our skill with the team Agentic Wallet every time the US market opens. 10 minutes each time, with a human confirming. Receipts and measured session expiries pile up.
- The server verifies user-reported txs on chain. If the decided amount, token or recipient differs, it pauses the plan. Mode C's limits become code, not copy.
- Why the house uses a server wallet instead of Agentic Wallet is answered with the measured session expiry (48h, QR re-login).

**S4. Put data unique to tokenized stocks on screen. Drop guards that lack evidence.**
- Off-hours premium chart: off-hours quotes vs regular-session quotes for the same ticker. The source is the tape.
- Upcoming multiplier change notice: bStocks `effectiveAt`, `newUIMultiplier`.
- Issuer comparison table: minimum order, session info, route.
- The "gap vs reference price" guard is removed from decisions and the UI, because the reference price is derived from the token price (Q-06). It comes back once an independent quote is confirmed.

## 2. Decision list (approval needed)

"yes needed" marks items that fall under CLAUDE.md rule 5 (cap changes, new spending paths) or that involve money.

| # | Decision | Recommendation | Notes |
| --- | --- | --- | --- |
| R1 | House H-YIELD principal | **$1,000** (alternative $500) | yes needed (money). At $500, an interest buy happens about once every 6 days, around 4 by 10/23 |
| R2 | Minimum buy per issuer | **bStocks $0.25, Ondo $5.01** (currently $2 for both) | yes needed (cap). bStocks also returns quotes for $0.10. The real swap minimum is checked in G4b |
| R3 | House wallet ceiling | Deposited principal ≤ $1,000 (MAX_PRINCIPAL) + operating funds ≤ $400 (currently total ≤ $300) | yes needed (cap) |
| R4 | Splitting the $50 daily limit | **House $10 + judges $40**, total unchanged | yes needed (spending rule) |
| R5 | Judge Mode | Allow $2.50 off-hours + disclosure / the interest trial is **$5 deposit → live interest → redeem** (down from $20, within the per-trial limit) / drop AAPL | Product decision |
| R6 | Q-15 RFQ | **Not used.** SWAP route only; if the quote is RFQ, DEFERRED | Creates no new spending path |
| R7 | Q-16 DeFi unlimited APPROVE | **Do not sign it**; encode an exact-amount approve ourselves (spender checked against the DEPOSIT `to`) | Keeps the safety rule |
| R8 | Q-06 price gap guard | **Excluded from decisions and the UI.** If `underlying-market` is an independent quote, replace it with that | Final after 1 check |
| R9 | Mode C real use | With the team AW, 10/1~10/9, a $2~5 bStock buy every session + a Venus $20 deposit and redeem once, all through our skill | yes needed (new spending path) |
| R10 | Cut now | b402 and x402 (M3-01), Agent Studio runtime, sector targets, Telegram user alerts, RFQ. **ERC-8004 identity registration only** as an M3 option (within 2 hours) | Cut line applied early (human agreement) |
| R11 | Copy and users | Tagline **"Interest buys the stock."** ("Principal stays" removed), KR "Collect stocks with interest". 1 line explaining the token before the first buy. Real users = AI assistant users (P3); savers (P1) try it by browsing and through Judge Mode | UX_COPY draft → human finalizes |
| R12 | Division of work | **Cloud Claude**: offline code, web, skill docs, reviews / **PC Claude**: Binance API, mainnet, deploys / humans: decisions, money, app QR, video, DX prose | Same branch, directories split by owner. Always pull before starting |

## 3. Schedule

The US regular session is KST 22:30~05:00 (weekdays). Assumes $1,000 principal.

| Date (KST) | Goal | Humans | PC Claude | Cloud Claude |
| --- | --- | --- | --- | --- |
| 9/24 Thu | Tape server running, decisions | Approve R1~R12 · 22:30 **M0-09 AW test** · Telegram questions | G2 (in progress) · M0-09 support | Write REPLAN → after approval, apply docs v2 |
| 9/25 Fri | Finalize docs v2 | Top up the house wallet (principal + operating funds) · Vercel account | Check `underlying-market` once · check the first regular-session tape | PLAN/SPEC/TASKS/GOALS v2 · start **G3a** |
| 9/26 Sat~9/27 Sun | M1 core | 9/27 self-assessment + DX first draft (English) | **G3b** live verification (`cycle:once` simulate) | G3a: schema, decideCycle, executor, error taxonomy, holdings |
| 9/27 Sun~9/28 Mon | First live trade | Be present | **G4a** H-YIELD deposit (regardless of market hours) · **G4b** Mon 22:30 first safe-mode buy (including the exact approval) | — |
| 9/29 Tue~9/30 Wed | Unattended operation | Check | **G5** scheduler and 2 house plans running on Fly | **G8** Skill API (`/next`), Wallet Skill v1 · start the web |
| 10/1 Thu | Interest buys start | Mode C real use starts (10 min every night) | Skill run support | Web |
| 10/1~10/4 | Productization | 10/3~4 phone test with 5 non-crypto people · 10/4 self-assessment and cut decision | Live integration verification | **G6** web (Watch, Judge Mode, stop, redeem, disclosure, KR/EN, mobile) · **G7** reduced guardian, corporate actions, /dx, smoke |
| 10/5~10/7 | Polish | 10/6~7 **video shoot** (interest receipts, skill run, Judge Mode) | Incident rehearsal | **G9** README, security, runbook · (optional) ERC-8004 |
| 10/8~10/9 | Submission | Final DX report · video edit · submit | Freeze | Submission check |
| 10/10~10/11 | Buffer | Hotfixes only (smoke required) | | |
| 10/12~10/23 | Judging | Check smoke daily | Keep the house and the tape running | |

## 4. Scope v2

**Must** (what the judges see)
1. Run the 2 house plans continuously on mainnet
   - H-SAFE: NVDA bStocks, regular session, $5 a day
   - H-YIELD: $1,000 principal deposited in Venus, buying bStocks with interest only
2. Decision engine: window, interest accrual, per-issuer minimums, daily limit split, ticker status, price impact
3. Execution: single-signer worker, exact approvals, simulation result check, outbox and PENDING, receipts
4. Judge Mode: a receipt at any hour, interest trial, stop and redeem
5. Watch home: live interest counter, house receipts ("Interest only" label), off-hours premium chart
6. Wallet Skill v1 + `/next` + server-side receipt verification + a record of real use on the team AW
7. Reduced guardian with 4 rules (Venus paused, utilization 95%, USDT depeg, price impact 1%) + ticker status (statusInfo) handling
8. Share-count display (multiplier) and upcoming multiplier change notices, KR/EN, mobile, risk disclosure, LIVE/STALE/UNAVAILABLE
9. Instrumentation: api_calls, tape, /dx (p50/p95, error codes, off-hours premium), smoke
10. README judging path, video, human-written DX report

**Should**: ERC-8004 identity (within 2 hours), Telegram ops alerts, TVL crash guard

**Cut (now)**: b402 and x402, Agent Studio runtime, sector targets, Telegram user alerts, RFQ route, mode D, BNB staking, best execution across issuers

## 5. Live-trade design hardening (SPEC change list)
1. **One signer.** The house key lives only on the Fly worker. The web's `POST /api/plans/:id/run` puts a job in the DB job queue and the worker runs it. Vercel has no key.
2. **Outbox and nonce.** A signed tx is saved to the DB before broadcast and left as `PENDING`. The worker reconciles at startup. Use `PENDING/CONFIRMED/FAILED` instead of `fundsMoved: boolean`.
3. **Cap reservation.** The spend_ledger reservation happens in the same DB transaction as the cycle (removes the TOCTOU).
4. **Order.** Exact approval → confirm its receipt → fresh quote (within 25 seconds) → swap calldata → simulation → sign → broadcast. There are two reasons: simulation takes 1 tx at a time, and a quoteId is valid for 30 seconds (Q-04).
5. **`simulate()` throws if `status !== 'SUCCESS'`.** The same holds even when the response is code 0 (Q-14).
6. **Fixture replay tests**: 40401, 42900, 40375, simulate FAILED (inside code 0).
7. **Market hours are judged by our own clock and holiday table.** bStocks statusInfo says TRADING even off-hours. statusInfo is used only as a trading-halt signal.
8. **Tape idempotency key**: slot + instrument + size unique (G2 condition 4).
9. **G3 condition 3 fix.** In simulate mode, the requirement goes as far as "approval simulation SUCCESS + print the swap simulation's allowance failure reason in plain words". Approval → a successful swap is checked in G4.

## 6. /goal order v2

| Order | Goal | Who | What changed |
| --- | --- | --- | --- |
| 1 | G2 tape Frankfurt | PC | Unchanged (in progress) |
| 2 | M0-09 AW test | Human + PC | Not a /goal. Run tonight following the instructions |
| 3 | G3a M1 core (offline) | Cloud | Includes §5. Schema, decideCycle, executor, error taxonomy, holdings, fixture replay |
| 4 | G3b M1 live verification | PC | `cycle:once` simulate, approval simulation |
| 5 | G4a deposit / G4b first buy | PC + human present | The deposit does not depend on market hours. The first buy is on the night of 9/28 |
| 6 | G5 scheduler and house plans | PC | v2 values for principal and minimums |
| 7 | **G8** Skill API and Wallet Skill | Cloud code + PC real use | **Moved ahead of G6** |
| 8 | G6 web | Cloud (+ human for Vercel) | Judge Mode off-hours path, interest counter, off-hours premium |
| 9 | G7 guardian, /dx, smoke | Cloud + PC | Guardian reduced to 4 rules |
| 10 | G9 M3 | Cloud + PC | b402 and x402 removed |

The GOALS.md text itself is rewritten after approval.

## 7. DX report plan
- **Humans**
  - Write `- Impression:` on every entry, on the same day.
  - First draft 9/27, second 10/4, final 10/8. Write it **in English from the start** (translating mixes in an AI writing style).
- **Agent (organizing the evidence)**
  - Switch doc citations from line numbers to URL + original text.
  - Record `X-OC-TIMESTAMP`.
  - Commit `dx/metrics.md` every week (Frankfurt p50/p95).
  - Build a tape summary.
  - Mark the entries that were our own mistakes.
  - Drop weak entries from the report candidates.
- **AI stack section**: the M0-09 record + a daily log of real skill use + measured session expiry and re-login
- **Top 3 redesign proposal candidates** (humans make the final pick)
  1. Unattended runs are impossible because of the AW session (48h)
  2. Multi-tx simulation/state override
  3. Documenting the rate-limit window method plus a reset header, or a DeFi exact-amount approval option

## 8. Money (human decision)

| Item | Amount | Nature |
| --- | --- | --- |
| House H-YIELD principal | USDT $1,000 | Venus deposit, redeemable (carries protocol risk) |
| House operating funds | USDT about $350 + BNB about $10 | H-SAFE $5 × 18 trading days ≈ $90, judge buys and interest trials, gas |
| Team Agentic Wallet | USDT about $60 + BNB about $5 | M0-09 + mode C real use + Venus $20 deposit (redeemed) |
| Fly.io | $2~4 a month | |
| Gas | About 0.00002 BNB per interest buy (redeem, approval, swap) | Based on 9/24 gas of 0.05 gwei |

USDT spent on buys turns into stock tokens; it is not money that disappears.

## 9. Risks v2

| # | Risk | When checked | Response |
| --- | --- | --- | --- |
| N1 | Korean residents cannot buy bStock with AW (Q-02) | M0-09 tonight | The team AW uses Ondo at $6. Fix the copy |
| N2 | A plain wallet (EOA) is blocked from bStock/Ondo swaps | A small swap before G4b | Switch to Ondo (minimum $5.01). If that still fails, move the house plans to the team AW and have a human run them every day |
| N3 | 40303 from using the same key in Korea and Frankfurt at the same time | Observe after G2 | A separate API key for the server (human, portal) |
| N4 | The real bStocks swap minimum is above $0.25 | G4b | Raise the minimum to the measured value (with $1,000 principal, only the frequency drops) |
| N5 | No bStocks quotes on weekends | 9/26~27 tape | Weekend Judge Mode = interest trial + house record |
| N6 | Load on the humans' schedule (night attendance 9/24 and 9/28, 10 min daily 10/1~10/9, filming 10/6~7) | Ongoing | At least 5 runs is enough for mode C real use |
| N7 | Neon free compute limit (writes every 10 min) | 10/1 | If exceeded, switch to a paid plan or change the interval |

The existing R1~R10 stay. R2 is replaced by N1, R3 by N4, and R4 by S1.

## 10. Self-assessment targets (JUDGING §4)

| Date | Technical | Creativity | DX | UX | Weighted |
| --- | :-: | :-: | :-: | :-: | :-: |
| 9/27 | 4 | 5 | 6 | 2 | 4.4 |
| 10/4 | 7 | 7 | 7 | 6 | 6.8 |
| 10/8 | 8.5 | 7.5 | 8.5 | 7.5 | about 8.0 |

## 11. To-do today (9/24)
1. Read this document and approve or amend R1~R12 (human).
2. Continue G2 (PC).
3. **M0-09 AW test after 22:30** (human + PC Claude)
   1. Create an Agentic Wallet in the Binance app and put a small amount in.
   2. Install `baw` and log in.
   3. Check `wallet settings`.
   4. Get an NVDAB `market-order quote`.
   5. Buy $1~5.
   6. Look at the Venus `defi` preview.
   7. Save all output in `dx/LOG.md`.
4. Post 3 questions in the builder Telegram.
5. Once approved, after the G2 push, cloud Claude applies docs v2. At the same time, decide whether to change the working branch name in CLAUDE.md to the actual branch.
