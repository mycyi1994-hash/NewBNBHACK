# Yieldvest web design brief — for Claude Design

> **Updated 9/27 (DECISIONS D-25):** The visual direction changed to the user-approved `frontend-preview/` (dark, BNB yellow, Yieldvest mark, BNB Chain logo, 4 tabs). §3 below (light teal) and the "no BNB logo, yellow or black" rule in §8 are superseded by that decision. The screen language is also English only (D-26) — the Korean mockups and the KO/EN toggle in §0 and §9 are superseded. The remaining principles, such as honest numbers, status badges, risk disclosure and banned words, stay as they are.

> This whole document is pasted into Claude Design as is. Screen copy uses the keys and text of `docs/UX_COPY.md` verbatim.
> Copy that is not in UX_COPY yet is marked **[new copy]**. Use it in the mockups, but it becomes final only after a human adds it to UX_COPY.

---

## 0. Request summary (to Claude Design)

Please make screen design mockups for the **desktop web service** "Yieldvest".
- The base width is 1440px and the maximum content width is 1200px. Mobile mockups are out of scope this time. Still, the layout is built to fold into a single column when the width shrinks.
- The list of deliverables is in §9.
- Mockups are made in **Korean**. Home and the first two screens of the judge trial also get an **English version**.
- The real service follows the browser language. If it is not Korean, English is the default. KO/EN is switched in the header.

## 1. Product one-liner and audience

**One line**: An agent that leaves the principal in a USDT interest account (Venus) and automatically buys US tokenized-stock pieces (bStocks, Ondo) with the interest (or a set contribution), **only during the US regular session**.

**Who looks at it**
| User | Situation | What they want from these screens |
| --- | --- | --- |
| Judge (BNB Chain and Binance Web3 teams, 15 min) | Opens the link and wants to try it hands-on within 3 minutes | Understand what it is within 3 seconds, proof that it is really running (receipts), try it right away with a code |
| Saver-investor (30s, doesn't know crypto) | Wants to collect US stocks little by little | No hard words, honest numbers, risks not hidden |
| AI assistant user (Claude Code etc. + Binance Agentic Wallet) | Wants to hand it to their assistant | A one-line install, safety rules, an example conversation with the assistant |

**The order a judge sees things in** (this order is the screen priority): Home first screen → trial (code → stock → preview → receipt) → Data (/dx).

## 2. Design principles (UX_COPY §1 + judging feedback)

1. **No crypto terms.** Follow the UX_COPY §2 substitution table: token → "piece/shares", swap → "buy", gas → "network fee", deposit → "put in the interest account", tx → "receipt".
2. **Wallet addresses (0x…) and token amounts never appear on the first screen.** They show only when "Details" is expanded. Holdings are always shown in "shares".
3. **One decision per screen.** Button names are verbs ("Buy now", "Stop this plan").
4. **Numbers show as they are, even when small.** Even $0.18 of interest is shown large and honestly. Exaggeration and inflating by rounding are not allowed. Amounts go to two decimal places, share counts to six decimal places.
5. **Every data block gets a status badge**: Live (LIVE) / n min old (STALE) / Unavailable (UNAVAILABLE, with the reason). Fake numbers are never used. If something cannot load, it stays empty and shows the reason.
6. **Waits and failures state the reason and the next time together** (UX_COPY §4 one-line reasons).
7. **Risk is not hidden, but it does not scare.** Turning on yield mode shows the full risk disclosure. The default is "contribution only (safe mode)".
8. **No empty screens or buttons such as "coming soon".** Features that do not exist are not drawn at all (sector picking, AI recommendations and web wallet connection are not drawn).

## 3. Visual direction

- **Feel**: A bright, calm finance app (simple, with lots of white space, like the Toss or Robinhood web apps). Avoid the crypto-exchange feel (neon, dark, too many charts).
- **No Binance or BNB logos and no yellow-and-black brand feel** (it must not look like an official service). The footer says "Built on the Binance Web3 API · BNB Chain" in text only.
- **Color**
  - Backgrounds are white and a very light gray (the #F7F8FA family), text is near-black (#111), secondary text is gray.
  - Only one brand accent color is used. The proposal is a deep teal. It feels like "interest, growth, trust" and does not clash with the red and green price colors.
  - Semantic colors: success (teal), waiting (amber), skipped (gray), failure (red), info (blue).
  - **Price moves do not use red or green.** In Korea red means up, in the US green means up, so it is confusing. ▲▼ arrows and signs (+/−) are used in a neutral color.
- **Typeface**: Pretendard for Korean, Inter for English and numbers. Amounts and share counts use **fixed-width numbers (tabular numbers)**. The base size is 16px.
- **Shape**: card corners 12–16px, a shallow shadow or a 1px border, generous spacing (8px grid).
- **Accessibility**: Contrast is WCAG AA or better. Keyboard focus is visible. Status is never told apart by color alone (icons and text are used together).
- **Time format**: Times are in the user's local time (KST for Korean). Example: "Today 22:30 (US open)". Hovering shows UTC.

## 4. Site structure and menu

```
Yieldvest
├─ Home (Watch)                  /
├─ Try it (Judge Mode)           /judge      ← finish in 3 minutes with a judge code
├─ Plan detail                   /plans/[id] ← reached from a Home card or a receipt (not in the menu)
├─ With my AI assistant (Skill)  /skill
├─ Data (DX)                     /dx
└─ Risk disclosure (Risks)       /risk
```

**Global header** (every page, 64px tall, stays pinned to the top on scroll)
- Left: the wordmark "Yieldvest".
- Center menu: Home · Try it · With my AI assistant · Data · Risks. The English version is Home · Try it · With my AI assistant · Data · Risks. **[new copy]** The menu names have to be added to UX_COPY.
- Right
  - **Market status badge**: `home.market.regular` "US regular session · closes {close}" or `home.market.closed` "US market closed · opens {open}"
  - **Data status dot**: Live / n min old / Unavailable
  - **Language toggle**: KO | EN
- "Try it" is styled as a button (accent color). It is the judges' main destination.

**Global footer**
- Links: GitHub repo · DX report · Risks · Data
- Copy: "Yieldvest is not a bank. You can lose principal." **[new copy]** It shortens the first line and item 1 of UX_COPY §5.
- "Built on the Binance Web3 API · BNB Chain" (text only)
- In small print: "Every buy is dry-run on-chain before it runs." **[new copy]**

## 5. Page-by-page spec

### 5.1 Home (Watch) `/`
Goal: within 3 seconds, the visitor knows "what it is, that it is really running, and how to try it".

**① Hero** (first screen, text on the left, interest counter on the right)
- Title `home.title`: "Interest buys the stock."
- Subtitle `home.sub`: "Your principal stays put. Only the interest buys US stocks."
- Two buttons
  - Primary button `home.cta.judge` "Try it with a judge code" → /judge
  - Secondary button `home.cta.skill` "Start with my AI assistant" → /skill
- On the right, the **live interest counter card** (the key scene of this service)
  - Big number: interest earned so far. It rises every second, to six decimal places. A block is produced every 0.45 seconds, so the number keeps moving. Example: `$0.184213`
  - Label `home.house.interest` "Interest earned so far"
  - Progress bar below: "$0.07 to the next buy · expected {date}" **[new copy]**. It is the progress toward the minimum buy.
  - Small print: "Interest account (Venus) 3.16% APY · security score 93.1" + status badge
  - This card links to the detail page of the "house interest plan".

**② A plan Yieldvest runs itself (2 cards)** `home.house.card.title`
- Card A — contribution plan: "NVIDIA · $5 daily · regular hours only". Items:
  - `home.house.shares` Shares collected
  - `home.house.next` Next buy
  - Limit used today
- Card B — interest plan: "QQQ · interest only · weekly". Items:
  - `home.house.principal` Principal in the interest account
  - `home.house.interest` Interest earned so far
  - `home.house.shares` Shares collected
  - `home.house.next` Next buy (condition: "When interest reaches $0.25")
- Common to both
  - A small cumulative chart (contribution: shares collected; interest: interest earned)
  - Status badge
  - "View history →" (plan detail)
  - Receipt count: "12 receipts" **[new copy]**

**③ Recent activity (receipt feed)**: records Yieldvest left on its own, the 10 most recent, newest first, "View all"
- Each row: time · plan name · **outcome badge** · one-line reason · amount · shares · [View receipt ↗](BscScan)
- 4 outcome badges **[new copy]**: Bought (BOUGHT, teal) · Waiting (DEFERRED, amber) · Skipped (SKIPPED, gray) · Failed (FAILED, red). Icon and text are used together.
- The one-line reason uses UX_COPY §4 verbatim. The mockup shows all five kinds below.
  - `why.bought.interest` "Used $0.26 of interest to buy 0.000351 shares of QQQ. Principal untouched."
  - `why.bought.regular` "Bought 0.022229 shares of NVDA ($5.00) during regular hours."
  - `why.deferred.market_closed` "US market is closed. Retrying at Monday 22:32."
  - `why.skipped.below_min` "Interest is at $0.18. Will buy at $0.25."
  - `why.skipped.corporate_action.earnings` "TSLA is restricted for earnings. Retrying when lifted."
- ※ The "{gap}% vs reference" part of `why.bought.*` is attached only when a real US stock price is available. Without one, the line is drawn with that part left out.

**④ "Why buy only during regular hours?" insight card** (a story only tokenized stocks have)
- Title: "How much more does it cost when the market is closed?" **[new copy]**
- Small chart: over the last 7 days, the gap (%) between the tokenized-stock piece price and the real US stock price for the same stock, plotted over time. Market-closed hours are shaded gray.
- One-line summary: "Over the last 7 days, off-hours prices were +0.4% higher than the real stock price on average (example)" **[new copy]**
- Source line: "Recorded every 10 minutes from our Frankfurt server" + status badge + "More in Data →"

**⑤ Stocks you can collect** (5 cards in a row)
- Card contents
  - Company name (NVIDIA / Tesla / Microsoft / Nasdaq-100 ETF / Apple), ticker
  - Price per share
  - Market status
  - Where to buy: issuer badge (bStocks / Ondo)
  - Minimum order ($5.01 on Ondo)
- **Apple card**: "Only on Ondo · minimum order $5.01" **[new copy]**
- One-line explanation: "Each piece is about 1.0008 real shares (it changes slightly with dividends)." **[new copy]**
- A stock whose multiplier is about to change gets the badge "Share counts display differently from Oct 1". **[new copy]**, one example only.

**⑥ Why you can check us** (a horizontal strip of 3~4 icons)
- "Every buy is dry-run on-chain first"
- "Limits: $25 per buy · $50 per day" (the principle that caps are shown on screen)
- "Guardian: All clear · last check {time}" (`plan.guardian.ok`)
- "Our server never holds your wallet keys"
- ※ All of these are **[new copy]**. The exception is `plan.guardian.ok`, which is existing copy.

**Home variant mockup (one more)**: **weekend version.**
- The header badge reads "US market closed · opens Mon 22:30".
- The contribution plan card's next buy is "Monday 22:32".
- The top of the feed has a DEFERRED record.
- The interest counter keeps rising over the weekend. That is the point.

### 5.2 Try it (Judge Mode) `/judge`
Goal: with one code, a judge gets all the way to a real buy receipt within 3 minutes.

**Layout**
- A 6-step progress indicator at the top: ① Code ② Stock ③ How & how much ④ Preview ⑤ Run ⑥ Receipt
- The wide left column holds the current step.
- The narrow right column (fixed while scrolling) is the **summary panel**: stock · mode · amount · when to buy · limit (${cap} from `judge.code.hint`) · market status

**① Code**
- `judge.code.title` "Enter your judge code"
- One input field + [Continue]
- Help text `judge.code.hint` "One code covers up to $5. Funds come from Yieldvest's own wallet."
- Error states **[new copy]**: "That code doesn't match" / "This code has used its limit"

**② Pick a stock**
- `judge.pick.title` "Which stock should we collect?"
- 5 stock cards (the same cards as Home ⑤, made selectable). A selected card gets an accent-color border.
- Below the cards: `judge.pick.issuer.auto` "Issuer chosen automatically (bStocks)"
- **The Apple card is disabled**: "Only on Ondo with a $5.01 minimum, above this code's $5 limit" **[new copy]**
- Picking by sector (`judge.pick.sector`) is **not drawn** (out of scope this time).

**③ Mode, amount and time**
- 2 mode cards
  - `judge.mode.safe` "Contribution only (default)" + `judge.mode.safe.desc`: selected by default.
  - `judge.mode.yield` "Buy with interest" + `judge.mode.yield.desc`: choosing it opens the **risk disclosure modal** (full text from §5.5, checkbox "I understand" + [Agree and turn on]).
- Amount `judge.amount.label` "Amount for this buy": button choices $2.50 / $5.00 (max = the trial limit) and custom entry.
- When to buy
  - `judge.window.regular` "Buy only during US regular hours (recommended)"
  - `judge.window.anytime` "Buy even when the market is closed (price may differ from reference)"
  - If the market is closed right now, each of the two options gets a note below it.
    - Regular session: "Buys automatically at the next open, 22:30 today" **[new copy]**
    - While the market is closed: "Buys right away · half the limit ($2.50) · over the last 7 days, off-hours prices were +0.4% higher on average" **[new copy]**
- If yield mode is chosen, then instead of the buy amount it shows "Principal to put in" and the expected interest, **honestly**. Small numbers are shown as they are. Example: "If you put in $5, a week of interest is about $0.003 · Buys made with interest show on Yieldvest's own plan" **[new copy]**

**④ Preview**
- `judge.preview.title` "Here is what will happen"
- Sentence summary `judge.preview.line`: "You pay $5 and receive about 0.0222 shares of NVDA. Network fee about $0.02."
  - If a real US stock price is available, append "+0.3% vs reference."
- Outcome badge
  - Success `judge.preview.simulated` "Dry-run on-chain · success" (teal check)
  - Failure variant mockup `judge.preview.failed` "The dry-run failed: {reason}. No funds moved."
- **Quote validity display**: "This price is good for 25 seconds" + a shrinking circular timer. When it runs out, a new price is fetched automatically. **[new copy]**
- "Details" collapsible area: route (exchange name), price impact %, number of pieces to receive (token count), issuer, contract address (0x… appears only here).
- Primary button `judge.run.cta` "Buy now", secondary button "Back".

**⑤ Running**
- 3-step progress indicator `judge.run.progress.{approve|swap|confirm}`: "Allowing… → Buying… → Confirming…"
- As each step finishes, it gets a check mark and the time it took.

**⑥ Receipt**
- `judge.done.title` "Done" + a big check
- `judge.done.line` "NVDA 0.022229 shares ($5.00) · View receipt" (BscScan in a new window)
- One-line reason (`why.bought.regular`)
- Note: "This plan keeps running for 7 days. Come back to see its history." **[new copy]**
- Buttons
  - `judge.stop.cta` "Stop this plan" (secondary, with a confirmation dialog)
  - "View plan history →" (plan detail)
- If it was yield mode, `judge.stop.yield.note` "Takes all principal out of the interest account. Your shares stay." goes next to the stop button.

**Trial variant mockups (required)**
- (a) **Scheduled**: when "buy only during regular hours" was chosen but the market is closed. `why.deferred.market_closed` "US market is closed. Retrying at 22:32 today." + "When it buys, it shows in the plan history · View plan history →" **[new copy]**
- (b) **Preview failed**: the ④ failure badge above + [Try again].
- (c) **Limit reached**: `why.skipped.daily_cap` "Daily limit ($50) reached. Tomorrow."
- (d) **Risk disclosure modal**: see §5.5.

### 5.3 Plan detail `/plans/[id]`
- **Header**
  - Plan name: "QQQ · interest only · weekly · regular hours only" **[new copy format]**
  - Status badge: Running / Paused / Stopped **[new copy]**
  - Who runs it: "Run by Yieldvest" / "Judge trial" **[new copy]**
- **4 summary cards**
  - Principal in the interest account (`home.house.principal`)
  - Interest earned so far (`home.house.interest`, live counter)
  - Shares collected (`home.house.shares`) + average price
  - Next buy (`home.house.next`, condition or time)
- **Limit bar** `plan.limits` "Limits: $25 per buy · $50 per day · $5 used today"
- **Guardian panel** `plan.guardian.title` "Guardian"
  - Normally: `plan.guardian.ok` "All clear · last check 14:20"
  - The 4 things it watches, as a small list: whether Venus is paused, utilization (72.8% / limit 95%), USDT price ($1.000 / floor $0.99), price impact (limit 1%) **[new copy]**
  - Triggered variant: `why.skipped.guardian` "Guardian stopped the plan: Utilization above 95%. Principal moved back to the wallet."
- **History** `plan.timeline.title`
  - Vertical timeline. Filter chips: All / Bought / Waiting / Skipped / Failed
  - Each entry: time · outcome badge · one-line reason · amount · shares · receipt link
  - Buys made with interest get an "Interest only" label. **[new copy]**
- **Shares held**
  - Display: "QQQ 0.001204 shares · avg $741.10"
  - Small note: "1 piece = 1.0007 shares" **[new copy]**
  - Notice of an upcoming multiplier change (only when there is one)
- **Actions**
  - `judge.stop.cta` "Stop this plan"
  - An interest plan also gets "Take out all principal". Both go through a confirmation dialog. **[new copy]**

### 5.4 With my AI assistant (Skill) `/skill`
- Title `skill.title` "Hand it to your AI assistant"
- 3 step cards (numbered circles)
  - `skill.step1` "Create an Agentic Wallet in the Binance app."
  - `skill.step2` "Install this one line into your assistant." + a code box (copy button). The command stays a placeholder: `npx skills add …/skills/yieldvest` (the path is decided later).
  - `skill.step3` "Say \"Start Yieldvest\". Your assistant asks before every action."
- Highlight box `skill.note` "Yieldvest's server only decides. Signing always happens on your device."
- **Example conversation** (chat bubbles, only a light terminal feel)
  1. User: "Start Yieldvest. Collect $5 of NVDA every week."
  2. Assistant: reads out a summary of the risk disclosure and gets consent.
  3. Assistant: "I'll buy 0.0222 shares of NVDA for $5 now. The dry-run succeeded. Go ahead?"
  4. User: "Yes"
  5. Assistant: "Bought. Receipt: …"
- **Safety rules list** (check icons) **[new copy]**
  - It always previews and asks before changing anything.
  - It checks every address the server gives against the official list.
  - It warns two hours before the wallet login expires (the Agentic Wallet login has to be redone about every 48 hours).
  - An order number is not a trade; it waits for confirmation.
  - It passes error messages on as they are.

### 5.5 Risk disclosure `/risk` (+ a modal when yield mode is turned on)
- Uses the full text of UX_COPY §5 verbatim (KR/EN).
  - First paragraph: "Yieldvest is not a bank. The interest account is a lending service on BSC (Venus). The interest is paid by people who borrow there."
  - Numbered items 1~5. Put 3.16 in {apy} and 93.1 in {score} as example values, and add a live-value marker and a status badge.
  - Last line "I understand this and will only use money I can afford to lose." + [Agree and turn on](modal only)
- The page version adds "The default is contribution only (safe mode) · no interest account". **[new copy]**
- The modal is about 560px wide, and the button turns on only after the reader scrolls to the end.

### 5.6 Data (DX) `/dx`
A page for judges (developers). Tables and charts are the focus, and technical terms are fine here.
- **4 summary numbers**: total API calls · error rate · p95 latency · tape records (since the start date)
- **Endpoint table**: module · endpoint · calls · p50 · p95 · error code breakdown (chips). Sortable.
- **Region comparison**: latency from the dev PC in Korea vs. the Frankfurt server (2 bars each)
- **4 tape charts**
  1. Per stock, the gap (%) of "piece price vs. the real US stock price". Time axis; market-closed stretches are shaded.
  2. Price impact by order size ($5 / $50 / $500), colored by issuer
  3. Quote success rate by session (regular session, pre-market and after-hours, overnight, weekend)
  4. Issuer comparison table: minimum order, overnight session, differences in status info
- **Findings list**: date · tag (chips) · title · "Details" link (to dx/LOG.md in the repo)
- Every block gets a status badge and "Updated {time}".

## 6. Shared components (on one component sheet)
1. Header / footer / language toggle
2. Buttons: primary, secondary, text, danger (red). 2 sizes, loading state, disabled state
3. Status badge: Live / n min old / Unavailable (reason tooltip)
4. Market status badge: regular session open / market closed, next open
5. Outcome badge: Bought / Waiting / Skipped / Failed (+ "Interest only" label)
6. One-line reason row (icon + sentence + time)
7. Receipt link (↗ BscScan)
8. Plan card (contribution type / interest type)
9. Live interest counter (big number + progress bar)
10. Stock card (view / select / disabled)
11. Step indicator (6 steps, 3 steps)
12. Summary panel (right side of the trial)
13. Modal (risk disclosure, stop confirmation)
14. Timer (25-second quote)
15. Table (sorting, empty state), chart style (lines, bars, shaded ranges; color rules)
16. Empty state / loading (skeleton) / error state — one example of each, applied to a block

## 7. Example data for the mockups (values with a measured basis, so nothing looks like a fake track record)
These examples are for the mockups only. The real screens show server values.
- **Price per share**: NVIDIA $225.10 · Nasdaq-100 ETF (QQQ) $740.77 · Tesla, Microsoft and Apple get reasonable values
- **Issuers**: NVDA, TSLA, MSFT and QQQ are on both bStocks and Ondo. AAPL is on Ondo only. Ondo's minimum order is $5.01.
- **Multipliers**: NVDA (bStocks) 1.000778 · QQQ (bStocks) 1.000725 · TSLA 1
- **Interest account**: Venus USDT 3.16% APY · security score 93.1 · utilization 72.8%
- **Interest plan principal**: $1,000 (example, amount not decided) → about $0.087 of interest a day
- **Minimum buy**: example $0.25 (not decided; currently set to $2). The mockup's "$0.07 to the next buy" is based on $0.18 of accrued interest.
- **Contribution plan**: $5 daily, NVDA. About 0.111 shares after 5 buys
- **Network fee**: about $0.02
- **Quote validity**: 30 seconds. The screen shows 25 seconds.
- **US regular session**: Korea time 22:30~05:00 (weekdays)

## 8. Don'ts
- Binance/BNB logos, a yellow-and-black exchange style
- 0x addresses or token amounts on the first screen
- Banned words: principal guarantee · safe return · fixed interest · riskless · guarantee · guaranteed · risk-free · safe yield · principal protected · expected return · recommended stock
- "Coming soon" or not-yet-ready buttons and tabs (sector picking, AI recommendations, web wallet connection)
- Showing price rises and falls with red and green color alone
- Inflated numbers, big rounded-up return figures, return-forecast charts
- A first screen packed with numbers like a dashboard (Home follows a story order: what → proof → try it)

## 9. Deliverables (frame list, 1440px)
1. Design token sheet: color, type scale, spacing, corners, shadows, icon style
2. Component sheet (all of §6, by state)
3. Home — weekday regular-session version (KR) · **English version (EN)** · weekend version (KR)
4. Try it — ①Code (KR·**EN**) ②Stock (KR·**EN**) ③How & how much ④Preview (success) ④Preview (failure) ⑤Running ⑥Receipt · Scheduled · Limit reached · Risk disclosure modal
5. Plan detail — interest plan (normal) · guardian triggered state
6. With my AI assistant
7. Risk disclosure (page)
8. Data (DX)
9. One sheet of empty, loading and error state examples

## 10. Reference: list of new copy needed (all [new copy] items)
5 menu names · 4 outcome badges and the "Interest only" label · next-buy progress copy · insight card title and summary · reason the Apple card is disabled · multiplier explanation and upcoming change · 4 reasons you can check us · 2 code errors · notes for the regular-session and off-hours options · expected interest in yield mode · quote validity · 7-day note after the trial · Scheduled-state explanation · plan name format, status and owner · guardian watch items · take out all principal · skill safety rules · risk disclosure page addition · footer copy.
→ Once the mockups are final, this copy is added to `docs/UX_COPY.md` in KR/EN and then implemented.
