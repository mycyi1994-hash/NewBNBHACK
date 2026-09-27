# Yieldvest: the scope needed to submit

Checked on: 2026-09-27. The code, README and work records in the current local checkout were compared against the [official BNB Hack: Tokenized Stocks Edition brief](https://www.bnbchain.org/en/hackathons/tokenized-stocks). The production server, wallet balances and registration status were not queried in this review. This document is an internal assessment of the work scope, not the DX report for submission.

## Summary of the official conditions

The deadline is **2026-10-11 12:00 UTC / 21:00 Korea time**, and judging runs **10/12~10/23**. The repository, demo and deployment links must stay accessible during judging.

The weights are technical 30%, creativity 25%, DX report 25%, product and UX 20%. The bar is a spot product centered on one of bStocks/Ondo/xStocks, at least 1 Binance Web3 API module, and a demo that works with small amounts on BSC mainnet. A public repository, a deployment link or reproduction instructions, and a DX report are required. A video of 4 minutes or less is strongly recommended but optional. Agentic Wallet/Wallet Skills is optional but weighted in scoring, and Agent Studio is optional as well. AI-generated body text in the DX report is not accepted; AI-assisted coding is allowed. Source: [Rules / What to Submit / How You're Judged in the official brief](https://www.bnbchain.org/en/hackathons/tokenized-stocks).

So 7 APIs, a large user count, issuing our own token, and implementing everything up to Agent Studio and x402 are not official minimum conditions. Stating a license is recommended, and one still has to be chosen. The Agentic Wallet wording in the existing JUDGING.md that looked mandatory has been corrected.

## What is confirmed now

| Part | Evidence | Assessment |
| --- | --- | --- |
| New design | frontend-preview/src/App.tsx, components.tsx, model.ts | Yieldvest logo, 4 tabs, flow diagram, receipt, responsive layout, motion. All amounts and executions are examples; no API connection |
| Existing product web app | apps/web/components/judge/JudgeFlow.tsx, app/plans/[id]/page.tsx, app/dx/page.tsx | Judge trial, plan and DX screens and API code exist. Separate from the new design preview |
| Execution path | apps/agent/src/executor/trade.ts, venus.ts, send.ts | Code exists for approval, simulation, buy, deposit/redeem and receipt handling. The code existing does not prove a complete mainnet run |
| User's AI wallet | apps/web/lib/server/next.ts, skills/yieldvest | The decision API and Wallet Skill exist. The real execution demo is recorded as incomplete in TASKS M2-09 |
| Live-trade evidence | House record in the README, and TASKS M1-04/05 | The README records 0 receipts, waiting for live verification. The latest state of production needs to be checked separately |
| Submission materials | Live/Video/DX in the README, docs/TASKS.md | Links not filled in. dx/LOG.md exists, but this checkout has no dx/REPORT_DRAFT.md or LICENSE |

> Updated (9/27, DECISIONS D-25): the new design is integrated into `apps/web`. The 4 tabs (Overview·Earn·Invest·Activity) and the receipt detail show only real values from the existing API, jobs and state model — the screen-connection part of P0-1 below. Real interest-buy evidence, deployment and submission materials remain to be done.

## Recommended finish line: prove one flow end to end

Below is an implementation recommendation tailored to Yieldvest. It is kept separate from the official list of required features.

### P0 — finish first

1. **Connect the new UI to the existing runnable web app.** Rather than building a new trading engine, reuse the API, jobs and state model of the existing apps/web. Overview/Earn shows real principal, interest and times; Invest shows real quotes and simulations; Activity/Receipt shows server records and transaction hashes. When there is no data, show the reason instead of a number. Keep the example mode clearly separate.
2. **Prove Yieldvest's distinctive feature.** Leave a linked record of deposit → checking the accrued interest → redeem → buying the stock token → receipt. Prove that the deposited principal and the source of the interest, and the amount spent and the balance, add up. Do not use a receipt for a buy made with a contribution as evidence of an interest buy. It is fine to complete the run with one stock and one issuer first.
3. **Connect the judge trial.** Input → stock/amount → fees, minimum received, risk disclosure → simulation result → user confirms → execution status → receipt. Explain each of: market closed, quote expired, insufficient balance, limit exceeded, failure, awaiting confirmation. Off-hours, provide the next run time and past real receipts. Do not change the approved operating policy on your own.
4. **Create an address that can be reproduced from outside.** Verify in the deployed environment: the web + worker + DB setup, a complete run from the first visit, no duplicate execution after a restart, and health checks. The current 127.0.0.1:4173 is this PC's preview address.
5. **Complete the submission package.** Public repository access, description/how to run, real receipt links, where each module is used, demo video, DX report, registration and submission confirmation. The internal target date 10/9 is a team plan and differs from the official deadline.

### P1 — raise the score once the basic flow works

- Run the Wallet Skill end to end in a real Agentic Wallet and keep evidence of install, session, quote and fill. Do not call the integration complete just because the install files exist.
- Organize the existing dx/LOG.md and API instrumentation to provide evidence: p50/p95, failure codes, minimum order per issuer, off-hours behavior. The people who actually had the experience check this evidence and write the DX report themselves.
- Have someone else try it on mobile and fix the copy where they get stuck. Remove copy that reads like a principal guarantee, and show plan stop, the source of funds and the network cost.

### P2 — optional once the core run is complete

Full Agent Studio runtime, ERC-8004 registration, x402 paid calls, more stocks and issuers, sector baskets, more decorative animation. Spend time on these only when a special-prize goal or a core feature needs them. A decision to actually drop something from the existing plan goes into a separate work plan.

## Done criteria

- A judge enters from an external address and finishes the trial. Internal target: within 3 minutes, 3 times in a row.
- The real source of funds and the receipt of stock tokens can be verified with on-chain receipts.
- The stop, limit, retry and awaiting-confirmation states work in the real deployed environment.
- Every submission link opens on other devices too, and someone is assigned to operations for the judging window.
- Every claim in the DX report has a live measurement or first-hand experience behind it.

The biggest gap right now is not the amount of design but **connecting the new UI to the existing backend, real interest-buy evidence, and accessible deployment and submission materials**. This work was a branding change and a scope review; it did not execute real trades, wallet connections or a public deployment.
