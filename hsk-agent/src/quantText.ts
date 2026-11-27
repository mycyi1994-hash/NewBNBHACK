// What the app says about the research set (scratchpad/quant-research.md #1–#7). Every source is the real paper or
// page the research opened, with its address. The proof line says how strong the test is (peer-reviewed, working
// paper or practitioner), and where the published test used lower costs or other assets than Moa's 0.3% per trade
// on one coin. Nothing here claims a fund runs these agents.
import type { RuleText } from './ruleText.ts';

export type QuantTextRule = 'volTarget' | 'donchEns' | 'tsmom3' | 'coreTrend' | 'maEns' | 'brkAtr' | 'breakC' | 'turtle2C' | 'donchianC';

const COST_EN = 'Moa pays 0.3% per trade on HSKSwap, more than the published tests assumed.';
const COST_KO = '모아는 HSKSwap에서 거래마다 0.3%를 내요. 논문들이 가정한 비용보다 커요.';
const CHAND_EN = 'Chandelier exit by Charles LeBeau: stop = highest high of 22 days minus 3 average true ranges (https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit). Why a stop can help when prices trend: Kaminski and Lo, “When Do Stop-Loss Rules Stop Losses?”, Journal of Financial Markets 2014 (https://dspace.mit.edu/handle/1721.1/114876).';
const CHAND_KO = 'Charles LeBeau의 샹들리에 청산: 22일 최고가에서 평균 하루 변동폭(ATR)의 3배를 뺀 곳에 손절선 (https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit). 추세가 있을 때 손절이 도움이 되는 이유: Kaminski·Lo, 「When Do Stop-Loss Rules Stop Losses?」, Journal of Financial Markets 2014 (https://dspace.mit.edu/handle/1721.1/114876).';
const CHAND_PROOF_EN = `A practitioner rule (LeBeau) with peer-reviewed theory (Kaminski and Lo) tested on equity futures, not crypto. Adding it to this rule is Moa’s combination; nothing published tests the pair. ${COST_EN}`;
const CHAND_PROOF_KO = `실무자가 만든 규칙(LeBeau)이고, 이론은 주가지수 선물로 검증된 논문(Kaminski·Lo)이에요. 암호화폐 검증은 아니에요. 이 규칙에 붙인 건 Moa의 조합이라 함께 검증한 기록은 없어요. ${COST_KO}`;

export const QUANT_TEXT: Record<'en' | 'ko', Record<QuantTextRule, RuleText>> = {
  en: {
    volTarget: {
      nick: 'Balance', rule: 'Volatility-targeted holding · 50%', line: 'Always holds some of the coin: less when it swings hard, more when it is calm.',
      rules: ['Share held = 50% ÷ the coin’s recent yearly volatility (20-day half-life), at most 100%.', 'Rebalances only when that share moves 15 points or more.'],
      risk: 'In a strong rally it holds less than all of the coin, so it trails just holding.',
      origin: 'Volatility targeting · Harvey et al. 2018', from: 'Harvey, Hoyle, Korgaonkar, Rattray, Sargaison and Van Hemert, “The Impact of Volatility Targeting”, Journal of Portfolio Management 2018 (https://people.duke.edu/~charvey/Research/Published_Papers/P135_The_impact_of.pdf). For bitcoin: FTSE Russell’s target-volatility study, 2020 (https://www.lseg.com/content/dam/ftse-russell/en_us/documents/research/ftse_russell-education_risk_friendly_ways_to_consider_a_bitcoin_allocation_0.pdf).',
      users: 'Volatility targeting is how many risk-parity and trend funds size positions; FTSE Russell publishes a bitcoin target-volatility index. No record of a fund running this exact rule.',
      proof: `Peer-reviewed for the method (stocks and bonds, not crypto). The bitcoin evidence is an index provider’s backtest (2014–2020, 25% target), not a paper. Results can fade out of sample (Cederburg et al., JFE 2020). ${COST_EN}`,
      fit: 'You want to stay in the coin but with calmer swings.', good: 'Bear markets and wild stretches; it lags in strong rallies.', ov: '',
    },
    donchEns: {
      nick: 'Chorus', rule: 'Donchian ensemble · 10–150 days', line: 'Six breakout rules vote; it holds a share for each yes, less when the coin is wild.',
      rules: ['For 10, 20, 30, 60, 90 and 150 days: in on a new high close, out under the midpoint of the range (the stop only rises).', 'Share = votes in ÷ 6 × (25% ÷ 90-day volatility), at most 100%; rebalances on 10-point moves.'],
      risk: 'With a 25% volatility target it rarely holds much bitcoin, so it lags in rallies.',
      origin: 'Zarattini, Pagani & Barbon · 2025', from: 'Zarattini, Pagani and Barbon, “Catching Crypto Trends: A Tactical Approach for Bitcoin and Altcoins”, SSRN working paper 5209907, 2025 (https://abarbon.com/papers/catching-crypto-trends ; rules via https://www.cxoadvisory.com/technical-trading/crypto-asset-trend-following-strategies/).',
      users: 'Built by a quantitative research firm and academics. No record of a fund running this exact rule.',
      proof: `A working paper, not yet peer-reviewed. Its headline result is a 20-coin portfolio at 0.10% costs with leverage up to 200%; here one coin, no leverage, lookbacks up to 150 days (the paper also uses 250 and 360). ${COST_EN}`,
      fit: 'You want trend following that does not hang on one setting.', good: 'Trends of weeks to months.', ov: '',
    },
    tsmom3: {
      nick: 'Tempo', rule: 'Multi-horizon momentum · 1w/4w/3m', line: 'Holds a third for each of the last week, month and quarter that went up.',
      rules: ['Every Monday: count which of the 7-, 28- and 91-day returns are positive.', 'Hold that many thirds of the money until next Monday.'],
      risk: 'It reacts a week late at most, and the 7-day signal flips often.',
      origin: 'Liu & Tsyvinski · RFS 2021', from: 'Liu and Tsyvinski, “Risks and Returns of Cryptocurrency”, Review of Financial Studies 2021 (https://www.nber.org/papers/w24877): bitcoin returns over one to four weeks predict the next weeks. The blend follows Hurst, Ooi and Pedersen, “A Century of Evidence on Trend-Following Investing”, 2017 (https://fairmodel.econ.yale.edu/ec439/hurst.pdf).',
      users: 'Trend-following funds blend several horizons like this. No record of a fund running this exact rule.',
      proof: `Peer-reviewed. The crypto evidence is mostly 2011–2018 and counts no costs; the blend itself was tested on futures, not crypto. ${COST_EN}`,
      fit: 'You want to lean into what has been rising, a step at a time.', good: 'Rises that last weeks.', ov: '',
    },
    coreTrend: {
      nick: 'Anchor', rule: 'Core plus trend · 50/50', line: 'Half always rides the coin (calmer when it is wild); the other half joins when the trend is up.',
      rules: ['Half: the Balance share (50% ÷ volatility).', 'Half: the same share × the Tempo momentum score. Rebalances on 10-point moves.'],
      risk: 'Built from published parts but tested as a whole nowhere; it still loses in long falls.',
      origin: 'Moa’s blend of published parts', from: 'A 50/50 blend fixed in advance: volatility targeting (Harvey et al. 2018, https://people.duke.edu/~charvey/Research/Published_Papers/P135_The_impact_of.pdf) with multi-horizon momentum (Liu and Tsyvinski 2021, https://www.nber.org/papers/w24877). Harvey et al. suggest a trend overlay may further help a long portfolio.',
      users: 'No record of anyone running this exact blend.',
      proof: `Each part is peer-reviewed; nothing published tests this blend on bitcoin. The split is fixed at 50/50, not tuned. ${COST_EN}`,
      fit: 'You never want to be all in cash, but want less of the coin in a downtrend.', good: 'Long rises with rough patches.', ov: '',
    },
    maEns: {
      nick: 'Trio', rule: 'Average ensemble · 20/50/100', line: 'Holds a third for each of its 20-, 50- and 100-day averages the price is above.',
      rules: ['Count how many of the 20-, 50- and 100-day averages the close is above.', 'Hold that many thirds of the money.'],
      risk: 'In sideways markets it steps in and out by thirds and pays the fee each time.',
      origin: 'Detzel et al. · Financial Management 2021', from: 'Detzel, Liu, Strauss, Zhou and Zhu, “Learning and predictability via technical analysis: Evidence from bitcoin and stocks with hard-to-value fundamentals”, Financial Management 2021 (https://ideas.repec.org/a/bla/finmgt/v50y2021i1p107-137.html).',
      users: 'Chart-based traders use moving averages widely. No record of a fund running this exact rule.',
      proof: `Peer-reviewed, on bitcoin 2010–2017, before costs: holding above the averages cut the worst drop (−66% to −70% vs −89.5%) but returned slightly less than holding. ${COST_EN}`,
      fit: 'You want a simple trend rule that never bets everything on one average.', good: 'Long trends; it is slow to re-enter after a crash.', ov: 'MA20 · MA50 · MA100',
    },
    brkAtr: {
      nick: 'Climber', rule: '20-day breakout · 3×ATR stop', line: 'Buys a new 20-day high and follows it up with a stop that rises with the price.',
      rules: ['Close at the highest close of the last 20 days: buy.', 'Exit under the chandelier stop: 22-day high − 3 × ATR(22), which only rises.'],
      risk: 'Many breakouts fail, so it often takes small losses before a run.',
      origin: 'Quantpedia breakout · 2022', from: `Padyšák and Vojtko, “Trend-following and Mean-reversion in Bitcoin”, Quantpedia 2022 (https://quantpedia.com/trend-following-and-mean-reversion-in-bitcoin/), with an out-of-sample follow-up for 2022–2024 (https://quantpedia.com/?p=35597). Exit: ${CHAND_EN}`,
      users: 'Published by a quantitative research site for practitioners. No record of a fund running this exact rule.',
      proof: `Practitioner research that held up out of sample (2022–2024), with peer-reviewed support for breakouts on bitcoin (Gerritsen et al., Finance Research Letters 2020). None of these tests counted costs. ${COST_EN}`,
      fit: 'You want to buy strength and let a rising stop protect the gain.', good: 'Strong runs of a few weeks.', ov: '20-day high',
    },
    breakC: {
      nick: 'Turtle Guard', rule: 'Breakout · 20/10 + 3×ATR stop', line: 'The Turtle’s 20-day breakout, with a stop that rises with the price.',
      rules: ['Close above the 20-day high: buy. Close below the 10-day low: sell.', 'Also sells under the chandelier stop (22-day high − 3 × ATR); waits for a fresh entry after.'],
      risk: 'The stop can sell a pullback just before the trend resumes.',
      origin: 'Turtle System 1 + chandelier exit', from: `System 1 of the Turtle traders (Richard Dennis and William Eckhardt, 1983). Stop: ${CHAND_EN}`,
      users: 'The Turtle rules ran with real money; the stop is a common practitioner exit.', proof: CHAND_PROOF_EN,
      fit: 'You like the Turtle rule but want gains protected sooner.', good: 'Trends with sharp pullbacks.', ov: '20-day high · 10-day low',
    },
    turtle2C: {
      nick: 'Big Turtle Guard', rule: 'Breakout · 55/20 + 3×ATR stop', line: 'The Turtle’s 55-day breakout, with a stop that rises with the price.',
      rules: ['Close above the 55-day high: buy. Close below the 20-day low: sell.', 'Also sells under the chandelier stop (22-day high − 3 × ATR); waits for a fresh entry after.'],
      risk: 'Few entries; the stop can cut a long trend short.',
      origin: 'Turtle System 2 + chandelier exit', from: `System 2 of the Turtle traders (Dennis and Eckhardt, 1983). Stop: ${CHAND_EN}`,
      users: 'The Turtle rules ran with real money; the stop is a common practitioner exit.', proof: CHAND_PROOF_EN,
      fit: 'You want only big trends, with the gain protected on the way.', good: 'Long, strong trends.', ov: '55-day high · 20-day low',
    },
    donchianC: {
      nick: 'Donchian Guard', rule: 'Four-week rule + 3×ATR stop', line: 'Buys a four-week high, sells a four-week low or under a rising stop.',
      rules: ['Close above the 20-day high: buy. Close below the 20-day low: sell.', 'Also sells under the chandelier stop (22-day high − 3 × ATR); waits for a fresh entry after.'],
      risk: 'The stop adds trades in choppy markets.',
      origin: 'Donchian four-week rule + chandelier exit', from: `Richard Donchian’s four-week rule (1960s). Stop: ${CHAND_EN}`,
      users: 'A classic trend rule; the stop is a common practitioner exit.', proof: CHAND_PROOF_EN,
      fit: 'You want a plain breakout rule that gives back less.', good: 'Trends of a month or more.', ov: '20-day high · 20-day low',
    },
  },
  ko: {
    volTarget: {
      nick: '밸런스', rule: '변동성 맞춤 보유 · 50%', line: '늘 조금은 들고 있어요. 많이 출렁이면 덜, 잠잠하면 더 들어요.',
      rules: ['보유 비중 = 50% ÷ 최근 1년 환산 변동성(20일 반감기), 최대 100%.', '비중이 15%p 넘게 바뀔 때만 맞춰요.'],
      risk: '크게 오르는 장에선 전부 들고 있지 않아서, 그냥 들고 있는 것보다 덜 벌어요.',
      origin: '변동성 타기팅 · Harvey 외 2018', from: 'Harvey·Hoyle·Korgaonkar·Rattray·Sargaison·Van Hemert, 「The Impact of Volatility Targeting」, Journal of Portfolio Management 2018 (https://people.duke.edu/~charvey/Research/Published_Papers/P135_The_impact_of.pdf). 비트코인: FTSE Russell의 목표 변동성 연구, 2020 (https://www.lseg.com/content/dam/ftse-russell/en_us/documents/research/ftse_russell-education_risk_friendly_ways_to_consider_a_bitcoin_allocation_0.pdf).',
      users: '리스크 패리티·추세 펀드들이 비중을 정할 때 흔히 써요. FTSE Russell이 비트코인 목표 변동성 지수를 내요. 이 규칙 그대로 운용하는 기관 기록은 없어요.',
      proof: `방법은 논문 심사를 거쳤어요(주식·채권, 암호화폐 아님). 비트코인 근거는 지수 회사의 백테스트(2014~2020, 목표 25%)예요. 새 데이터에선 효과가 약해질 수 있어요(Cederburg 외, JFE 2020). ${COST_KO}`,
      fit: '코인은 계속 들되 덜 출렁이고 싶은 분.', good: '하락장·거친 장. 크게 오르는 장에선 뒤처져요.', ov: '',
    },
    donchEns: {
      nick: '코러스', rule: '돈치안 앙상블 · 10~150일', line: '돌파 규칙 6개가 투표해요. 찬성만큼 들고, 많이 출렁이면 덜 들어요.',
      rules: ['10·20·30·60·90·150일 각각: 신고가로 마감하면 진입, 범위 중간선 아래면 청산(손절선은 올라가기만).', '비중 = 찬성 ÷ 6 × (25% ÷ 90일 변동성), 최대 100%. 10%p 넘게 바뀔 때만 맞춰요.'],
      risk: '목표 변동성이 25%라 비트코인을 많이 들지 않아서, 오르는 장에선 뒤처져요.',
      origin: 'Zarattini·Pagani·Barbon · 2025', from: 'Zarattini·Pagani·Barbon, 「Catching Crypto Trends: A Tactical Approach for Bitcoin and Altcoins」, SSRN 워킹페이퍼 5209907, 2025 (https://abarbon.com/papers/catching-crypto-trends ; 규칙 요약 https://www.cxoadvisory.com/technical-trading/crypto-asset-trend-following-strategies/).',
      users: '퀀트 리서치 회사와 학자들이 만들었어요. 이 규칙 그대로 운용하는 기관 기록은 없어요.',
      proof: `아직 심사 전 워킹페이퍼예요. 대표 결과는 코인 20개 포트폴리오, 비용 0.10%, 레버리지 최대 200%예요. 여기선 코인 하나, 레버리지 없이, 기간은 150일까지(논문은 250·360일도 써요). ${COST_KO}`,
      fit: '설정 하나에 기대지 않는 추세 추종을 원하는 분.', good: '몇 주~몇 달 이어지는 추세.', ov: '',
    },
    tsmom3: {
      nick: '템포', rule: '여러 기간 모멘텀 · 1주/4주/3달', line: '지난 1주·한 달·석 달 중 오른 기간마다 3분의 1씩 들어요.',
      rules: ['매주 월요일, 7·28·91일 수익률 중 플러스인 개수를 세요.', '그 개수만큼 3분의 1씩 들고 다음 월요일까지 둬요.'],
      risk: '최대 일주일 늦게 반응하고, 7일 신호는 자주 바뀌어요.',
      origin: 'Liu·Tsyvinski · RFS 2021', from: 'Liu·Tsyvinski, 「Risks and Returns of Cryptocurrency」, Review of Financial Studies 2021 (https://www.nber.org/papers/w24877): 비트코인의 1~4주 수익률이 다음 몇 주를 예측해요. 섞는 방식은 Hurst·Ooi·Pedersen, 「A Century of Evidence on Trend-Following Investing」, 2017 (https://fairmodel.econ.yale.edu/ec439/hurst.pdf).',
      users: '추세 추종 펀드들이 이렇게 여러 기간을 섞어요. 이 규칙 그대로 운용하는 기관 기록은 없어요.',
      proof: `논문 심사를 거쳤어요. 암호화폐 근거는 대부분 2011~2018년이고 비용을 빼지 않았어요. 섞는 방식은 선물로 검증됐고 암호화폐는 아니에요. ${COST_KO}`,
      fit: '오르던 쪽에 조금씩 더 싣고 싶은 분.', good: '몇 주 이어지는 상승.', ov: '',
    },
    coreTrend: {
      nick: '앵커', rule: '코어 + 추세 · 50/50', line: '절반은 늘 들고(거칠면 덜), 나머지 절반은 추세가 좋을 때만 들어요.',
      rules: ['절반: 밸런스 비중(50% ÷ 변동성).', '절반: 같은 비중 × 템포 모멘텀 점수. 10%p 넘게 바뀔 때만 맞춰요.'],
      risk: '검증된 부품으로 만들었지만 통째로 검증한 곳은 없어요. 긴 하락장에선 여전히 잃어요.',
      origin: '검증된 부품을 섞은 Moa 조합', from: '미리 정한 50/50 조합: 변동성 타기팅(Harvey 외 2018, https://people.duke.edu/~charvey/Research/Published_Papers/P135_The_impact_of.pdf)과 여러 기간 모멘텀(Liu·Tsyvinski 2021, https://www.nber.org/papers/w24877). Harvey 외는 추세를 덧대면 더 나아질 수 있다고 했어요.',
      users: '이 조합 그대로 운용하는 기록은 없어요.',
      proof: `부품은 각각 논문 심사를 거쳤지만, 이 조합을 비트코인으로 검증한 논문은 없어요. 비율은 50/50으로 고정했고 맞추지 않았어요. ${COST_KO}`,
      fit: '현금으로만 쉬긴 싫지만, 하락 추세에선 덜 들고 싶은 분.', good: '거친 구간이 섞인 긴 상승.', ov: '',
    },
    maEns: {
      nick: '트리오', rule: '평균선 앙상블 · 20/50/100', line: '가격이 20·50·100일 평균선 위에 있는 개수만큼 3분의 1씩 들어요.',
      rules: ['종가가 20·50·100일 평균선 중 몇 개 위에 있는지 세요.', '그 개수만큼 3분의 1씩 들어요.'],
      risk: '옆으로 기는 장에선 3분의 1씩 들락날락하며 수수료를 내요.',
      origin: 'Detzel 외 · Financial Management 2021', from: 'Detzel·Liu·Strauss·Zhou·Zhu, 「Learning and predictability via technical analysis: Evidence from bitcoin and stocks with hard-to-value fundamentals」, Financial Management 2021 (https://ideas.repec.org/a/bla/finmgt/v50y2021i1p107-137.html).',
      users: '차트를 보는 매매자들이 평균선을 널리 써요. 이 규칙 그대로 운용하는 기관 기록은 없어요.',
      proof: `논문 심사를 거쳤어요. 비트코인 2010~2017년, 비용 빼기 전: 평균선 위에서만 들면 가장 크게 떨어진 폭이 줄었지만(−66~−70% vs −89.5%) 수익은 그냥 들고 있을 때보다 조금 낮았어요. ${COST_KO}`,
      fit: '평균선 하나에 다 걸지 않는 단순한 추세 규칙을 원하는 분.', good: '긴 추세. 폭락 뒤 다시 들어가는 건 느려요.', ov: '20일 · 50일 · 100일 평균선',
    },
    brkAtr: {
      nick: '클라이머', rule: '20일 돌파 · 3×ATR 손절', line: '20일 신고가에 사고, 가격 따라 올라가는 손절선으로 지켜요.',
      rules: ['종가가 최근 20일 중 가장 높으면 매수.', '샹들리에 손절선(22일 최고가 − 3 × ATR(22)) 아래로 마감하면 매도. 손절선은 올라가기만 해요.'],
      risk: '돌파가 자주 실패해서, 큰 흐름 전에 작은 손실을 자주 내요.',
      origin: 'Quantpedia 돌파 · 2022', from: `Padyšák·Vojtko, 「Trend-following and Mean-reversion in Bitcoin」, Quantpedia 2022 (https://quantpedia.com/trend-following-and-mean-reversion-in-bitcoin/), 2022~2024 새 데이터 확인 (https://quantpedia.com/?p=35597). 청산: ${CHAND_KO}`,
      users: '실무자를 위한 퀀트 리서치 사이트가 공개했어요. 이 규칙 그대로 운용하는 기관 기록은 없어요.',
      proof: `새 데이터(2022~2024)에서도 버틴 실무 리서치예요. 비트코인 돌파 규칙은 심사 논문(Gerritsen 외, Finance Research Letters 2020)도 뒷받침해요. 다만 모두 비용을 빼지 않았어요. ${COST_KO}`,
      fit: '강할 때 사고, 올라가는 손절선으로 이익을 지키고 싶은 분.', good: '몇 주 이어지는 강한 상승.', ov: '20일 최고가',
    },
    breakC: {
      nick: '터틀 가드', rule: '돌파 · 20/10 + 3×ATR 손절', line: '터틀의 20일 돌파에, 가격 따라 올라가는 손절선을 더했어요.',
      rules: ['20일 최고가 위로 마감하면 매수, 10일 최저가 아래면 매도.', '샹들리에 손절선(22일 최고가 − 3 × ATR) 아래서도 팔고, 새 진입 신호를 기다려요.'],
      risk: '눌림에서 팔았는데 바로 다시 오를 수 있어요.',
      origin: '터틀 시스템 1 + 샹들리에 청산', from: `터틀 트레이더의 시스템 1(Richard Dennis·William Eckhardt, 1983). 손절: ${CHAND_KO}`,
      users: '터틀 규칙은 실제 돈으로 운용됐어요. 손절선은 실무에서 흔히 쓰는 청산이에요.', proof: CHAND_PROOF_KO,
      fit: '터틀 규칙이 좋지만 이익을 더 일찍 지키고 싶은 분.', good: '눌림이 큰 추세.', ov: '20일 고가 · 10일 저가',
    },
    turtle2C: {
      nick: '빅터틀 가드', rule: '돌파 · 55/20 + 3×ATR 손절', line: '터틀의 55일 돌파에, 가격 따라 올라가는 손절선을 더했어요.',
      rules: ['55일 최고가 위로 마감하면 매수, 20일 최저가 아래면 매도.', '샹들리에 손절선(22일 최고가 − 3 × ATR) 아래서도 팔고, 새 진입 신호를 기다려요.'],
      risk: '진입이 드물고, 손절선이 긴 추세를 일찍 끊을 수 있어요.',
      origin: '터틀 시스템 2 + 샹들리에 청산', from: `터틀 트레이더의 시스템 2(Dennis·Eckhardt, 1983). 손절: ${CHAND_KO}`,
      users: '터틀 규칙은 실제 돈으로 운용됐어요. 손절선은 실무에서 흔히 쓰는 청산이에요.', proof: CHAND_PROOF_KO,
      fit: '큰 추세만 노리되 가는 길에 이익을 지키고 싶은 분.', good: '길고 강한 추세.', ov: '55일 고가 · 20일 저가',
    },
    donchianC: {
      nick: '돈치안 가드', rule: '4주 규칙 + 3×ATR 손절', line: '4주 신고가에 사고, 4주 신저가나 올라가는 손절선 아래서 팔아요.',
      rules: ['20일 최고가 위로 마감하면 매수, 20일 최저가 아래면 매도.', '샹들리에 손절선(22일 최고가 − 3 × ATR) 아래서도 팔고, 새 진입 신호를 기다려요.'],
      risk: '출렁이는 장에선 손절 때문에 거래가 늘어요.',
      origin: '돈치안 4주 규칙 + 샹들리에 청산', from: `Richard Donchian의 4주 규칙(1960년대). 손절: ${CHAND_KO}`,
      users: '고전 추세 규칙이에요. 손절선은 실무에서 흔히 쓰는 청산이에요.', proof: CHAND_PROOF_KO,
      fit: '단순한 돌파 규칙인데 덜 돌려주고 싶은 분.', good: '한 달 넘게 이어지는 추세.', ov: '20일 고가 · 20일 저가',
    },
  },
};
