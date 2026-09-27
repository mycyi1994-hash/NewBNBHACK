# Yieldvest frontend design handoff

The user-approved frontend is in **frontend-preview/**. It was originally local-only; this branch publishes the source, assets, screenshot and setup instructions so Claude can continue from it.

## Where to find it

- Repository: https://github.com/mycyi1994-hash/NewBNBHACK
- Design branch: **codex/ijaro-frontend** (legacy branch name; the product is Yieldvest).
- Integration base at handoff: **claude/loving-lovelace-1519kl**, commit **eaade59**.
- Source: [frontend-preview/src/App.tsx](frontend-preview/src/App.tsx).
- Screenshot: [frontend-preview/yieldvest-preview.jpg](frontend-preview/yieldvest-preview.jpg).
- Setup: [frontend-preview/README.md](frontend-preview/README.md).
- Hackathon gap assessment: [docs/YIELDVEST_SUBMISSION_SCOPE.md](docs/YIELDVEST_SUBMISSION_SCOPE.md).

If this file is not visible on your current branch, fetch the design branch explicitly. This also works for a clone configured to fetch only one branch:

~~~sh
git fetch origin refs/heads/codex/ijaro-frontend:refs/remotes/origin/codex/ijaro-frontend
git show origin/codex/ijaro-frontend:FRONTEND_HANDOFF.md
git ls-tree -r --name-only origin/codex/ijaro-frontend frontend-preview
~~~

To try the design without changing a checkout that has ongoing work:

~~~sh
git clone --branch codex/ijaro-frontend --single-branch https://github.com/mycyi1994-hash/NewBNBHACK.git yieldvest-design
cd yieldvest-design/frontend-preview
npm ci
npm run dev
~~~

Open http://127.0.0.1:5173 on that machine. For a production preview, run npm run build followed by npm run preview, then open http://127.0.0.1:4173. These are local addresses, not hosted links shared across machines. Node.js 22.12+ is required. No environment variables, wallet, API key or database are needed for this design preview.

## What has been implemented

- English BNB-style neobank UI: dark canvas, BNB yellow, pale receipt panels, local Inter Variable typography.
- Yieldvest Y/V mark, wordmark, official BNB Chain logo and favicon.
- Overview, Earn, Invest, Activity and receipt details; desktop and mobile navigation.
- Interactive illustrative investment flow, contribution mode, asset choice and receipt inspection.
- Animated interest flow, tab indicator, chart reveal, progress updates and dialogs; pause control and reduced-motion support.
- Responsive layouts, keyboard navigation, native dialog focus handling.

![Current approved design](frontend-preview/yieldvest-preview.jpg)

## Source map

| File | Responsibility |
| --- | --- |
| frontend-preview/src/App.tsx | Page layouts, navigation, demo interaction flow |
| frontend-preview/src/components.tsx | MoneyFlow, receipt, chart, progress, dialog, icon components |
| frontend-preview/src/styles.css | Layout, responsive styles and component appearance |
| frontend-preview/src/tokens.css | Colors, typography and motion tokens |
| frontend-preview/src/motion.tsx, motion.css | Motion settings, transitions and effects |
| frontend-preview/public/yieldvest-mark.svg | Vector Yieldvest logo mark |
| frontend-preview/public/bnb-chain.svg | Official BNB Chain logo |
| frontend-preview/public/favicon.svg | Browser icon |
| frontend-preview/src/model.ts | Illustrative state and amounts; not production accounting |
| frontend-preview/src/model.test.ts | Six deterministic demo-state tests |

## Integration boundary

This folder is intentionally outside the root pnpm workspace. Its npm lockfile, build and tests are independent. The root CI has a separate frontend-preview job. The existing apps/web application and its API remain the production implementation.

The preview does **not** connect a wallet, call Binance APIs, sign, submit a transaction, or read live balances. All displayed balances, thresholds, purchases and receipts are examples, labelled as such. In particular, its 0.25 USDT threshold is not a verified universal venue minimum.

For the next integration task, reuse the visual components and styles in the existing Next.js frontend while using its actual API contracts:

| Preview view | Existing implementation to inspect |
| --- | --- |
| Overview / Earn | apps/web/app/page.tsx, lib/server/house.ts, market.ts, plan-view.ts |
| Invest / preview / execution | components/judge/JudgeFlow.tsx, lib/server/judge.ts, jobs.ts, schemas.ts |
| Activity / receipts | lib/server/receipts.ts, app/plans/[id]/page.tsx, components/plan/Timeline.tsx |
| Stop / status / failures | components/plan/StopPlan.tsx, components/ui.tsx and server state contracts |

Preserve the user's approved sparse layout, BNB identity, useful flow visualization and English copy. Financial values and actual execution states must come from the server; retain the existing caps, simulation, confirmation, risk disclosures and failure handling. Review current upstream code before integration rather than assuming that the demo model matches the server model.

## Validation

From frontend-preview: npm test and npm run build. See [VERIFICATION.md](frontend-preview/VERIFICATION.md) for browser checks and their limits. The screenshot is a visual reference, not evidence of a mainnet transaction.
