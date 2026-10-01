# JUDGING.md — Scoring criteria and how we aim at them

Author: Jiwoo Park (lead, hackathon strategy and DX). Reviewers: Minseo Kang, Dohyun Lee.
This document sits above every feature decision. If we cannot write down which row of the table below a feature scores in, we do not build it.

## 1. Official scoring criteria (verbatim)

Rechecked against the [organizers' official page](https://www.bnbchain.org/en/hackathons/tokenized-stocks) on 2026-09-27 and again on 2026-10-01: the criteria, weights, prizes, dates and rules are unchanged. Our own targets below (7 modules, 3-minute run-through, etc.) are kept separate from the official minimum requirements. Agentic Wallet / Wallet Skills and Agent Studio are optional.

> Scores are pooled after each judge has worked through every project on their own.

| Criterion | Weight | What we look at |
| --- | --- | --- |
| Technical implementation | 30% | Does it run, and how deep does the integration go? Modules used, error handling, how it holds up. |
| Creativity & originality | 25% | Were the APIs used in ways nobody expected? Does this already exist five times over? |
| Developer Experience Report | 25% | Specific, actionable, honest, no fluff. Includes the AI stack section. |
| Product quality & UX | 20% | Is it usable by the people it is for? Would it bring non-crypto-native users on-chain? |

Special prizes (can be won on top of a main prize; no separate application):
- **Best Use of Agentic Wallet / Wallet Skills** — $2,000 — "deepest, most credible use of the AI execution layer". The organizers' wording: Agentic Wallet is "Optional, **heavily weighted in scoring**".
- **Best Use of BNB Agent Studio** — $2,000 — "agent identity, autonomous runtime, and self-funding via x402".

Main prizes: 1st $6,000, 2nd $4,000, 3rd $3,000, 4th $2,000, 5th $1,000.

Also on the official page (quoted 2026-10-01):
- "Agents are welcome and expected, and are scored on how well they are built rather than on the PnL they could print, we don't track it for this edition."
- On the DX report: "Most hackathons do not ask for one. This one does, and it is worth a quarter of your score." and "Perfunctory or AI-generated reports are not accepted."
- Modules, as the page lists them: RWA Data API, Market API, Trading API, Transaction API, Wallet API, DeFi API, b402 Payments, Agentic Wallet / Wallet Skills, BNB Agent Studio.
- "Ideas to Build", verbatim: Natural-language strategy agent · Market-hours arbitrage · Cross-protocol arbitrage · On-chain vs reference price monitor · Auto-DCA and rebalancing · Earnings-calendar agent · TradFi-crypto portfolio agent · "Buy your first stock on-chain" · One-tap thematic baskets · MCP server or SDK wrapper. Judge Mode's default flow (a fixed $5 contribution) is "Auto-DCA" and "Buy your first stock on-chain"; what is not on the list is interest buying the stock, the session-window and corporate-action handling, and the session-aware LP hook (§4, Creativity).
- Dates (UTC): build from 16 Sep 12:00; **submissions lock Sun 11 Oct 12:00**; judging 12–23 Oct; winners the week of 26 Oct. Submission form, DX report template and registration are Google Forms linked from the page.

Track rules (gist of the original):
- Of bStocks, Ondo and xStocks, **at least one must be at the center of the submission**.
- Cross-asset (a stock leg + a crypto/stablecoin leg) is allowed. **Spot only**; no perpetual futures.
- **BSC mainnet only.** During the build, dry-run through the Transaction API; the demo uses small live trades.
- The repo, demo and deployment links must stay accessible throughout the judging window (10/12~10/23).
- Restricted regions: United States, Canada, Netherlands, Iran, Cuba, North Korea, Crimea, Donetsk, Luhansk, **United Kingdom, Japan**. (South Korea is not on the list.)

## 2. The judge's 15 minutes (the judging behavior we assume)

| Minute | Action | What we prepare |
| --- | --- | --- |
| 0–1 | README first screen | One-sentence definition, live link, video, Judge Mode guide, module matrix |
| 1–5 | Video (≤4 min) | The `docs/DEMO.md` script, exactly |
| 5–8 | Runs through it on the deployed link | Judge Mode: enter code → plan → simulation → run → receipt, 3 min |
| 8–10 | Skims the code | `packages/binance` error mapping, `packages/core` tests, no hardcoding or mocks |
| 10–13 | DX report | Timestamps, URLs, error codes, latency numbers, request list |
| 13–15 | Enters scores | Make sure we sit in the 9~10-point column of the rubric below |

## 3. Feature → criterion mapping (features not in this table are not built)

| Feature | Technical 30 | Creativity 25 | DX 25 | UX 20 | AW special prize | Studio special prize |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| House agent actually buys on mainnet, with receipts | ● | | ● | | | ● |
| Yield mode: deposit → interest → redeem → buy (DeFi API + Trading API) | ● | ● | ● | | | |
| Safe mode (contribution) as the default + risk disclosure | | | | ● | | |
| Buying in the regular-session window + showing the reason for off-hours holds | ● | ● | ● | ● | | |
| Corporate action code handling (earnings restriction, dividend and split pauses) | ● | ● | ● | | | |
| Showing the number of shares, not tokens (multiplier applied) | | ● | | ● | | |
| Guardian (protocol pause, TVL, utilization, depeg, price gap) | ● | ● | | ● | | |
| Judge Mode 3-minute run-through | ● | | | ● | | |
| Confirmation screen that shows the Transaction API simulation in plain words | ● | | | ● | | |
| Wallet Skill (the user's AI assistant executes with baw) | ● | | ● | | ● | |
| Decision API for the Skill (`/next`): the server only decides, signing is on the user's side | ● | | | | ● | |
| Agent Studio identity (ERC-8004) + runtime/MCP registration | ● | | ● | | | ● |
| b402: paid plan report endpoint + x402 calls to the official Stock Analyze Agent | ● | ● | ● | | | ● |
| /dx page: p50/p95 per endpoint, error codes, off-hours tape | | | ● | | | |
| Error taxonomy table and LIVE/STALE/UNAVAILABLE states | ● | | ● | ● | | |
| `/api/judge/smoke` checks every component in one call | ● | | | | | |
| RWA liquidity: session-aware Uniswap v4 hook + LP vault for tokenized stocks (human request 9/30, DECISIONS D-29, `docs/RWA_LP.md`) | ● | ● | ● | | | |
| Pre-flight `/check`: the agent's engine run on a plan before it exists, every rule against its limit (human request 10/1, DECISIONS D-31) | ● | ● | | ● | ● | |
| Issuer comparison `/compare`: bStocks vs Ondo for one share, shares per quote size (D-31) | ● | ● | ● | ● | | |
| Interest calculator on Earn: today's listed APY → days to the first buy, shares a month (D-31) | | | | ● | | |
| Read-only MCP server `/api/mcp`, checked with the official MCP SDK client (D-31) | ● | ● | ● | | ● | |
| KR/EN, mobile, crypto term substitution | | | | ● | | |

## 4. Self-assessment rubric (updated every Sunday: 9/27, 10/4, 10/8 final)

Score anchors. We play the judge and score our own submission. Any item under 7 points is next week's top priority.

**Technical 30%**
- 10: Many mainnet receipts, 7 or more modules used because the product needs them, code exists that handles the known traps (off-hours RFQ refusal, quote expiry, order ID≠fill, approval, pending), nothing breaks when a judge clicks around, `/smoke` green.
- 7: Live trades exist but only 4~5 modules, partial error handling.
- 4: Mostly simulation or demo mode.

**Creativity 25%**
- 10: Not on the ideas list, the module combination is unexpected and the product needs that combination, handles problems unique to tokenized stocks (off-hours, corporate actions, multiplier).
- 7: A clear variation on an idea from the list.
- 4: The list idea as is.

**DX 25%**
- 10: Measured onboarding time, doc errors with the page URL and location, reproductions per error code, p50/p95 latency, impressions from real use of the AI stack (baw, Skills, bag), per-issuer numbers on liquidity, slippage and off-hours behavior, a prioritized request list. Sentences written by humans.
- 7: Specific but short on numbers.
- 4: Generalities.

**UX 20%**
- 10: Who it is for is visible within 3 seconds, no crypto jargon, starts with a Binance wallet, works on a phone, risks are not hidden, 3-minute run-through.
- 7: Clean, but jargon shows.
- 4: A dashboard.

| Date | Technical | Creativity | DX | UX | Total (weighted) | Top-priority item |
| --- | --- | --- | --- | --- | --- | --- |
| 9/27 | 5 (draft) | 8 (draft) | 6 (draft) | 6 (draft) | 6.2 (draft) | Money decisions R1–R4 → fund the house wallet → $1 live test → first mainnet receipts; deploy the web |
| 10/1 | 5 (draft) | 7 (draft) | 6 (draft) | 6 (draft) | 6.0 (draft) | Unchanged and now late against REPLAN §10 (10/4 target 6.8): R1–R4 → live test → receipts, the web deploy, R9 (real skill use was planned from 10/1), the human DX draft |
| 10/4 | | | | | | |
| 10/8 | | | | | | |

**9/27 row: an agent draft from the evidence below — a human confirms or changes it.**
- Technical 5: RWA Data, Trading quotes and BSC are in live use (Frankfurt worker, tape every 10 min); Market, Transaction and DeFi are code-complete but have not run live; the known traps are handled in code (off-hours, quote expiry, exact approval, outbox and pending, order id ≠ fill). But there are **0 mainnet receipts** and the web is not deployed, and the 7 anchor needs live trades (README "What Yieldvest ran itself", TASKS M1-04, M1-05 and M1-09).
- Creativity 8: not on the official ideas list, and none of the public competing entries does it (PLAN §2); regular-session window, corporate actions and the multiplier are handled in `decideCycle`; the tape measures off-hours gaps. It stays short of 10 until the interest → stock loop has run on mainnet.
- DX 6: `dx/LOG.md` has doc line references, error codes, request timings and a rate-limit analysis, with fixtures. Missing: real use of the AI stack (`baw` and `bag`, M0-09 and M0-10), regular-session tape numbers (M0-06) and the human-written report (M4-01).
- UX 6: the approved English design, no jargon (`pnpm lint:copy`), phone layout (`pnpm ui:check`), 0 axe violations and a working skip link and motion controls (`pnpm qa:check`, M3-02), the risk disclosure on screen. But the web is not deployed (deduction: "the deployment is down"), and the 3-second and 3-minute rehearsals have not happened (M2-01, M2-02).

**10/1 row: an agent draft, asked for by a human in the conversation ("look at the judging criteria"); a human confirms or changes it.** Added later the same day at a human's request (DECISIONS D-31, TASKS RO-01–RO-05): the pre-flight check, the issuer comparison, the interest calculator and a read-only MCP server — all read-only. The scores stay as drafted: what holds Technical and Creativity back is still live trades, which these do not change.
- Technical 5: much harder to break than on 9/27 — three review rounds with every finding fixed under a test, a Judge Mode e2e in CI at 375 and 1280 px, 656 vitest tests and 144 Foundry tests green, the plan-lock lease and outbox reconciliation. Still **0 mainnet receipts** and no deployed web, and the track rule is "demo with small live amounts"; the 7 anchor needs live trades.
- Creativity 7 (9/27 said 8): a correction, not a regression. The 9/27 note said "not on the official ideas list", but Judge Mode's default flow — a fixed $5 contribution — is "Auto-DCA" and "Buy your first stock on-chain" on that list. What is not on it, interest buying the stock, has not run on mainnet; the session-aware Uniswap v4 hook has no deployed pool and no page. On our side: the session window, corporate-action holds and share counts show in Judge Mode, and the server-decides/user-signs Wallet Skill is an unusual use of the AI execution layer.
- DX 6: 44 timestamped entries with error codes, timings, fixtures and asks. Two are on `baw` (10/1), one from reading its bundle and one from running it signed out; there is no signed-in run yet (M0-09, R9). Missing: `dx/metrics.md` and a tape summary (both need the production database, R12: PC), doc citations still given as line numbers of the 9/23 `llms-full.txt` snapshot instead of URL + text, and the human report draft (`dx/REPORT_DRAFT.md` does not exist; REPLAN §7 planned a first draft on 9/27).
- UX 6: the e2e now walks the judge's flow at phone and desktop width with no sideways scroll and no split amounts, and every Judge Mode outcome reads as a sentence. Still no deployed web (deduction: "the deployment is down") and no 3-second or 3-minute rehearsal.

## 5. Deduction factors (if even one is present, removing it is that week's top priority)

- The deployment is down / an error on the first screen
- Mock data that looks live
- Copy like "principal protected" or "safe return"
- Requiring MetaMask, a hex address on the first screen
- Unlimited approve
- AI-style prose or no numbers in the DX report
- Indistinguishable from an item on the ideas list
- The server holds wallet sessions or private keys

## 6. Submission checklist (official "What to Submit")

- [ ] A working project: at least 1 Binance Web3 API module. Agentic Wallet/Wallet Skills is optional (weighted in scoring); 7 or more modules is our own target
- [ ] Public repo. Stating a license is a separate recommendation (not a required item listed in the official What to Submit)
- [ ] Demo video ≤ 4 min (strongly recommended)
- [ ] Deployment link, or instructions a judge can follow
- [ ] Developer Experience Report (submitted through the official template form) — 7 sections: Onboarding / Documentation issues / API pitfalls / AI stack feedback / Tokenized-stock specifics / Redesign suggestions / Requested capabilities
- [ ] Registration completed (free API, higher rate limits)
- [ ] Plan to stay live throughout the judging window (`docs/PLAN.md` §8 operations runbook)
