# Ranking-rule experiment (walk-forward, research only)

Each rule picks with data before a cut date; the score is the next 90 days. Monthly cut dates. "vs hold" = pick return minus holding the coin. Costs are in the curves.

## BTC

29 daily agents, history 2023-11-29 → 2026-11-28, 22 cut dates.

| Rule | next-90d vs hold (avg, pts) | next-90d return (avg) | beat hold in | worst 90d vs hold | picks (most frequent) |
|---|---|---|---|---|---|
| now: beat hold over last year (≥25% in coin), then smallest drop | +0.9 | -1.2% | 15/22 | -24.2 | tsmom×10, donchEns×9, volTarget×1 |
| A: best vs hold over all history so far | +1.5 | -0.6% | 16/22 | -28.3 | tsmom×22 |
| B: best vs hold over last year | -0.5 | -2.5% | 14/22 | -25.9 | tsmom×10, multiTrend×9, turtle2C×2 |
| C: beat hold over all history AND last year, then best all-history | +1.5 | -0.6% | 16/22 | -28.3 | tsmom×22 |
| D: beat hold over all history, then smallest drop | +0.3 | -1.7% | 13/22 | -28.3 | donchEns×13, tsmom×9 |
| E: best absolute return over all history | +1.5 | -0.6% | 16/22 | -28.3 | tsmom×22 |
| F: best return ÷ worst drop over all history | -2.1 | -4.1% | 13/22 | -28.3 | tsmom×14, turtle2C×8 |
| G: basket of every agent, equal parts | -1.3 | -3.3% | 12/22 | -20.1 | basket of 29 |
| H: basket of agents that beat hold over all history | -0.2 | -2.2% | 12/22 | -23.3 | tsmom×2 |
| I: basket of the 3 best vs hold over all history | +0.7 | -1.3% | 13/22 | -23.3 | basket of 3 |
| fixed: 12-month momentum (tsmom) | +1.5 | -0.6% | 16/22 | -28.3 | tsmom×22 |
| fixed: dual momentum | +1.2 | -0.9% | 14/22 | -28.3 | dualMom×22 |
| fixed: 1/3/12-month trend blend (multiTrend) | +2.3 | +0.3% | 13/22 | -25.9 | multiTrend×22 |
| fixed: volatility-targeted holding | -0.1 | -2.2% | 12/22 | -4.1 | volTarget×22 |
| fixed: the default basket (Moa's default) | +0.7 | -1.3% | 14/22 | -13.1 | basket×22 |

### BTC: every agent (full window, costs included)

| Agent | group | total | vs hold | worst drop | entries | in coin | ranking year vs hold | last 3 months vs hold | working now |
|---|---|---|---|---|---|---|---|---|---|
| tsmom | main | +130.6% | +73.7 | −29.2% | 2 | 66% | +9.2 | +24.1 | 318d ago |
| dualMom | main | +124.2% | +67.3 | −30.5% | 3 | 66% | +6.9 | +24.1 | 375d ago |
| multiTrend | main | +65.8% | +8.9 | −47.1% | 19 | 60% | +17.9 | +30.3 | 39d ago |
| basket | main | +57.0% | +0.1 | −43.5% | 1 | 100% | +8.1 | +3.8 | holding |
| volTarget | main | +52.2% | -4.7 | −49.8% | 1 | 100% | +0.8 | +3.2 | holding |
| turtle2C | main | +45.9% | -11.0 | −35.1% | 10 | 28% | +24.6 | +11.9 | 43d ago |
| ema | main | +36.9% | -20.0 | −44.3% | 10 | 57% | +1.9 | +21.2 | 27d ago |
| donchianC | main | +34.0% | -22.9 | −45.6% | 15 | 41% | +13.1 | +12.0 | 43d ago |
| breakC | main | +33.3% | -23.5 | −39.5% | 17 | 41% | +20.5 | +12.3 | 52d ago |
| ichimoku | classic (folded) | +30.7% | -26.2 | −48.1% | 25 | 48% | +32.5 | +27.0 | 38d ago |
| keltner | classic (folded) | +29.0% | -27.9 | −30.8% | 13 | 27% | +19.2 | +15.1 | 53d ago |
| trend200 | classic (folded) | +28.1% | -28.8 | −38.5% | 15 | 62% | +23.9 | +14.3 | 17d ago |
| coreTrend | main | +20.7% | -36.2 | −46.8% | 1 | 100% | +1.9 | +6.0 | holding |
| trend | main | +19.3% | -37.6 | −46.2% | 35 | 56% | +7.5 | +27.0 | 38d ago |
| brkAtr | main | +15.6% | -41.3 | −43.9% | 19 | 50% | +19.7 | +12.1 | 43d ago |
| donchEns | main | +13.9% | -43.0 | −21.7% | 15 | 73% | +17.4 | +20.1 | 17d ago |
| break | classic (folded) | +13.8% | -43.1 | −45.4% | 17 | 48% | +11.4 | +12.4 | 52d ago |
| turtle2 | classic (folded) | +7.6% | -49.3 | −41.4% | 10 | 41% | +23.1 | +8.3 | 31d ago |
| golden | classic (folded) | +7.3% | -49.6 | −55.0% | 4 | 62% | +13.7 | -1.1 | holding |
| maEns | main | +4.6% | -52.3 | −44.9% | 38 | 71% | +9.0 | +19.9 | 24d ago |
| adx | classic (folded) | +3.3% | -53.6 | −44.8% | 14 | 25% | -6.8 | +28.1 | 45d ago |
| tsmom3 | main | -6.7% | -63.6 | −42.2% | 18 | 81% | +2.9 | +12.2 | 6d ago |
| ma520 | main | -7.3% | -64.2 | −49.5% | 31 | 52% | +1.2 | +20.7 | 51d ago |
| donchian | classic (folded) | -8.9% | -65.8 | −52.1% | 15 | 62% | +14.1 | +8.4 | 31d ago |
| aroon | classic (folded) | -16.1% | -73.0 | −45.7% | 24 | 51% | +8.1 | +13.8 | 45d ago |
| rsi | main | -19.7% | -76.6 | −37.8% | 7 | 21% | +10.7 | +6.4 | holding |
| cryptoMom | main | -35.3% | -92.2 | −63.6% | 52 | 56% | +0.8 | +27.8 | 41d ago |
| triple | main | -40.7% | -97.6 | −56.6% | 47 | 37% | -8.7 | +8.2 | 52d ago |
| psar | classic (folded) | -49.2% | -106.1 | −61.2% | 45 | 53% | +5.5 | +7.1 | holding |

## ETH

29 daily agents, history 2023-11-29 → 2026-11-28, 22 cut dates.

| Rule | next-90d vs hold (avg, pts) | next-90d return (avg) | beat hold in | worst 90d vs hold | picks (most frequent) |
|---|---|---|---|---|---|
| now: beat hold over last year (≥25% in coin), then smallest drop | -2.5 | -0.9% | 12/22 | -94.1 | donchEns×12, turtle2×6, turtle2C×2 |
| A: best vs hold over all history so far | +0.1 | +1.7% | 14/22 | -81.8 | turtle2×19, tsmom×2, donchian×1 |
| B: best vs hold over last year | -0.9 | +0.7% | 14/22 | -73.8 | donchian×6, trend×5, tsmom×2 |
| C: beat hold over all history AND last year, then best all-history | +0.1 | +1.7% | 14/22 | -81.8 | turtle2×19, tsmom×2, donchian×1 |
| D: beat hold over all history, then smallest drop | +0.4 | +2.1% | 14/22 | -69.2 | turtle2×8, turtle2C×5, dualMom×4 |
| E: best absolute return over all history | +0.1 | +1.7% | 14/22 | -81.8 | turtle2×19, tsmom×2, donchian×1 |
| F: best return ÷ worst drop over all history | +1.1 | +2.7% | 14/22 | -81.8 | turtle2×20, trend200×2 |
| G: basket of every agent, equal parts | -1.0 | +0.6% | 13/22 | -67.4 | basket of 29 |
| H: basket of agents that beat hold over all history | +1.0 | +2.6% | 13/22 | -73.8 | turtle2×1 |
| I: basket of the 3 best vs hold over all history | +0.5 | +2.1% | 14/22 | -76.6 | basket of 3 |
| fixed: 12-month momentum (tsmom) | -5.7 | -4.0% | 13/22 | -103.8 | tsmom×22 |
| fixed: dual momentum | -1.6 | -0.0% | 13/22 | -108.8 | dualMom×22 |
| fixed: 1/3/12-month trend blend (multiTrend) | +0.6 | +2.2% | 12/22 | -71.9 | multiTrend×22 |
| fixed: volatility-targeted holding | -2.6 | -1.0% | 11/22 | -49.5 | volTarget×22 |
| fixed: the default basket (Moa's default) | -3.9 | -2.3% | 10/22 | -61.9 | basket×22 |

### ETH: every agent (full window, costs included)

| Agent | group | total | vs hold | worst drop | entries | in coin | ranking year vs hold | last 3 months vs hold | working now |
|---|---|---|---|---|---|---|---|---|---|
| donchian | classic (folded) | +96.6% | +115.6 | −49.2% | 9 | 51% | +38.8 | +23.7 | 31d ago |
| trend | main | +91.5% | +110.6 | −51.2% | 23 | 49% | +47.1 | +32.5 | 52d ago |
| turtle2 | classic (folded) | +90.6% | +109.6 | −30.7% | 7 | 36% | +33.3 | +23.8 | 31d ago |
| ema | main | +60.5% | +79.5 | −51.0% | 9 | 50% | +32.7 | +28.0 | 36d ago |
| adx | classic (folded) | +26.7% | +45.8 | −46.4% | 16 | 33% | +34.0 | +41.1 | 67d ago |
| trend200 | classic (folded) | +21.0% | +40.0 | −47.4% | 11 | 49% | +12.0 | +18.5 | 21d ago |
| turtle2C | main | +20.7% | +39.8 | −22.6% | 6 | 17% | +38.7 | +29.6 | 75d ago |
| multiTrend | main | +14.8% | +33.9 | −56.8% | 22 | 55% | +29.4 | +20.3 | 43d ago |
| ichimoku | classic (folded) | +13.6% | +32.6 | −43.9% | 22 | 42% | +28.0 | +18.3 | 24d ago |
| donchEns | main | +13.4% | +32.4 | −17.5% | 10 | 71% | +37.3 | +27.2 | holding |
| tsmom | main | +10.3% | +29.3 | −52.1% | 6 | 57% | +18.9 | +33.1 | 204d ago |
| maEns | main | +7.7% | +26.7 | −54.3% | 35 | 67% | +26.6 | +20.8 | 24d ago |
| keltner | classic (folded) | +7.2% | +26.3 | −34.2% | 13 | 23% | +32.8 | +20.7 | 53d ago |
| aroon | classic (folded) | +1.9% | +21.0 | −57.0% | 23 | 47% | +10.3 | +39.1 | 41d ago |
| dualMom | main | -0.8% | +18.2 | −17.2% | 5 | 6% | +42.9 | +33.1 | 204d ago |
| coreTrend | main | -1.6% | +17.4 | −49.3% | 1 | 100% | +14.6 | +9.5 | holding |
| tsmom3 | main | -4.3% | +14.8 | −55.1% | 19 | 77% | +17.9 | +21.2 | 13d ago |
| volTarget | main | -16.5% | +2.6 | −61.6% | 1 | 100% | +4.5 | +2.9 | holding |
| brkAtr | main | -16.7% | +2.4 | −62.4% | 22 | 47% | +29.5 | +22.7 | 52d ago |
| basket | main | -16.9% | +2.1 | −59.8% | 1 | 100% | +4.3 | +10.1 | holding |
| donchianC | main | -23.3% | -4.2 | −41.2% | 8 | 17% | +32.8 | +29.7 | 75d ago |
| cryptoMom | main | -24.8% | -5.7 | −56.2% | 46 | 49% | +3.7 | +23.8 | 45d ago |
| breakC | main | -41.0% | -22.0 | −61.0% | 17 | 27% | +5.6 | +21.0 | 53d ago |
| golden | classic (folded) | -41.1% | -22.1 | −70.7% | 4 | 53% | +11.6 | -0.9 | holding |
| break | classic (folded) | -41.9% | -22.9 | −65.6% | 18 | 36% | +2.7 | +21.0 | 53d ago |
| ma520 | main | -44.4% | -25.3 | −69.1% | 34 | 47% | +2.1 | +28.5 | 53d ago |
| rsi | main | -48.1% | -29.0 | −55.9% | 7 | 22% | +23.4 | +12.4 | holding |
| triple | main | -69.5% | -50.5 | −79.3% | 50 | 32% | +1.3 | +19.0 | 54d ago |
| psar | classic (folded) | -77.8% | -58.8 | −83.9% | 47 | 49% | +15.3 | +8.8 | holding |

## HSK

32 daily agents, history 2025-11-26 → 2026-11-28, 0 cut dates.

| Rule | next-90d vs hold (avg, pts) | next-90d return (avg) | beat hold in | worst 90d vs hold | picks (most frequent) |
|---|---|---|---|---|---|

### HSK: every agent (full window, costs included)

| Agent | group | total | vs hold | worst drop | entries | in coin | ranking year vs hold | last 3 months vs hold | working now |
|---|---|---|---|---|---|---|---|---|---|
| turtle2C | main | +39.3% | +133.5 | −19.8% | 2 | 1% | +31.5 | +19.6 | 99d ago |
| ichimoku | classic (folded) | +19.3% | +108.1 | −29.5% | 4 | 11% | +46.7 | +18.1 | 74d ago |
| breakC | main | +12.4% | +106.6 | −47.1% | 5 | 4% | +27.6 | +19.6 | 100d ago |
| turtle2 | classic (folded) | +10.7% | +104.9 | −37.1% | 2 | 8% | +23.0 | +19.6 | 75d ago |
| donchianC | main | -4.2% | +90.0 | −47.1% | 4 | 6% | +13.9 | +19.6 | 114d ago |
| ma520 | main | -4.8% | +89.4 | −58.5% | 14 | 25% | +17.8 | +15.1 | 53d ago |
| keltner | classic (folded) | -7.7% | +86.5 | −47.6% | 4 | 7% | +16.8 | +19.6 | 80d ago |
| aroon | classic (folded) | -17.4% | +76.8 | −60.8% | 9 | 26% | +27.5 | +19.6 | 75d ago |
| rsi2 | main | +0.0% | +75.4 | −0.0% | 0 | 0% | +45.7 | +11.8 | never |
| double7 | main | +0.0% | +75.4 | −0.0% | 0 | 0% | +45.7 | +11.8 | never |
| donchEns | main | -5.6% | +73.8 | −13.0% | 4 | 39% | +35.0 | +16.1 | 45d ago |
| donchian | classic (folded) | -26.1% | +68.1 | −64.2% | 4 | 21% | +21.6 | +19.6 | 75d ago |
| tsmom | main | +0.0% | +68.0 | −0.0% | 0 | 0% | -22.1 | +9.2 | never |
| dualMom | main | +0.0% | +68.0 | −0.0% | 0 | 0% | -22.1 | +9.2 | never |
| trend200 | classic (folded) | -10.1% | +65.4 | −10.2% | 1 | 1% | +45.7 | +11.8 | 461d ago |
| break | classic (folded) | -30.0% | +64.2 | −63.5% | 5 | 16% | +15.4 | +19.6 | 75d ago |
| triple | main | -30.8% | +63.4 | −65.3% | 19 | 13% | +4.8 | +16.6 | 54d ago |
| brkAtr | main | -33.7% | +60.5 | −66.7% | 10 | 14% | +8.8 | +19.6 | 89d ago |
| trend | main | -40.1% | +54.1 | −73.3% | 20 | 23% | -13.8 | +18.5 | 56d ago |
| multiTrend | main | -14.2% | +53.9 | −17.5% | 5 | 10% | -29.7 | +9.2 | 70d ago |
| maEns | main | -35.8% | +53.3 | −63.9% | 24 | 39% | +13.0 | +15.1 | 45d ago |
| adx | classic (folded) | -42.3% | +51.9 | −70.3% | 10 | 17% | +0.6 | +15.1 | 26d ago |
| ema | main | -42.6% | +51.6 | −43.1% | 4 | 18% | +29.0 | +14.2 | 47d ago |
| golden | classic (folded) | -27.6% | +47.9 | −31.9% | 1 | 7% | +45.7 | +11.8 | 437d ago |
| tsmom3 | main | -41.5% | +47.7 | −56.8% | 16 | 59% | +27.3 | +10.5 | 6d ago |
| coreTrend | main | -45.9% | +43.3 | −55.5% | 1 | 100% | +16.2 | +5.2 | holding |
| cryptoMom | main | -63.1% | +31.1 | −77.9% | 25 | 24% | +3.3 | +19.6 | 72d ago |
| psar | classic (folded) | -64.9% | +29.3 | −77.7% | 21 | 31% | +14.1 | +9.6 | 9d ago |
| basket | main | -39.8% | +28.2 | −53.6% | 1 | 100% | -9.7 | +4.5 | holding |
| volTarget | main | -68.6% | +25.6 | −70.9% | 1 | 100% | +5.6 | +0.1 | holding |
| boll | main | -71.8% | +22.4 | −73.5% | 15 | 56% | +28.5 | +3.1 | holding |
| rsi | main | -88.2% | +6.0 | −89.6% | 5 | 53% | +10.5 | +7.4 | holding |

## Across the three coins (average of the per-coin averages)

| Rule | next-90d vs hold | beat hold in |
|---|---|---|
| now: beat hold over last year (≥25% in coin), then smallest drop | -0.8 | 27/44 |
| A: best vs hold over all history so far | +0.8 | 30/44 |
| B: best vs hold over last year | -0.7 | 28/44 |
| C: beat hold over all history AND last year, then best all-history | +0.8 | 30/44 |
| D: beat hold over all history, then smallest drop | +0.4 | 27/44 |
| E: best absolute return over all history | +0.8 | 30/44 |
| F: best return ÷ worst drop over all history | -0.5 | 27/44 |
| G: basket of every agent, equal parts | -1.1 | 25/44 |
| H: basket of agents that beat hold over all history | +0.4 | 25/44 |
| I: basket of the 3 best vs hold over all history | +0.6 | 27/44 |
| fixed: 12-month momentum (tsmom) | -2.1 | 29/44 |
| fixed: dual momentum | -0.2 | 27/44 |
| fixed: 1/3/12-month trend blend (multiTrend) | +1.5 | 25/44 |
| fixed: volatility-targeted holding | -1.4 | 23/44 |
| fixed: the default basket (Moa's default) | -1.6 | 24/44 |
