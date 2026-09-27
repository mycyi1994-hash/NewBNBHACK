# Yieldvest frontend preview

A standalone frontend that implements the chosen design no. 3. It does not change the existing server code, trading engine, database or wallet logic in apps/web.

Developer handoff: [FRONTEND_HANDOFF.md](../FRONTEND_HANDOFF.md). First shared branch: codex/ijaro-frontend. The branch name keeps the old product name, but the screens and the logo are Yieldvest.

![Yieldvest frontend](yieldvest-preview.jpg)

## Run

Use Node.js 22.12 or later. Run these in this folder.

~~~powershell
npm ci
npm run dev
~~~

Dev server: http://127.0.0.1:5173

Production preview currently left running: http://127.0.0.1:4173
If the preview stops, for example after a PC restart, run npm run build and then npm run preview in this folder.

This folder is a frontend preview kept separate from the existing pnpm workspace. Its dependencies and lockfile are also managed inside this folder.

## Screens and behavior

- Overview: the interest → buy → carry-forward flow and the receipt
- Earn: the cumulative interest chart for the current cycle and the buy condition
- Invest: pick NVDA / TSLA / MSFT / QQQ, switch between Interest only / Contribution
- Activity: event filter, detail panel for the selected event
- Receipt details: amount breakdown and example execution steps
- Explore demo: add sample interest → pick a stock → example simulation → confirm → receipt
- Mobile: responsive layout and four bottom tabs
- Keyboard navigation, Escape closes modals with focus restored, support for the reduced-motion setting
- Light particles in the interest flow, chart drawing, tab indicator movement, value-change and progress transitions, modal enter/exit effects
- Play/pause button at the top. It follows the system's reduce-motion setting, and looping effects stop when off-screen and in inactive tabs.

Tabs and receipts are linked through hash URLs, and the browser's back and forward navigation works. The sample account is kept in memory only. Refreshing or pressing Reset demo returns to the initial state.

## Data scope

All numbers, buys, simulations and receipts are frontend examples. There are no API requests, wallet connections, real transfers or order submissions.

Initial example:

- Supplied principal base amount: 1,000.00 USDT
- Previous interest: 0.28 USDT = reinvested 0.25 + carried forward 0.03
- Current interest: 0.18 USDT = carried forward 0.03 + new interest 0.15
- Example minimum buy: 0.25 USDT, remaining 0.07, progress 72%

Amounts are calculated in integer cents. Confirming again cannot create a duplicate example buy, and changing the stock does not modify existing receipts. Contribution does not use the interest balance.

For a real integration, stock support, per-provider minimum amounts, market hours, fees, actual received quantities and transaction hashes must be replaced with verified data. The example minimum amount must not be applied to every provider alike.

## Tests and production build

~~~powershell
npm test
npm run build
npm run preview
~~~

The build output is written to dist. It can be put on static hosting and needs no separate server or database. This work has not been deployed to public hosting.

## Structure

- src/App.tsx: screens, navigation, the trial flow
- src/components.tsx: receipt, flow diagram, charts, progress indicator, modal
- src/model.ts: example state and amount calculation
- src/styles.css, src/tokens.css: responsive design
- src/motion.tsx, src/motion.css: motion settings, transitions and flow effects (no extra library)
- public/bnb-chain.svg: official BNB Chain logo
- public/yieldvest-mark.svg: the Yieldvest symbol, combining the open shapes of Y and V. The wordmark is set in the local Inter Variable font.

Design basis: #0B0E11 canvas, #F0B90B accent, #F7F7F5 receipt, local Inter Variable font. The accent is concentrated on the interest flow and key actions.
