# PLAN.md — Yieldvest master plan

> **In one line:** An agent that leaves the principal in a USDT deposit and automatically buys US stock tokens with the interest (or a set contribution), only during the regular session.
> **English tagline:** *Interest buys the stock. Principal stays.*
> Competition: BNB Hack: Tokenized Stocks Edition · deadline 2026-10-11 12:00 UTC (KST 21:00) · internal submission target 10/09 (Fri)

## 0. Who wrote this document

Three senior-planner personas each own an area, and they argued against one another in §11.

| Persona | Background | Owned areas | Owned documents |
| --- | --- | --- | --- |
| **Minseo Kang** — Lead, Product & UX | 12 years, consumer fintech apps (easy investing, deposit and savings products) | User definition, flows, screens, copy, risk disclosure, demo | PLAN §3·§5, UX_COPY, DEMO |
| **Dohyun Lee** — Lead, systems and trading infrastructure | 15 years, exchange execution, wallet backends, risk engines | Architecture, module integration, agent loop, guardian, error taxonomy, operations | SPEC, CLAUDE.md engineering rules |
| **Jiwoo Park** — Lead, hackathon strategy and DevRel | 10 years, judged and organized many hackathons | Alignment with the scoring, DX evidence system, schedule and cut lines, submission, risk register | JUDGING, DX_PROTOCOL, TASKS, DECISIONS |

Reading order: JUDGING → PLAN → SPEC → TASKS → DECISIONS → DX_PROTOCOL → UX_COPY → DEMO.

## 1. Goals and aim

- **Goal:** places 3~5 in the main prizes + 1 special prize. More important than the prize money are the "Winner spotlight" and Kickstart eligibility.
- **How judging works:** each judge works through every project alone, and then the scores are pooled. So we concentrate our points on **objective evidence** (live trades, numbers, error handling) that (1) can be understood within 15 minutes and (2) gets the same score whichever of the 10 judges looks at it.
- **Scoring strategy:** Technical 30 + DX 25 = 55% is secured through execution discipline. Creativity 25 is raised safely with "a module combination that is not on the ideas list". UX 20 is won with non-crypto language and the 3-minute run-through.
- **The judges' KPIs:** they are the BNB Chain and Binance Web3 Wallet teams. Their metrics are "getting Binance wallet users to trade tokenized stocks" and "honest feedback on their own APIs". Our product connects two of their product lines (Earn/DeFi ↔ tokenized stocks). The end goal is for a judge to feel "we should put this in our wallet".

## 2. Why this — against the criteria

| Criterion | How this product scores |
| --- | --- |
| Technical 30% | One cycle necessarily uses 7 modules: DeFi (deposit, interest, redeem) → Wallet (balance) → RWA Data (market status, corporate actions, reference price) → Market (price) → Trading (quote, swap) → Transaction (simulation, broadcast) → Agentic Wallet (user execution). It does not look as if the module count was padded. |
| Creativity 25% | It is not on the official "Ideas to Build" list. None of the 7 public competing entries does it. The combination "lending-protocol interest becomes stock" is what the organizers called "a combination that looks like it won't work, but does". On top of that, the product handles problems unique to tokenized stocks (the regular-session window, corporate actions, the token≠share multiplier). |
| DX 25% | DeFi calldata, redeem delays, RFQ minimum orders on small sizes, regular-session vs weekend prices, and per-issuer differences are things **we actually hit every week.** Every API call is instrumented from day 1. |
| UX 20% | "Collecting stocks with interest" needs no explanation. The first screen is the experience of buying your first stock within 3 minutes, and holdings show as a number of shares, not tokens. You start from a Binance app QR code, and there is no seed phrase. |
| AW special prize | User execution goes only through Agentic Wallet (`baw`), via our Wallet Skill. The server only makes decisions; signing happens on the user's side. "credible" is proven with limits, previews, receipts and stop. |
| Studio special prize | Deploy the house agent to Agent Studio (ERC-8004 identity + runtime), sell reports via b402, and buy reports from the official Stock Analyze Agent. |

**Alternatives dropped, and why**
- Conditional-order (limit, stop-loss) engine — Agentic Wallet already has `limit-order`. Duplicating it is a deduction.
- Price comparison, routing, gates — 6 teams among the public competing entries alone. Creativity 0.
- Pure DCA — on the official list. Contributions only as an optional feature of our product.
- Copy trading — Skills Hub already has an official skill, and it is regulation-sensitive.
- Collateralized borrowing — Venus has a recorded borrow limit of 0 for stock tokens, and it is hard for non-crypto users.

## 3. Users (Minseo Kang)

| Persona | Situation | What we give | What we don't give |
| --- | --- | --- | --- |
| **P1 Saver investor** (in their 30s, has bought small amounts of US stocks in an app, knows nothing about crypto) | Has come to hold USDT but leaves it idle. Wants to buy stocks but is afraid of the timing. | A "principal stays put, only the interest becomes stock" plan. Holdings shown as a number of shares. A one-line reason for every buy. | Return forecasts, stock recommendations, leverage |
| **P2 Judge** (BNB/W3W team, 15 minutes) | Reviews every project alone. Wants to run through it personally. | Judge Mode: enter a code → 3-minute run-through. 2 weeks of the house agent's real record. | Requiring a wallet install, screens that need explaining |
| **P3 AI assistant user** (has Claude Code / OpenClaw + Agentic Wallet) | Wants to tell their own assistant "buy me stocks with the interest". | One-line Wallet Skill install. The server decides; the assistant executes with `baw`. | Handing a wallet session to our server |

## 4. Product scope

### 4.1 Operating modes
| Mode | Who | Wallet | Autonomy | Purpose |
| --- | --- | --- | --- | --- |
| **A. Look around (Watch)** | Anyone, no wallet | House wallet | Fully automatic (5-min tick) | Proof from the real record, first screen |
| **B. Judge Mode** | Judge code holders | House wallet (within limits) | 1 immediate cycle + 7 days automatic | 3-minute run-through |
| **C. With my AI assistant (Wallet Skill)** | Agentic Wallet users | User's wallet (`baw`) | While the assistant is running | AW special prize, real users |
| D. Web wallet connection | — | — | — | **Stretch (cut by default)**. Decision on 10/4 |

### 4.2 Plan modes
- **Safe mode (default):** No deposit. Buys only with a contribution the user sets (e.g. $5 a week). DeFi risk 0.
- **Yield mode (optional):** Principal is deposited into Venus core pool USDT. Buy budget = the amount above principal (interest) [+ optional contribution]. Turned on after reading the risk disclosure.
- Both modes: buying in the regular-session window (default) / 24-hour buying (option, lower limit), per-buy and daily limits, immediate stop and full redeem.

### 4.3 Feature tiers
**Must (no prize without these)**
1. The house agent's 2 plans (safe, yield) run continuously on mainnet from 9/30, accumulating receipts
2. Decision engine: window (regular session), budget (interest/contribution), accumulating up to the minimum order, limits, stock status (corporate actions), price gap
3. Execution: exact approval → Transaction API simulation → broadcast → receipt → one-line reason
4. Yield mode: deposit and redeem with DeFi API calldata, interest computed from the on-chain exchange rate
5. Judge Mode 3-minute run-through + stop and full redeem
6. Wallet Skill v1 + decision API (`/next`) — the user's assistant executes with baw
7. Guardian v1 (pause, TVL, utilization, depeg, price gap)
8. Share-count display (multiplier), KR/EN, mobile, term substitution, risk disclosure, LIVE/STALE/UNAVAILABLE
9. Instrumentation: api_calls, tape (including off-hours), /dx page, `/api/judge/smoke`
10. README judge path, video ≤4 min, DX report (written by humans)

**Should (changes the ranking if done)**
- Sector targets (Magnificent 7, AI Chips, ETF, Buffett) + candidate substitution
- Agent Studio identity + runtime/MCP registration
- b402 paid report endpoint + x402 calls to the official Stock Analyze Agent ("AI recommendation" option)
- Telegram alerts (ops + user opt-in)

**Stretch**
- Mode D (web wallet connection), BNB staking as an interest source, best execution across issuers

**Cut (not doing)**
- Limit and stop-loss engine, price comparison dashboard, natural-language strategy parser (no LLM on our server), returns leaderboard, perpetual futures, testnet

## 5. Core flows (Minseo Kang)

### 5.1 The judge's 3 minutes (mode B)
1. On the home screen, **[Enter judge code]** → the code is checked.
2. **Pick a stock:** one of NVDA / TSLA / AAPL / MSFT / QQQ, or a sector. The issuer is chosen automatically (bStocks by default, Ondo if not available). Company profile and a market-status badge ("Regular session now · closes 20:00 UTC").
3. **Amount and mode:** safe mode, $5 once (default). Yield mode is a toggle → risk disclosure → $20 deposit + buy with the interest.
4. **Preview:** the Transaction API simulation result in plain words: "You pay USDT 5.00 and receive about 0.021 shares of NVDA (0.0198 NVDAB). Network fee about $0.02. +0.3% vs reference." If it fails, the reason.
5. **Run:** progress status → receipt (BscScan link, number of shares, one-line reason).
6. **Stop:** [Stop this plan] → in yield mode, all the way to the full-redeem receipt.
7. The plan runs automatic cycles for 7 days (within the cap), and the judge comes back later to see the record.

### 5.2 The saver investor's plan (mode C)
1. In Claude Code: `npx skills add mycyi1994-hash/NewBNBHACK/skills/yieldvest` (the exact path is settled in M2-09).
2. "Start Yieldvest. Put in USDT 500 and buy NVDA with the interest."
3. The skill creates the plan through our API (`POST /api/plans`), has the user read the risk disclosure, and deposits with `baw defi deposit` (the user confirms).
4. After that, every time the assistant starts: `GET /api/plans/:id/next` → decision ("buy NVDAB now with $2.10 of interest; quote, address, reason") → `baw market-order swap` → the result goes to `POST /report`.
5. When the session is close to expiring, the skill warns first (`sessionExpireTime` from `wallet settings`).

### 5.3 Agent cycle (Dohyun Lee, details in SPEC §5)
DUE → WINDOW → BUDGET → ASSET → PRICE → (REDEEM) → QUOTE → SIMULATE → EXECUTE → CONFIRM → RECORD.
The outcome is one of four: **BOUGHT / DEFERRED(reason) / SKIPPED(reason) / FAILED(code)**. Every outcome carries a one-line reason and the next attempt time.

## 6. Architecture overview (Dohyun Lee)

```
[Binance Web3 API] ← packages/binance (signing, rate limit, instrumentation)
      │ RWA · Market · Trading · Transaction · Wallet · DeFi · b402
      ▼
packages/core (pure rules) ── decideCycle(), guardian(), amounts
      ▲                 ▲
apps/agent (5-min tick, tape, guardian, alerts)              apps/web (Watch · Judge Mode · /dx · Skill API)
      │                                                        │
   house wallet (viem signing → Transaction API broadcast)   Postgres (packages/db)
                                                               │
                                                       skills/yieldvest ── user's assistant ── baw (user's wallet)
[BSC mainnet] Venus vUSDT · stock tokens (BEP-20/BEP-677) · PancakeSwap/RFQ liquidity
[Agent Studio] house agent identity (ERC-8004) · runtime/MCP (Should)
```

### 6.1 Module coverage (table to go into the README as is)
| Module | Used for | Requirement |
| --- | --- | --- |
| RWA Data API | Token list, addresses and multipliers per issuer, sector filter, on-chain price vs reference price, market status and next open, stock status (corporate action codes), company profile | Must |
| Market API | Batch price lookup, USDT price (depeg watch), candles on the plan screen | Must |
| Trading API | Quotes (price impact, route, vendor), approval and swap calldata, MEV protection | Must |
| Transaction API | Simulation before every write, broadcast, status lookup | Must |
| Wallet API | House and sandbox balances, holdings, history | Must |
| DeFi API | Venus info, security score, APY, TVL, positions, deposit and redeem calldata | Must (yield mode) |
| b402 Payments | Paid plan reports (agent→agent), calls to the official Stock Analyze Agent | Should |
| Agentic Wallet / Wallet Skills | User execution layer | Must (heavily weighted) |
| BNB Agent Studio | House agent identity, runtime, MCP | Should |
| BSC / PancakeSwap | Small-order fill route (via the Trading API) | Automatic |

## 7. Risk principles and the guardian (Dohyun Lee, Minseo Kang)

Principle: **if a risk cannot be removed, make it visible.** No "principal protected"-style copy (UX_COPY §6). Safe mode is the default. Yield mode has an allowlist of one (Venus core pool USDT) and a principal ceiling ($1,000 by default).

| Rule | Data | Threshold | Action |
| --- | --- | --- | --- |
| Protocol paused | Venus Comptroller guard flags / DeFi API status | true | Full redeem → pause the plan → alert |
| Sharp TVL drop | DeFi API protocol TVL | 24h −30% | Full redeem → pause |
| Utilization | vUSDT cash/borrows (on-chain) | > 95% | Stop new deposits, show a warning |
| USDT depeg | Market API USDT price | < 0.99, sustained for 30 min | Stop buying + alert (switching is the user's choice) |
| Price gap | RWA on-chain price vs reference price | Regular session > 2% | Hold the buy, show the reason |
| Fill price impact | Trading quote priceImpact | > 1% | Reduce the amount; hold if still over |
| Daily and per-buy limits | Internal | Exceeded | Hold |
| Stock status | RWA stock status code | PAUSED/LIMITED | Skip; for a sector, substitute a candidate |
| AW session expiry | `wallet settings` | < 2h | Alert the user (mode C) |

## 8. Schedule, milestones, cut lines (Jiwoo Park)

Today is 2026-09-23 (Wed). 18 days left. Weekends to capture: 9/26~27, 10/3~4 (the tape starts **before the evening of 9/25 KST**). The Chuseok holiday overlaps M0 — infrastructure setup happens tonight.

| Phase | Period | Deliverables | Done when |
| --- | --- | --- | --- |
| **M0 Access and spikes** | 9/23~9/25 | Registration, API key, reachability decision, client v0, inventory, small-size quotes, Venus spike, baw and bag spikes, tape running, DX log started | `pnpm reach` green, tape accumulating, DECISIONS filled in |
| **M1 Vertical slice** | 9/26~9/30 | Domain and DB, decision engine, house execution adapter, live trades in safe and yield modes, scheduler, error taxonomy v1 | Mainnet receipts: at least 1 in safe mode, 1 each for yield-mode deposit, redeem and buy; 2 house plans running continuously |
| **M2 Productization** | 10/1~10/4 | Watch, Judge Mode, stop and redeem, risk disclosure, i18n, guardian, corporate actions, Skill API, Wallet Skill v1, Agent Studio, /dx, smoke | Judge 3-minute run-through rehearsal passes, 1 real buy through the skill |
| **M3 Polish** | 10/5~10/7 | b402/x402, mobile QA, README path, video shoot, security and incident rehearsal | Self-assessment ≥ 8 on every item |
| **M4 Submission** | 10/8~10/9 | DX report (humans), video edit, form submission, freeze | Submitted, operations mode entered |
| Buffer | 10/10~10/11 | Hotfixes only | |
| Judging | 10/12~10/23 | Daily smoke, logs | Downtime 0 |

**Cut line (decision on the evening of 10/4; the later an item appears, the sooner it is cut):** mode D → BNB staking → best execution across issuers → Telegram user alerts → x402 calls to the official agent → b402 paid endpoint → sector targets → Agent Studio runtime (identity registration stays).

**Never cut:** the house agent's live loop and receipts, Judge Mode, both modes (safe and yield), error handling and the 3-state display, KR/EN copy (9/27 D-26: by human decision the screens are English only), instrumentation, tape and /dx, the README path, the video, the human-written DX report.

## 9. Submission mapping
Follows the JUDGING §6 checklist. README first-screen layout: one sentence → live link → video → Judge Mode guide → house receipts table → module matrix → DX report link → how to run → risk disclosure.

## 10. Risk register (Jiwoo Park)

| # | Risk | Signal | Response | Owner |
| --- | --- | --- | --- | --- |
| R1 | Web3 API region block (40304) on a Korean network connection | M0-04 reach fails | Pin the server region to Frankfurt; develop through the server | Dohyun Lee |
| R2 | bStocks trading restricted for Korean residents | Telegram answer / quote refused | Switch the default issuer to Ondo, revise the copy | Jiwoo Park |
| R3 | Small orders hit the minimum amount | $1~$5 quotes refused | Raise MIN_BUY_USD, accumulate buys, check the AMM route | Dohyun Lee |
| R4 | Interest is small, so fills are rare | House yield mode fills less than once a week | Raise house principal, add contributions alongside, show honest numbers | Minseo Kang |
| R5 | The 48h AW session ceiling makes unattended mode C impossible | `wallet settings` | Skill warns in advance, the house uses its own wallet, the #1 redesign suggestion in the DX report | Dohyun Lee |
| R6 | Agent Studio runtime can't run our worker | bag spike | Identity registration only; our own runtime | Dohyun Lee |
| R7 | We can't answer DeFi risk questions | Judging questions | Safe mode by default, guardian, disclosure screen | Minseo Kang |
| R8 | Down during judging | smoke fails | Uptime monitor, alerts, runbook, no deploys after 10/9 | Jiwoo Park |
| R9 | DX report written at the last minute | No draft by 10/4 | Mandatory Sunday drafts (9/27, 10/4) | Jiwoo Park |
| R10 | Scope creep | Work outside the cut line | CLAUDE.md rule 11, weekly scoring | Jiwoo Park |

## 11. 3-person review minutes (objections and decisions)

| # | Raised by | Objection | Decision |
| --- | --- | --- | --- |
| 1 | Minseo Kang | "If yield mode is on the first screen, non-crypto users drop off at 'deposit'." | The first screen is buying a first stock within 3 minutes (safe mode). Yield mode is a toggle on the second screen. Creativity is proven in the house record and the README. |
| 2 | Dohyun Lee | "The moment the web server holds a user's Agentic Wallet session, we are a custodian, and it also goes against the official skill's credential policy." | In mode C, the assistant on the user's device executes with baw. The server offers only the decision API. The server stores no user key or session of any kind (SPEC §14). |
| 3 | Jiwoo Park | "If we write the DX report in the last week, the 25% is gone. And if AI writes it, 0 points." | api_calls instrumentation + mandatory dx/LOG.md from day 1. A human drafts every Sunday. The agent generates only tables and numbers. |
| 4 | Dohyun Lee | "Repeating small redeems and buys on interest alone runs into gas and minimum orders." | If budget < MIN_BUY_USD, accumulate (SKIPPED: below_min). The default cadence is once a week. Option to add contributions alongside. Measure the minimum amount live in M0-06. |
| 5 | Minseo Kang | "'Stocks with interest' is $4 a month on $1,000. It may look like a toy." | Show the numbers honestly and do not inflate them. The value is 'a habit that never touches the principal'. Keep the house principal large, and add contributions alongside to keep fills frequent. |
| 6 | Jiwoo Park | "If we plan without knowing the Agent Studio runtime's constraints, it blows up in M2." | go/no-go through the M0-10 spike. If no-go, keep only identity registration, as a Should. |
| 7 | Dohyun Lee | "What if Transaction API broadcast is unstable?" | Broadcast through the Transaction API first, RPC as the fallback. Either path is instrumented and shown. Simulation always goes through the Transaction API. |
| 8 | Minseo Kang | "If the risk disclosure is long, nobody reads it." | 5 lines on one screen + 'Details'. The copy is fixed in UX_COPY §5. A banned-words list for "principal protected" and the like. |
| 9 | Jiwoo Park | "A server in a Japan region could violate the restricted-regions rule." | Server region Frankfurt (backup: Seoul Vercel icn1, web only, if it is reachable). Amsterdam, London, Tokyo and Singapore are banned. |
| 10 | Dohyun Lee | "If we parse natural-language plans with an LLM, a model enters the decision path." | No LLM on our server. Natural language is handled by the user's assistant (mode C), and our API accepts only structured input. |
| 11 | Minseo Kang | "If we bake stock token addresses into the code, it breaks when an issuer changes, and judges will see it as hardcoding." | The instrument registry is generated from the RWA Data API and verified with the on-chain `symbol/decimals`. No address constants in code (only stables and Venus are exceptions, after verification). |
| 12 | Jiwoo Park | "Judges may look on a weekend. If all they see then is 'market closed, waiting', it's dull." | On weekends, show the house record, the tape chart (off-hours gap), and the 24-hour option of Judge Mode safe mode (lower limit, after the disclosure). |

## 12. Open questions
→ `docs/DECISIONS.md` §2. All of them are closed in M0.
