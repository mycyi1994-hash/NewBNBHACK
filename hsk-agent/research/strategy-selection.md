# Picking among ~30 backtested agents on ~3 years of data: what the evidence says

Researched 2026-11-28. This is research only; no code was written.

The context, as reported by the coordinator:
- Real fills cost about 0.5–1% per side, so a round trip costs about 1–2%.
- On BTC over 3 years, only three agents beat buy-and-hold (+58.8%): 12-month TSMOM (+130.6%, max drawdown 29%), dual momentum (+124%) and the 1/3/12-month blend.
- All 1h and 4h agents lost 30–98%.
- The current picker ranks agents on one "ranking year" with a ≥25% exposure guard, plus a 3-month holdout. It chose agents that lost over the full 3 years.

**How sources were read.** I opened every URL below. Where I read only an abstract or a landing page, I say so. Numbers attributed to a paper come from the text I opened. Arithmetic marked "computed" is my own, from the paper's formula.

---

## 1. Ranking without overfitting

### 1.1 How big the problem is, in numbers

**Minimum backtest length (MinBTL).** Bailey, Borwein, López de Prado & Zhu, "Pseudo-Mathematics and Financial Charlatanism", *Notices of the AMS* 61(5) (2014). Preprint: https://carmamaths.org/jon/backtest.pdf
- Among N independent strategies with zero true skill, the expected best in-sample Sharpe ratio (annualised, over a backtest of y years) is roughly bounded by √(2 ln N / y).
- Rearranged, this gives the paper's bound: MinBTL < 2 ln N / E[max]².
- The paper's own examples: "After trying only 7 independent strategy configurations, the expected maximum SR IS is 1 for a 2-year long backtest, while the expected SR OOS is 0." With 5 years of data, try no more than 45 configurations.
- Applied to Moa (computed; N = 30, and our trials are correlated, so this is an upper bound):

| Window used for ranking | Best Sharpe expected from luck alone, N = 30 |
|---|---|
| 1 year (current picker) | up to √(2·ln30/1) ≈ **2.6** |
| 3 years (full sample) | up to √(2·ln30/3) ≈ **1.5** |

- **So the current "ranking year" picker can be fooled by Sharpe ratios as high as about 2.6 that are pure noise.** That alone explains why it chose agents that lost over the full 3 years.

**Sharpe-ratio standard error.** Lo, "The Statistics of Sharpe Ratios", *Financial Analysts Journal* 58(4) (2002). https://traders.studentorg.berkeley.edu/papers/The-Statistics-of-Sharpe-Ratios.pdf
- For IID returns, the asymptotic variance of the estimated Sharpe ratio is (1 + ½SR²)/T.
- With T in years and SR ≈ 1, three years gives a standard error of √(1.5/3) ≈ **0.7** (computed). A 95% band is about ±1.4.
- Two agents whose 3-year Sharpe ratios differ by less than about 1 are statistically indistinguishable.

**Haircut Sharpe ratio.** Harvey & Liu, "Backtesting", *JPM* (2015). https://people.duke.edu/~charvey/Research/Published_Papers/P120_Backtesting.PDF
- The haircut for multiple testing is nonlinear. It is "almost always more than and sometimes much larger than 50%" when the annualised Sharpe is below 0.4, and at most 25% when the Sharpe is above 1.0.
- Marginal winners are probably false discoveries.

### 1.2 The tools, and which fit Moa

**Probability of backtest overfitting (PBO) via CSCV.**
- Source: Bailey, Borwein, López de Prado & Zhu, "The Probability of Backtest Overfitting", *Journal of Computational Finance* 20(4) (2017). Preprint: https://carmamaths.org/jon/backtest2.pdf
- How it works:
  - Split the T × N matrix of strategy returns into S equal blocks.
  - For every way of choosing half the blocks as "in-sample" (IS), pick the IS best and record its rank in the other half (OOS).
  - PBO is the share of splits where the IS best ranks below the OOS median.
- The paper argues that standard hold-out "tends to be unreliable and inaccurate" for investment backtests.
- **Fits Moa:** use 36 monthly returns × 30 agents, S = 6 blocks of 6 months, giving C(6,3) = 20 splits. This is cheap and deterministic.
- **Reading the result:** PBO ≥ 0.5 means picking the backtest winner is no better than picking at random.

**Deflated Sharpe ratio (DSR).**
- Source: Bailey & López de Prado, "The Deflated Sharpe Ratio", *JPM* 40(5) (2014). https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf
- How it works: DSR is the probability that the true Sharpe is above the *expected maximum* Sharpe of the N trials. That threshold depends on N, the variance of the trial Sharpe ratios, the sample length, and the skewness and kurtosis of returns.
- The paper stresses that "the number of trials attempted" must be reported.
- **Fits Moa:** yes. Its simplest form is "subtract the luck threshold from 1.1".

**White's Reality Check and Hansen's SPA test.**
- Sources:
  - White, "A Reality Check for Data Snooping", *Econometrica* 68(5) (2000). https://users.ssc.wisc.edu/~bhansen/718/White2000.pdf . It tests "the null hypothesis that the best model encountered in a specification search has no predictive superiority over a given benchmark."
  - Hansen, "A Test for Superior Predictive Ability", *JBES* 23 (2005). https://ideas.repec.org/a/bes/jnlbes/v23y2005p365-380.html (landing page only). Hansen's working paper says the procedure "dominates the 'reality check' of White (2000)": https://economics.brown.edu/sites/g/files/dprerj726/files/papers/2003-9_paper.pdf
  - Applied to technical trading rules: Sullivan, Timmermann & White, *JF* 54(5) (1999). https://ideas.repec.org/a/bla/jfinan/v54y1999i5p1647-1691.html (abstract only).
- **Fits Moa:** possible as a gate ("does the best agent beat holding?"). With 3 years of data its power is very low, so expect it to almost always say "not proven". That is an honest answer, and it does not produce a ranking.

**What happens to "best rules" out of sample.**
- Source: Bajgrowicz & Scaillet, "Technical trading revisited", *JFE* 106(3) (2012). https://econpapers.repec.org/RePEc:eee:jfinec:v:106:y:2012:i:3:p:473-491 (abstract)
- On the DJIA from 1897 to 2011, an investor "could not have reliably picked the best-performing rules in advance". Modest transaction costs eliminated even the in-sample performance.

**Walk-forward testing.**
- With 3 years of daily data and a 12-month warm-up, walk-forward leaves only about 2 out-of-sample years.
- It is a single path, and Bailey et al. note that it inherits the same selection problem.
- Use it as a sanity check, never as the selector.

**Combining instead of picking.**
- DeMiguel, Garlappi & Uppal, "Optimal Versus Naive Diversification", *RFS* 22(5) (2009). https://ideas.repec.org/a/oup/rfinst/v22y2009i5p1915-1953.html (abstract)
  - None of 14 optimised models consistently beat 1/N on Sharpe, certainty equivalent or turnover. "The gain from optimal diversification is more than offset by estimation error."
  - Beating 1/N needs an estimation window of about 3,000 months for 25 assets.
- Rapach, Strauss & Zhou, *RFS* 23(2) (2010). https://ideas.repec.org/a/oup/rfinst/v23y2010i2p821-862.html (abstract)
  - Individual predictors fail out of sample because of model uncertainty and instability.
  - Equal-weight *combination* forecasts give "statistically and economically significant out-of-sample gains".
- Neely, Rapach, Tu & Zhou, *Management Science* 60(7) (2014). https://econpapers.repec.org/RePEc:inm:ormnsc:v:60:y:2014:i:7:p:1772-1791 (abstract)
  - Technical indicators forecast the equity premium out of sample.
  - Combining sources of information beats using either one alone.

**Shrinkage toward a prior.**
- Jorion, "Bayes-Stein Estimation for Portfolio Analysis", *JFQA* 21(3) (1986). https://ideas.repec.org/a/cup/jfinqa/v21y1986i03p279-292_01.html (abstract)
  - The sample mean is inadmissible.
  - Shrinking estimated means toward a common target gives "significant gains".
- **For Moa:** shrink each agent's measured edge over holding toward zero (the prior that an agent equals holding), with the weight set by noise. Harvey & Liu's haircut is a practical version of this.

### 1.3 A concrete ranking rule for Moa

1. **Score only on the full window, net of real fills.** Use every year, never one "ranking year". The score is net excess return over the coin's buy-and-hold, plus max drawdown.
2. **Luck hurdle (a simplified deflated Sharpe).** An agent may be called "better than holding" only if:
   - Sharpe(agent − hold) exceeds √(2 ln N / years), which is about 1.5 for N = 30 and 3 years; **and**
   - it beat holding in at least 2 of the 3 calendar-like 12-month blocks.
3. **Overfitting check (CSCV PBO, S = 6).** Compute it over all agents per coin.
   - If PBO ≥ 0.5, do not show a "best agent" badge at all; show the default basket.
   - Otherwise, show at most the top tier as a group, never a single winner.
4. **Display ranking in tiers, not ranks.** The tiers are "beat holding", "about the same" (within one standard error) and "worse". Order agents within a tier by worst drawdown, not by return.
5. **Pre-registered default beats data-mined winner.** If nothing clears steps 2–3, the default is the evidence-based basket in §2. It was chosen from the literature before looking at Moa's backtest.

**Beginner sentence:** "With only 3 years of history we can't reliably pick a winner, so we start you on a mix that has worked in decades of research and held up in every year we tested, after all fees."

## 2. One "best" agent, or a default basket?

**Evidence for a basket:**
- Picking the backtest winner among technical rules does not persist (Bajgrowicz & Scaillet 2012).
- Equal-weight combinations beat selected models (DeMiguel et al. 2009; Rapach et al. 2010; Neely et al. 2014).
- For trend specifically:
  - Hurst, Ooi & Pedersen, *JPM* (2017), https://fairmodel.econ.yale.edu/ec439/hurst.pdf , use an *equal-weighted* 1/3/12-month blend. Every horizon was positive in every decade from 1880 to 2016.
  - Zarattini, Pagani & Barbon (2025) aggregate Donchian lookbacks precisely because aggregation "reduces sensitivity to any single parameter choice" (see the earlier report: https://concretumgroup.com/catching-crypto-trends-a-tactical-approach-for-bitcoin-and-altcoins/).
- **For BTC:** Hudson & Urquhart, *Annals of OR* 297 (2021), https://ideas.repec.org/a/spr/annopr/v297y2021i1d10.1007_s10479-019-03357-1.html , found that technical rules had "no out-of-sample predictability for Bitcoin", while predictability remained in the other coins tested. A single BTC rule is exactly the fragile case.

**Recommendation:**
- Recommend a **default basket**: a core holding plus a slow trend overlay. Do not recommend a single best agent.
- Present individual agents as alternatives, using the tier labels from §1.3.

## 3. 12-month TSMOM under high costs

**Why slow wins when costs are high:**
- Novy-Marx & Velikov, "A Taxonomy of Anomalies and Their Trading Costs", *RFS* 29(1) (2016). https://www.nber.org/papers/w20721
  - Strategies with under 50% monthly one-sided turnover generally survive costs; few high-turnover strategies do.
  - The most effective simple fix is a **buy/hold spread**, a no-trade band: stricter rules for entering a position than for keeping it.
- Gârleanu & Pedersen, "Dynamic Trading with Predictable Returns and Transaction Costs", *JF* 68(6) (2013). https://www.nber.org/papers/w15205
  - With costs, "aim in front of the target and trade partially towards the current aim".
  - Signals that decay more slowly get more weight in the aim.
- Man Group, "The Need for Speed in Trend-Following Strategies" (data 1995–2022). https://www.man.com/insights/need-for-speed-trend-following
  - Gross risk-adjusted returns rise as speed slows.
  - After costs, risk-adjusted returns are "materially lower for faster speeds".
  - Fast systems keep better skew and crisis performance, but "efficient execution is the gatekeeper to being able to trade fast".
- Hurst et al. (2017): when signals are lagged by a month, performance "deteriorates ... especially for the shorter-term signals". Slow signals are robust to execution delay.
- BTC break-even costs (Detzel et al., via CXO, https://www.cxoadvisory.com/currency-trading/timing-bitcoin-with-smas/ ): the switching cost that erases the edge is **1.1% for a 5-day SMA and 4.5% for a 100-day SMA**. At Moa's 1–2% round trip, only rules of 50–100 days or slower can plausibly survive. That matches the coordinator's results.

**Caveat on the +130.6%.**
- 12-month TSMOM over 3 years with a 12-month warm-up is driven by a handful of switches. It is effectively one or two regime calls.
- Under §1.1 its excess Sharpe is not distinguishable from luck.
- Prefer it because the prior is strong (Moskowitz–Ooi–Pedersen: https://econpapers.repec.org/RePEc:eee:jfinec:v:104:y:2012:i:2:p:228-250 ; Hurst et al. 2017), **not** because it won Moa's backtest.

**Horizons and rebalancing at 1–2% round-trip cost:**
- **Horizons:**
  - Use a blend of 3-, 6- and 12-month signs, or 1/3/12 if its measured turnover is acceptable. The 1-month leg carries most of the turnover.
  - Avoid anything under about 2 months.
  - The 1–4 week crypto momentum that Liu & Tsyvinski document is real in returns but too fast for these costs.
- **Check frequency:** monthly, as in MOP and Hurst. Weekly checks add trades without adding evidence.
- **No-trade band:** move toward the target only when it differs from the current weight by at least 25–33 percentage points. With three signals, this means trading on full signal flips rather than every wobble. When you do trade, go part of the way (Gârleanu–Pedersen), e.g. halfway.
- **Volatility targeting:** if kept, use it only with a wide band. It trailed holding after costs, consistent with Harvey et al. finding modest effects and Cederburg et al. finding weak out-of-sample results (cited in the earlier report).

## 4. Short-term trading at a 1–2% round trip

**Answer: I found no evidenced long-only intraday or short-horizon rule that survives a 1–2% round trip.**
- Low costs alone wiped out technical-rule profits on a century of DJIA data (Bajgrowicz & Scaillet 2012).
- The only crypto intraday seasonality study, the 21:00–23:00 UTC hold, is gross and in-sample, and one round trip a day would cost it about 1–2% a day.
- The hourly multi-timeframe MACD makes about 1,000 to 2,000 trades in 7 years, with no costs modelled.
- After overreaction days in crypto, the reversal strategy was not profitable and the momentum strategy was not distinguishable from random (Caporale & Plastun, *JES* 2019: https://econpapers.repec.org/RePEc:eme:jespps:jes-09-2018-0310 ). That rules out "event-driven entries on large moves" as an evidenced edge.
- Moa's own result (−30% to −98%) is what this literature predicts.

**Honest alternatives for users who want "active" agents:**
1. **Slow agents with visible activity.** Monthly checks, a wide no-trade band and partial trades. Show "checked today, no trade needed (saves fees)" as an activity event.
2. **Limit-style entries using LP blocks (range orders).**
   - Uniswap documents that a single-sided position "approximate[s] a limit order", and that it *earns* fees rather than paying them: https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/range-orders
   - Caveats from the same page:
     - It must be withdrawn after the price crosses; it does not settle automatically.
     - If price crosses and comes back before withdrawal, it "reverts", so the order stays unfilled.
     - Only take-profit and buy-limit orders are possible, not stop orders.
   - Caveats from the literature:
     - LPs bear an adverse-selection cost, "loss-versus-rebalancing", where "stale prices are exploited by better-informed arbitrageurs" (Milionis, Moallemi, Roughgarden & Zhang, arXiv 2208.06046: https://arxiv.org/abs/2208.06046v5 ).
     - In Uniswap v3 (May–Sep 2021), LPs earned $199.3m in fees but suffered $260.1m of impermanent loss; 49.5% of LPs had negative returns (Loesch et al., arXiv 2111.09192: https://arxiv.org/abs/2111.09192v1 ).
     - Heimbach, Schertenleib & Wattenhofer conclude that v3 LP suits "sophisticated players rather than retail" and that simple strategies earn modest returns, mainly in low-volatility pools (arXiv 2205.08904: https://arxiv.org/abs/2205.08904 ).
   - **Net:** range-order entries cut the *explicit* fee and can earn the fee, but a buy-limit fills exactly when price is falling through it, which is adverse selection. I found no published study showing range-order *trading strategies* beat market orders for a long-only investor. Present them as "cheaper execution for a slow signal", not as a strategy.
3. **Event-only entries** (e.g. "add when the price falls X% below the 200-day average"). There is no positive evidence, so offer them only as a DCA variant with explicit "no proven edge" copy.
4. **Short-term agents as "lab / education" mode.** Show them with full net-of-cost results and a warning. Never auto-recommend them or put them in the default.

## 5. Presenting performance honestly to retail users

**Regulatory baselines** (both apply to regulated firms, not to Moa, but they describe good practice):
- **EU MiFID II, Delegated Regulation 2017/565, Art. 44(4)–(6)** (UK FCA COBS 4.6 mirrors it). https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0565
  - Past performance must be "not the most prominent feature".
  - It must cover the preceding 5 years (or the whole period if shorter), and "in every case ... based on complete 12-month periods".
  - The reference period and source must be stated.
  - It needs a prominent warning that "past performance is not a reliable indicator of future results".
  - Gross figures must disclose the effect of fees.
  - **Simulated** past performance needs its own prominent warning.
  - Future-performance claims need both negative and positive scenarios.
- **US SEC Marketing Rule 206(4)-1.**
  - Net performance must be shown with at least equal prominence to gross, over 1-, 5- and 10-year periods (or the portfolio's life if shorter).
  - Hypothetical (including backtested) performance is allowed only with policies ensuring it is relevant to the audience, plus disclosure of the criteria, assumptions, risks and limitations.
  - Sources: https://www.sec.gov/investment/marketing-faq and https://www.troutman.com/insights/the-secs-new-marketing-rule-practically-speaking-performance-advertisingtrack-records/

**Behavioural evidence:**
- Sirri & Tufano, *JF* 53(5) (1998): consumers "chase returns, flocking to funds with the highest recent returns" and fail to flee poor performers. https://faculty.babson.edu/wp-content/uploads/2024/01/mutual-funds-JF-october-1998.pdf
- Koehler & Mercer, *Management Science* 55(7) (2009), on "selection neglect". https://ideas.repec.org/a/inm/ormnsc/v55y2009i7p1107-1121.html
  - Advertised funds sat at the 79th–100th percentile.
  - Novices *and professionals* treated those figures as representative.
  - A simple cue about the sample space ("selected from N") reduced the bias.
  - This applies directly to "best of 30 agents".
- Benartzi & Thaler, *Management Science* 45(3) (1999): people take more risk when shown long-horizon rather than one-year returns. Horizon framing changes behaviour, so show both the long view and the worst drop. https://econpapers.repec.org/RePEc:inm:ormnsc:v:45:y:1999:i:3:p:364-381

**What number should lead:**
- **Lead with net 3-year result vs simply holding the same coin, side by side with the worst drop.** Example: "Simulated, after all fees: +72 pts vs holding BTC · worst drop −29% (holding: −X%)".
- Then show each complete 12-month block, from a fixed calendar start, not a chosen one.
- Always add:
  - "simulated, not achieved";
  - "best of N tested" when anything is ranked;
  - the cost assumption (real pool fills);
  - the warning that past performance is not a reliable indicator.
- Never lead with the best single period, a percentage over a cherry-picked window, or gross return.

---

## 6. Concrete proposal

**Ranking rule (replaces "ranking year + 3-month holdout"):**
1. Score each agent on the full 3 years, net of real pool fills, as excess over buy-and-hold of the same coin, alongside max drawdown.
2. Award the "beats holding" tier only if the agent:
   - (a) clears the luck hurdle Sharpe(excess) > √(2 ln N / years), about 1.5 for N = 30 and 3 years; **and**
   - (b) beat holding in at least 2 of 3 twelve-month blocks.
3. Compute CSCV PBO (36 monthly returns, S = 6, 20 splits) per coin. If PBO ≥ 0.5, show no "best" badge.
4. Show tiers ("beat holding", "about the same", "worse"), never a single number-one. Within a tier, order by smaller drawdown.
5. Keep the ≥25% exposure guard. Drop the 3-month holdout as a selector (too short, single path); show it as "latest 3 months" information only.

**Default per coin (pre-registered from the literature, not from Moa's backtest):**
- **BTC:** 50% buy-and-hold core plus 50% slow trend sleeve. The sleeve is the 3/6/12-month (or 1/3/12) TSMOM blend: checked monthly, with a no-trade band of ≥25 percentage points and partial moves.
- **ETH:** the same structure. Hudson & Urquhart found out-of-sample predictability remained outside BTC, but there is no ETH-specific Moa evidence, so do not tune it.
- **HSK:** DCA or a small hold only; no active default. There is no published evidence, history is short, and the pool's costs and impact are the highest. Allow an opt-in slow trend sleeve only once ≥ 12 months of daily data exist.

**Short-term agents (1h/4h RSI(2), EMA 9/21, MACD, Bollinger, 20-bar breakout):**
- Remove them from recommendations and defaults.
- Keep them only in a labelled "lab / learn" section, with net-of-cost results and a warning.
- Optionally offer LP-block range-order *execution* for slow signals' entries and take-profits. Disclose the reversal and adverse-selection risks, and do not market it as an edge.

**Promote:**
- 12-month TSMOM;
- the 1/3/12 (or 3/6/12) blend;
- dual momentum, as a BTC/ETH/USDT rotation, monthly;
- the core-plus-trend basket, as the default.

**Keep but demote** to a "calmer, not better" label: vol-target, MA ensemble, Donchian ensemble.

**Retire from active recommendation:**
- 7/28/91-day momentum, which is too fast for 1–2% costs;
- every 1h and 4h agent;
- any rule with roughly 12 or more round trips a year at current costs, unless it clears the luck hurdle.
