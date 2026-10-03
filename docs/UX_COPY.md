# UX_COPY.md — UI copy

Author: Minseo Kang. Rule: every UI string uses a key from this document. When new copy is needed, add it here first. `pnpm lint:copy` checks for the §6 banned words.

> **Human decision, 9/27 (DECISIONS D-26): the web UI is English only.** Since D-27 (9/27) this document is English only as well: each line reads `` `key`: text ``, and the Korean column is gone.

## 1. Principles
1. The reader does not know crypto. Use the words in the §2 table.
2. One decision per screen. Buttons are verbs.
3. Numbers are honest: small ones are shown as they are.
4. A failure or a wait always comes with its reason and the next time.
5. Never hide a risk, and never scare people with it.

## 2. Terminology
| Don't say | Say |
| --- | --- |
| token (quantity) | shares |
| swap | buy / sell |
| gas | network fee |
| contract / address | (hidden; only under "Details") |
| slippage | price tolerance |
| approve | allow |
| deposit / lending | put in the interest account |
| redeem | take out |
| tx / transaction | receipt |
| on-chain | recorded on-chain (only when needed) |
| ref price | reference price (platform) |

## 3. Copy by screen

### 3.1 Home (Watch)
- `home.title`: Interest buys the stock.
- `home.sub`: Your principal stays put. Only the interest buys US stocks.
- `home.status.live`: Live · `home.status.stale`: {min} min old · `home.status.unavailable`: Unavailable ({reason})
- `home.market.regular`: US regular session · closes {close}
- `home.market.closed`: US market closed · opens {open}
- `home.cta.judge`: Try it with a judge code
- `home.cta.skill`: Start with my AI assistant
- `home.house.card.title`: A plan Yieldvest runs itself
- `home.house.principal`: Principal in the interest account
- `home.house.interest`: Interest earned so far
- `home.house.shares`: Shares collected
- `home.house.next`: Next buy

### 3.2 Judge Mode
- `judge.code.title`: Enter your judge code
- `judge.code.hint`: One code covers up to ${cap}. Funds come from Yieldvest's own wallet.
- `judge.pick.title`: Which stock should we collect?
- `judge.pick.sector`: Or pick a sector
- `judge.pick.issuer.auto`: Issuer chosen automatically ({issuer})
- `judge.mode.safe`: Contribution only (default)
- `judge.mode.safe.desc`: Buys only with the amount you set. No interest account.
- `judge.mode.yield`: Buy with interest
- `judge.mode.yield.desc`: Puts principal in the interest account and buys with the interest it earns.
- `judge.amount.label`: Amount for this buy
- `judge.window.regular`: Buy only during US regular hours (recommended)
- `judge.window.anytime`: Buy even when the market is closed (price may differ from reference)
- `judge.preview.title`: Here is what will happen
- `judge.preview.line`: You pay ${usd} and receive about {shares} shares of {ticker}. Network fee about ${fee}. {gap}% vs reference.
- `judge.preview.simulated`: Dry-run on-chain · success
- `judge.preview.failed`: The dry-run failed: {reason}. No funds moved.
- `judge.run.cta`: Buy now
- `judge.run.progress.{approve|swap|confirm}`: Allowing… / Buying… / Confirming…
- `judge.done.title`: Done
- `judge.done.line`: {ticker} {shares} shares (${usd}) · View receipt
- `judge.stop.cta`: Stop this plan
- `judge.stop.yield.note`: Takes all principal out of the interest account. Your shares stay.

### 3.3 Plan detail
- `plan.limits`: Limits: ${perBuy} per buy · ${daily} per day · ${used} used today
- `plan.guardian.title`: Guardian
- `plan.guardian.ok`: All clear · last check {time}
- `plan.timeline.title`: History

### 3.4 Skill guide
- `skill.title`: Hand it to your AI assistant
- `skill.step1`: Create an Agentic Wallet in the Binance app.
- `skill.step2`: Install this one line into your assistant.
- `skill.step3`: Say "Start Yieldvest". Your assistant asks before every action.
- `skill.note`: Yieldvest's server only decides. Signing always happens on your device.

## 4. One-line reasons (whyKey)
| Key | Text |
| --- | --- |
| `why.bought.regular` | Bought {shares} shares of {ticker} (${usd}) during regular hours. {gap}% vs reference. |
| `why.bought.anytime` | Bought {shares} shares of {ticker} (${usd}) while the market was closed. {gap}% vs reference. |
| `why.bought.interest` | Used ${interest} of interest to buy {shares} shares of {ticker}. Principal untouched. |
| `why.deferred.market_closed` | US market is closed. Retrying at {open}. |
| `why.deferred.price_gap` | Price is {gap}% above reference. Will buy once within 2%. |
| `why.deferred.quote_impact` | This size moves the price too much ({impact}% impact). Retrying smaller. |
| `why.skipped.below_min` | Interest is at ${acc}. Will buy at ${min}. |
| `why.skipped.corporate_action.earnings` | {ticker} is restricted for earnings. Retrying when lifted. |
| `why.skipped.corporate_action.cash_dividend` | {ticker} is paused for a dividend. |
| `why.skipped.corporate_action.stock_split` | {ticker} is paused for a stock split. Share counts may change. |
| `why.skipped.daily_cap` | Daily limit (${daily}) reached. Tomorrow. |
| `why.skipped.guardian` | Guardian stopped the plan: {rule}. Principal moved back to the wallet. |
| `why.skipped.no_liquidity` | No liquidity for {ticker} right now. |
| `why.failed.simulation` | Dry-run failed ({code}). No funds moved. |
| `why.failed.onchain` | The transaction failed ({code}). Only the network fee was spent. |

## 5. Risk disclosure (full text; shown when yield mode is turned on, and on `/risk`)
> Yieldvest is not a bank. The interest account is a lending service on BSC (Venus). The interest is paid by people who borrow there.
> 1. You can lose principal. If Venus is exploited or USDT loses its peg, you may not get it back.
> 2. The rate changes daily. Today it is {apy}% APY (platform security score {score}).
> 3. Share prices go up and down.
> 4. You can withdraw any time, but if the service pauses it may take longer.
> 5. Yieldvest's guardian moves principal back to your wallet on warning signs, but cannot prevent every incident.
> I understand this and will only use money I can afford to lose. [Agree and turn on]

## 6. Banned words (`pnpm lint:copy`)
guaranteed · guarantee · risk-free · safe yield · safe return · principal protected · fixed interest · expected return · recommended stock (an AI recommendation feature is labeled "see the official analysis report")

## 7. Agent drafts — until a person confirms them (DESIGN_BRIEF §10)
> Author: coding agent (9/26). **These are drafts until a person reviews, edits and confirms them.** The Korean originals came verbatim from DESIGN_BRIEF's [new copy] items and were removed with D-27; the English, and the copy for UI parts the brief did not cover (buttons, errors, table headers), was written by the agent. The format is the same as §3 (`key`: text). `pnpm copy:gen` builds `apps/web/lib/i18n/copy.ts` from this document; to change a string, edit this document and regenerate.

### 7.1 Common
- `nav.home`: Home
- `nav.judge`: Try it
- `nav.skill`: With my AI assistant
- `nav.dx`: Data
- `nav.risk`: Risks
- `footer.risk`: Yieldvest is not a bank. You can lose principal.
- `footer.apis`: Built on the Binance Web3 API · BNB Chain
- `footer.simulate`: Every buy is dry-run on-chain before it runs.
- `footer.github`: Source code (GitHub)
- `common.confirm`: Continue
- `common.cancel`: Cancel
- `common.back`: Back
- `common.retry`: Try again
- `common.details`: Details
- `common.loading`: Loading…
- `common.view_all`: View all
- `common.updated`: Updated {time}
- `common.none`: None
- `common.notfound`: This page doesn't exist
- `receipt.view`: View receipt ↗
- `outcome.BOUGHT`: Bought
- `outcome.DEFERRED`: Waiting
- `outcome.SKIPPED`: Skipped
- `outcome.FAILED`: Failed
- `outcome.interest_only`: Interest only
- `outcome.simulated`: Dry run
- `outcome.running`: In progress
- `outcome.deposit`: Put in the interest account
- `outcome.redeem`: Taken out of the interest account
- `outcome.approve`: Exact approval for the interest account
- `why.data.stale`: The data is old, so we wait. Checking again at {time}.
- `why.data.unavailable`: The data is unavailable, so we wait.
- `why.skipped.guardian.hold`: The guardian paused buying: {rule}. Principal stays where it is.
- `why.skipped.venue_minimum`: {ticker} needs an order of at least ${min}. This plan's per-buy limit (${limit}) can't reach it.

### 7.2 Home
- `home.house.next.progress`: ${left} to the next buy
- `home.house.next.min`: When interest reaches ${min}
- `home.house.receipts`: {n} receipts
- `home.house.link`: View history →
- `home.house.today`: ${used} of ${daily} used today
- `home.feed.title`: Recent activity
- `home.feed.empty`: Nothing recorded yet.
- `home.insight.title`: How much more does it cost when the market is closed?
- `home.insight.summary`: Over the last 7 days, off-hours prices differed from the real stock price by {offhours}% on average ({regular}% in regular hours).
- `home.insight.source`: Recorded every 10 minutes from our Frankfurt server
- `home.insight.more`: More in Data →
- `home.stocks.title`: Stocks you can collect
- `home.stocks.price`: Price per share
- `home.stocks.where`: Where to buy
- `home.stocks.min`: Minimum order ${min}
- `home.stocks.only_ondo`: Only on Ondo · minimum order ${min}
- `home.stocks.multiplier`: Each piece is about {m} real shares (it changes slightly with dividends).
- `home.trust.title`: Why you can check us
- `home.trust.simulate`: Every buy is dry-run on-chain first
- `home.trust.caps`: Limits: ${perTx} per buy · ${daily} per day
- `home.trust.keys`: Our server never holds your wallet keys
- `home.counter.asof`: Read on-chain at {time}
- `home.counter.apy`: Interest account (Venus) {apy}% APY · security score {score}

### 7.3 Plan
- `plan.name.safe`: {ticker} · ${usd} {cadence} · {window}
- `plan.name.yield`: {ticker} · interest only · {cadence} · {window}
- `plan.cadence.daily`: daily
- `plan.cadence.weekly`: weekly
- `plan.window.regular_session`: regular hours only
- `plan.window.anytime`: any time
- `plan.status.active`: Running
- `plan.status.paused`: Paused
- `plan.status.stopped`: Stopped
- `plan.owner.house`: Run by Yieldvest
- `plan.owner.judge`: Judge trial
- `plan.owner.skill`: My AI assistant
- `plan.paused.awaiting_funding`: Starts once funded
- `plan.paused.awaiting_run`: Waiting for its first run
- `plan.paused.awaiting_deposit`: Waiting for its deposit to be reported
- `plan.paused.report_over_limit`: Paused: a reported buy went over its limits
- `plan.paused.guardian`: Paused by the guardian
- `plan.paused.expired`: Ended after 7 days
- `plan.paused.stopped_by_owner`: Stopped by its owner
- `plan.paused.done`: Ended after its one buy
- `plan.paused.code_disabled`: Paused: its judge code was turned off
- `plan.paused.needs_review`: Paused until a person checks its last transaction
- `plan.paused.redeemed`: Paused: its principal was taken out of the interest account
- `plan.paused.operator_redeem`: Paused: the Yieldvest team took its principal out of the interest account
- `plan.paused.paused_by_operator`: Paused by the Yieldvest team
- `plan.paused.redeem_held`: {reason}. Its principal is still in the interest account; the Yieldvest team has been alerted.
- `plan.paused.other`: Paused: {reason}
- `plan.next.none`: Not scheduled
- `plan.summary.average`: Average price ${avg}
- `plan.holdings.title`: Shares held
- `plan.holdings.line`: {ticker} {shares} shares · avg ${avg}
- `plan.holdings.multiplier`: 1 piece = {m} shares
- `plan.guardian.metrics`: What it watches
- `plan.guardian.utilization`: Interest account utilization {value}% (limit 95%)
- `plan.guardian.usdt`: USDT price ${value} (floor $0.99)
- `plan.guardian.tvl`: Interest account size ${value} (stops on a −30% day)
- `plan.guardian.impact`: Price impact limit 1%
- `plan.guardian.open`: Holding now: {rule}
- `plan.guardian.nodata`: No checks recorded yet
- `guardian.rule.usdt_depeg`: USDT off its peg
- `guardian.rule.tvl_drop`: Sharp drop in the interest account
- `guardian.rule.protocol_paused`: Venus paused
- `guardian.rule.utilization_high`: Utilization above 95%
- `guardian.rule.multiplier_changed`: Share multiplier changed
- `plan.timeline.all`: All
- `plan.stop.confirm`: Stop this plan?
- `plan.stop.queued`: Stopping…
- `plan.stop.done`: Stopped

### 7.4 Try it
- `judge.step.code`: Code
- `judge.step.pick`: Stock
- `judge.step.mode`: How & how much
- `judge.step.preview`: Preview
- `judge.step.run`: Run
- `judge.step.done`: Receipt
- `judge.code.error.bad`: That code doesn't match
- `judge.code.error.exhausted`: This code has used its limit
- `judge.error.daily_cap`: Today's limit across all codes is reached — your code still has ${remaining}. Try again after 00:00 UTC.
- `judge.code.remaining`: ${remaining} left on this code
- `judge.pick.venue_min`: Only on Ondo with a ${min} minimum, above this code's ${cap} limit
- `judge.window.regular.closed`: Buys automatically at the next open, {open}
- `judge.window.anytime.closed`: Buys right away · half the limit (${half})
- `judge.amount.custom`: Custom
- `judge.yield.amount`: Amount to put in the interest account
- `judge.yield.note`: Interest is recorded as it accrues. Buys made with interest show on Yieldvest's own plan.
- `judge.risk.check`: I understand
- `judge.preview.cta`: Dry-run it
- `judge.preview.waiting`: Our server is dry-running it on-chain…
- `judge.preview.deposit`: Puts ${usd} in the interest account.
- `judge.details.issuer`: Issuer
- `judge.details.pieces`: Pieces to receive
- `judge.details.min`: Minimum received
- `judge.details.contract`: Contract address
- `judge.run.waiting`: Our server is on it…
- `judge.done.plan_note`: This plan keeps running for 7 days. Come back to see its history.
- `judge.done.deferred_note`: When it buys, it shows in the plan history.
- `judge.done.deposited`: Put ${usd} in the interest account.
- `judge.done.simulated`: The server is in simulation mode, so nothing was bought. Only the dry-run was recorded.
- `judge.done.confirming`: Waiting for the blockchain record. It shows in the plan history once confirmed.
- `judge.done.approval_pending`: The exact approval is still being confirmed, so nothing was put in yet. Try again in a minute.
- `judge.preview.approval_first`: Dry-run on-chain · the exact approval passes. The buy is dry-run again right after it, before anything is signed.
- `judge.done.not_started`: This plan has not started, so it will not try again by itself.
- `judge.done.deposit_simulated`: Dry-run on-chain · the exact approval and the deposit pass. The server is in simulation mode, so nothing was put in.
- `judge.done.deposit_approval_first`: Dry-run on-chain · the exact approval passes. The deposit is dry-run again right after it, before anything is signed. The server is in simulation mode, so nothing was put in.
- `judge.done.outbox_busy`: An earlier transaction is still settling, so nothing was signed. Try again in a few minutes.
- `judge.done.locked`: This plan is busy with another run, so nothing was signed. Try again in a minute.
- `judge.done.review`: A person has to check this plan's last transaction before anything else runs. The plan is paused until then.
- `judge.done.stopped`: This plan is stopped. Nothing was bought.
- `judge.job.still_queued`: The worker has not finished this yet. It may still run: check the plan history in a few minutes.
- `judge.summary.title`: Summary
- `judge.summary.window`: When
- `judge.plan.link`: View plan history →
- `judge.error.generic`: Something went wrong: {reason}
- `judge.error.rate_limited`: Too many requests. Try again shortly.
- `judge.error.unavailable`: The trial isn't available right now ({reason})
- `judge.job.failed`: Couldn't finish: {reason}

### 7.5 Risk, skill and data
- `risk.page.default`: The default is contribution only (safe mode) · no interest account
- `skill.install.label`: Install command
- `skill.example.title`: Example conversation
- `skill.example.me`: Me
- `skill.example.assistant`: Assistant
- `skill.example.1`: Start Yieldvest. Collect $5 of NVDA every week.
- `skill.example.2`: Before we start, here are the risks. You can lose principal. Do you agree?
- `skill.example.3`: I'll buy $5 of NVDA now. The dry-run succeeded. Go ahead?
- `skill.example.4`: Yes
- `skill.example.5`: Done. The receipt is recorded.
- `skill.rules.title`: Rules the assistant follows
- `skill.rules.1`: It always previews and asks before changing anything.
- `skill.rules.2`: It checks every address the server gives against the official list.
- `skill.rules.3`: It warns two hours before the wallet login expires.
- `skill.rules.4`: An order number is not a trade; it waits for confirmation.
- `skill.rules.5`: It passes error messages on as they are.
- `skill.api`: API reference for developers (OpenAPI)
- `dx.title`: Data
- `dx.sub`: Numbers we measured from our real calls to the Binance Web3 API.
- `dx.summary.calls`: API calls
- `dx.summary.error_rate`: Error rate
- `dx.summary.p95`: p95 latency
- `dx.summary.tape`: Tape quotes
- `dx.endpoints.title`: By endpoint
- `dx.regions.title`: Latency by region
- `dx.col.module`: Module
- `dx.col.endpoint`: Endpoint
- `dx.col.calls`: Calls
- `dx.col.errors`: Errors
- `dx.col.codes`: Result codes
- `dx.col.region`: Region
- `dx.col.issuer`: Issuer
- `dx.col.quotes`: Quotes
- `dx.col.quote_errors`: Quote errors
- `dx.col.impact`: Avg price impact
- `dx.col.gap`: Avg price gap
- `dx.col.size`: Order size
- `dx.col.session`: Session
- `dx.tape.gap.title`: Price gap by session (token price ÷ multiplier vs the US price)
- `dx.tape.impact.title`: Price impact by order size
- `dx.tape.issuers.title`: Issuers compared
- `dx.findings.title`: Findings
- `dx.findings.empty`: No undocumented codes seen yet.
- `dx.method`: Method: {method}
- `dx.window`: Last {days} days
- `dx.session.regular`: Regular
- `dx.session.pre`: Pre-market
- `dx.session.post`: After hours
- `dx.session.overnight`: Overnight
- `dx.session.weekend`: Weekend
- `dx.session.holiday`: Holiday

### 7.6 The approved design (frontend-preview → apps/web, DECISIONS D-25)
> Author: coding agent (9/27). Keys added while moving the user-approved English design (`frontend-preview/`) into the real app. **The rule is that the English is the approved preview copy, carried over as is** (tab names, "See where your interest goes.", "Small interest. Next investment.", "Every step, accounted for.", "Interest becomes ownership", the labels of the flow diagram, the receipt and the progress bar, and so on). Copy the preview used only for illustration ("Illustrative demo", "Sample receipt", …) was replaced with copy for real data, and states the preview did not have (unavailable data, the code's limit, execution-trace steps) were written by the agent. The Korean column was an agent draft that never reached the screen (D-26); it was removed with D-27.

- `brand.tagline`: Interest becomes ownership
- `brand.home`: Yieldvest overview · `brand.built_on`: Built on
- `nav.overview`: Overview · `nav.earn`: Earn · `nav.invest`: Invest · `nav.activity`: Activity
- `nav.main`: Main navigation · `nav.mobile`: Mobile navigation
- `common.skip`: Skip to content
- `motion.pause`: Pause animations · `motion.play`: Play animations
- `motion.reduced`: Animations disabled by your system preference
- `toolbar.data`: Market data · {state}
- `overview.summary`: Account summary
- `overview.supplied`: USDT supplied · `overview.available`: Interest available · `overview.next`: Next purchase
- `overview.next.note`: Next check {time}
- `overview.status.waiting`: Waiting for interest · `overview.status.ready`: Buys at the next cycle
- `overview.flow.title`: See where your interest goes.
- `overview.flow.since`: Since {date}
- `overview.flow.note`: Only earned interest funds these purchases. Principal stays in the interest account.
- `overview.flow.first`: No purchase with interest yet. It buys once interest reaches {min} USDT.
- `overview.flow.aria`: {earned} USDT of interest: {spent} USDT bought {ticker}, {carried} USDT carried forward.
- `flow.earned`: Interest earned · `flow.reinvested`: Reinvested into {ticker} · `flow.carried`: Carried forward
- `progress.aria`: Progress toward the next purchase
- `progress.next`: Next cycle · {ticker}
- `progress.amount`: {available} of {min} USDT
- `progress.left`: {left} USDT to go · `progress.ready`: Ready for the next cycle
- `earn.title`: Small interest. Next investment.
- `earn.since`: Current cycle · since {time}
- `earn.status`: Accruing interest · `earn.threshold`: Purchase threshold
- `earn.chart.start`: Cycle start · `earn.chart.now`: Now
- `earn.chart.threshold`: {min} USDT · Buy threshold
- `earn.chart.aria`: Interest this cycle: {carried} USDT at the start, {available} USDT now, buy threshold {min} USDT
- `earn.legend.carried`: Carried forward · {value} USDT · `earn.legend.new`: New interest · {value} USDT
- `earn.panel.eyebrow`: Earning details
- `earn.panel.waiting`: Ready at {min}. · `earn.panel.ready`: Ready for the next cycle.
- `earn.panel.unavailable`: Not available right now
- `earn.protocol`: Protocol · `earn.asset`: Asset · `earn.apy`: Rate (APY) · `earn.score`: Security score
- `earn.new`: New interest · `earn.available`: Available
- `earn.note.left`: {left} USDT more to reach the purchase threshold.
- `earn.note.ready`: Interest has reached the purchase threshold. It buys at the next cycle.
- `earn.cta.activity`: View earning activity
- `invest.summary`: Investment summary
- `invest.title.contribution`: Choose your next investment. · `invest.title.interest`: Choose what your interest buys.
- `invest.sub`: Tokenized stocks on BNB Chain
- `invest.funding`: Funding · `invest.funding.contribution`: Contribution · `invest.funding.interest`: Earned interest
- `invest.target`: Target · `invest.min`: Minimum buy
- `invest.limit`: Code limit · `invest.limit.left`: Left on this code
- `invest.when`: When · {window}
- `invest.panel.eyebrow`: Plan preview · `invest.panel.title`: {funding} → {ticker}
- `invest.process`: Your steps
- `invest.review.title`: Review {ticker}.
- `invest.amount.error`: Enter {min}–{max} USDT, with up to two decimals.
- `invest.deposit.cta`: Put it in the interest account
- `stock.name.{nvda|tsla|msft|qqq|aapl}`: NVIDIA / Tesla / Microsoft / Nasdaq-100 ETF / Apple
- `activity.summary`: Activity summary
- `activity.title`: Every step, accounted for.
- `activity.sub`: Trace interest from earning to ownership.
- `activity.filter`: Filter activity · `activity.list`: Activity list
- `activity.col.event`: Event · `activity.col.amount`: Amount · `activity.col.status`: Status
- `activity.count`: Showing {shown} of {total}
- `activity.stat.purchases`: Purchases · `activity.stat.bought`: Total invested · `activity.stat.receipts`: Receipts on-chain
- `activity.stat.last`: Last purchase {time}
- `activity.status.recorded`: Recorded
- `activity.event.bought`: {ticker} purchased · `activity.event.simulated`: {ticker} dry run
- `activity.event.deferred`: {ticker} waiting · `activity.event.skipped`: {ticker} skipped
- `activity.event.failed`: {ticker} failed · `activity.event.running`: {ticker} in progress
- `receipt.latest`: Latest receipt · `receipt.eyebrow`: Receipt · `receipt.details.title`: Receipt details
- `receipt.inspect`: Inspect receipt · `receipt.inspect.record`: Inspect record · `receipt.eyebrow.record`: Record
- `receipt.none.title`: No purchase yet
- `receipt.none.note`: Receipts appear here once a plan buys on-chain.
- `receipt.plan`: Plan · `receipt.source`: Source · `receipt.source.interest`: Venus interest · `receipt.source.contribution`: Contribution
- `receipt.spent`: Invested · `receipt.amount`: Amount · `receipt.shares`: Shares received · `receipt.chain`: Chain
- `receipt.asset`: Purchased asset · `receipt.asset.value`: {ticker} · Tokenized stock
- `receipt.mode`: Execution · `receipt.interest_used`: Interest used · `receipt.contributed`: Contributed
- `receipt.doc.interest`: Interest invested. · `receipt.doc.contribution`: Contribution invested.
- `receipt.flow.aria`: {source} USDT bought {ticker}
- `receipt.disclaimer.onchain`: Recorded on-chain. Check it yourself with the receipt links.
- `receipt.disclaimer.none`: This cycle sent nothing to the chain.
- `receipt.back`: Back to activity
- `receipt.link.{approve|swap|deposit|redeem}`: Allowance receipt ↗ / Buy receipt ↗ / Deposit receipt ↗ / Withdrawal receipt ↗
- `trace.eyebrow`: Execution trace · `trace.title`: From interest to ownership.
- `trace.none`: No steps recorded.
- `trace.caption`: Started {start} · finished {end}
- `trace.caption.open`: Started {start} · still open
- `trace.inputs`: Read the market · `trace.inputs.body`: {n} venues checked · {mode}
- `trace.mode.live`: Live · `trace.mode.simulate`: Dry run only
- `trace.quote`: Quote · `trace.quote.body`: Quote for ${usd} · `trace.quote.error`: Quote refused ({code})
- `trace.requote`: New quote
- `trace.execute`: Decide to buy · `trace.execute.body`: Buy ${usd}
- `trace.reserve`: Reserve within the limits · `trace.reserve.refused`: Refused: over today's limit
- `trace.redeem`: Take out interest · `trace.redeem.body`: ${usd} taken out of the interest account
- `trace.approve`: Allow the exact amount · `trace.approve.existing`: Allowance already in place
- `trace.simulated`: Dry-run on-chain · `trace.bought`: Bought · recorded on-chain
- `trace.awaiting`: Waiting for the blockchain record · `trace.anomaly`: Needs review
- `trace.decided`: Decision
- `plan.summary`: Plan summary · `plan.contribution`: Per buy · `plan.limits.title`: Limits

### 7.7 Pre-flight, issuer comparison, interest calculator, MCP (DECISIONS D-31)
> Author: coding agent (10/1). Copy for the four features a person asked for on 10/1 (`/check`, `/compare`, the Earn calculator, the MCP block on `/skill`). Drafts until a person confirms them. Every number they show comes from the server with its data state; the calculator says on screen that it is a projection at today's rate.

- `invest.tools`: Before you buy · `invest.tools.check`: Would it buy right now? · `invest.tools.compare`: bStocks or Ondo?
- `check.title`: Would it buy right now?
- `check.sub`: The agent's own rules, run on its latest market data, for a plan you haven't made yet. Nothing is created or bought.
- `check.form.ticker`: Stock · `check.form.issuer`: Token · `check.form.issuer.both`: Both tokens · `check.form.usd`: Amount per buy (USDT) · `check.form.window`: When · `check.form.submit`: Check now
- `check.empty`: Pick a stock and an amount to see what the rules say right now.
- `check.verdict.buy`: Would buy about {shares} shares for ${usd} now.
- `check.verdict.wait`: Would wait.
- `check.verdict.skip`: Would skip this time.
- `check.verdict.failed`: Would stop: the quote failed.
- `check.retry`: Next try {time}
- `check.reason.data_stale`: The market data is older than 20 minutes, so it would wait for fresh numbers.
- `check.reason.data_unavailable`: There is no market data to decide with, so it would wait.
- `check.reason.guardian_unchecked`: The guardian hasn't checked in the last 15 minutes, so it would wait.
- `check.reason.other`: It would wait ({reason}).
- `check.rules.title`: Each rule, with what it read
- `check.col.rule`: Rule · `check.col.read`: What it read · `check.col.state`: Result
- `check.rule.data`: Market data · `check.rule.guardian`: Guardian · `check.rule.session`: US session · `check.rule.amount`: Amount vs minimum order · `check.rule.status`: Token status · `check.rule.gap`: Price vs US stock · `check.rule.impact`: Price impact
- `check.state.pass`: OK · `check.state.wait`: Waits · `check.state.block`: Stops · `check.state.unknown`: Unknown · `check.state.na`: Doesn't apply
- `check.read.data`: {age} min old · limit {limit} min
- `check.read.guardian.ok`: No rule open · checked {time}
- `check.read.guardian.open`: Open: {rules}
- `check.read.guardian.unchecked`: Not checked in the last 15 minutes
- `check.read.session`: {session} · this plan buys {window}
- `check.read.amount`: ${value} · minimum ${limit}
- `check.read.amount.half`: ${value} off-hours (half) · minimum ${limit}
- `check.read.status`: {code}
- `check.read.status.why`: {code} ({why})
- `check.read.gap`: {value}% · limit {limit}%
- `check.read.gap.off_hours`: Checked only in the regular session
- `check.read.gap.no_us_price`: No independent US price to compare with
- `check.read.impact`: {value}% · limit {limit}%
- `check.read.impact.code`: Quote refused ({code})
- `check.read.impact.unrecorded`: Quote not recorded ({code})
- `check.read.impact.halved`: {value}% · limit {limit}% · halved to ${usd}
- `check.read.none`: Not read
- `check.shared.title`: For every token
- `check.note`: The same engine as the agent (decideCycle) on the same data as its last market recording. A real plan decides again when it runs.
- `check.cta.compare`: Compare bStocks and Ondo
- `compare.title`: bStocks or Ondo?
- `compare.sub`: The same US stock from two issuers, side by side, from our last market recording.
- `compare.pick`: Stock
- `compare.col.size`: Order · `compare.col.shares`: Shares · `compare.col.per_share`: Per share · `compare.col.impact`: Price impact
- `compare.more`: More shares at ${size}: {issuer} ({pct}%)
- `compare.more.none`: No side-by-side quote at ${size}
- `compare.refused`: Refused ({code})
- `compare.status`: Status · `compare.price`: On-chain price per share · `compare.us`: US price · `compare.gap`: Gap · `compare.min`: Minimum order · `compare.min.none`: None
- `compare.address`: Contract · `compare.multiplier`: Shares per token: {m}
- `compare.one`: Only {issuer} sells {ticker}.
- `compare.note`: Facts, not a recommendation. Your assistant asks which token you want, and a plan never switches to the other one.
- `compare.cta.check`: Would it buy right now?
- `calc.title`: Interest calculator
- `calc.deposit`: If I put in (USDT)
- `calc.stock`: Priced in
- `calc.day`: Per day · `calc.week`: Per week · `calc.month`: Per month · `calc.year`: Per year
- `calc.first`: First buy (${min}) after about {days} days
- `calc.first.never`: At a 0% rate the interest never reaches ${min}.
- `calc.shares`: About {shares} {ticker} shares a month at today's price
- `calc.shares.none`: No share price to convert with right now.
- `calc.basis`: At today's rate ({apy}% APY, read {time}), held constant and compounded daily. The rate changes daily: this is a projection, not a promise.
- `calc.basis.stale`: At the last listed rate ({apy}% APY, read {time}), held constant and compounded daily. The rate changes daily: this is a projection, not a promise.
- `calc.unavailable`: The rate is unavailable, so there is nothing to project.
- `calc.amount.error`: Enter an amount above 0, with up to two decimals.
- `mcp.title`: Ask from any MCP client
- `mcp.body`: Yieldvest also answers as a read-only MCP server: market status, bStocks vs Ondo, the pre-flight check, the interest calculator, a wallet in shares, plan records and receipts. It can't create a plan or move funds.
- `mcp.install.label`: In Claude Code:
- `mcp.tools`: Tools: {tools}

### 7.8 My wallet (DECISIONS D-32)
> Author: coding agent (10/2). Copy for `/wallet`, a person's own wallet read on chain, a human asked for on 10/2. Drafts until a person confirms them. Every number comes from one block's chain reading or the worker's recorded price, each with its state.

- `wallet.title`: Your stocks, in shares
- `wallet.sub`: Paste a BNB Smart Chain address — your Binance Wallet's, or your Agentic Wallet's (baw wallet address). We only read the chain: nothing is signed, nothing is stored.
- `wallet.form.address`: Wallet address (BNB Smart Chain) · `wallet.form.submit`: Show my stocks
- `wallet.empty`: Enter an address to see the tokenized stocks it holds, counted in real shares.
- `wallet.error.address`: That is not a BNB Smart Chain address: 0x and 40 characters.
- `wallet.read`: Read on-chain at block {block} · {time}
- `wallet.col.stock`: Stock · `wallet.col.shares`: Shares · `wallet.col.value`: Value
- `wallet.pending`: Becomes {m} shares per token on {time} (a dividend or a split)
- `wallet.none`: No tokenized stock from Yieldvest's list in this wallet ({n} checked).
- `wallet.unread`: {n} tokens could not be read at this block.
- `wallet.summary`: Wallet summary · `wallet.summary.stocks`: Stocks held · `wallet.summary.value`: Value at the last price · `wallet.summary.usdt`: USDT in the wallet · `wallet.summary.venus`: In the interest account (Venus)
- `wallet.prices`: Values use the last recorded price:
- `wallet.note`: Shares = tokens × the token's multiplier: a bStocks token's is read on-chain at this block, an Ondo token's comes from Binance's list. Do your own research: this is a reading, not advice.
- `wallet.plans.title`: Yieldvest plans for this wallet · `wallet.plans.none`: No Yieldvest plan uses this wallet.
- `wallet.link`: See a wallet's stocks in shares

### 7.9 Agent identity (DECISIONS D-33)
> Author: coding agent (10/2). Two lines in the MCP block on `/skill`, for the ERC-8004 identity a human said yes to on 10/2: where the agent's registration file is, and — only once AGENT_ID is set after the registration — the agent's id on chain. Drafts until a person confirms them.

- `agent.card`: The agent's ERC-8004 registration file
- `agent.registered`: Registered on BNB Smart Chain as ERC-8004 agent #{id}

### 7.10 The Wallet API on receipts (DECISIONS D-34)
> Author: coding agent (10/3). One small line under a receipt link in the activity feed, once the worker has read the transaction's final status from the Binance Web3 Wallet API (transaction-detail-by-txhash) after its BSC receipt settled it. `{status}` is the API's own word (success or fail), quoted; `{fee}` is the fee it reports in BNB. The BSC receipt stays the record. Drafts until a person confirms them.

- `receipt.indexed.agrees`: Binance Web3 API confirms the same result
- `receipt.indexed.fee`: fee {fee} BNB
- `receipt.indexed.differs`: Binance Web3 API says "{status}" — the BSC receipt is the record

### 7.11 A cycle closed after review (PD-07)
> Author: coding agent (10/3). The reason line of a cycle an operator closed with `pnpm plan:status --close-review` after checking its transactions on BscScan (RUNBOOK §3.7): a swap that confirmed with no tokens arriving, or a cycle interrupted after signing with no recorded decision. Its receipts, shown with it, say what moved. Drafts until a person confirms them.

- `why.closed.review`: Held for review. A person checked its transactions on BscScan and closed it.

### 7.12 The first screen before the first receipt (DECISIONS D-34, PD-06)
> Author: coding agent (10/3). While no plan has bought on-chain yet, the Overview's receipt panel shows what the agent would do right now for Yieldvest's own fixed-amount plan, from the same check as "Would it buy right now?" (`/check`) on the latest market recording, with that recording's state. The verdict lines are §7.7's. Drafts until a person confirms them.

- `home.now.eyebrow`: The agent, right now
- `home.now.title`: Would it buy {ticker} now?
- `home.now.note`: Yieldvest's own plan, decided by the agent's rules on its latest market data. No purchase yet: receipts appear here once a plan buys on-chain.
- `home.now.rules`: See every rule it checked
