// What the app says about the fifteen published rules added after the first set (the older rules' text is in
// i18n.ts). One entry per rule and language; i18n.ts spreads these into its per-field maps.
// Every source named here is a real, published one. What differs from the source (long only, daily checks, a
// parameter Moa had to choose) is said in the text, and nothing claims a fund runs these agents.

export type MoreRule = 'multiTrend' | 'dualMom' | 'turtle2' | 'donchian' | 'ma520' | 'triple' | 'macd' | 'ichimoku'
  | 'keltner' | 'psar' | 'adx' | 'aroon' | 'cryptoMom' | 'rsi2' | 'double7';

export interface RuleText {
  nick: string;      // the agent's short name
  rule: string;      // the strategy's name
  line: string;      // what it does, in one line
  rules: string[];   // the rule itself, two lines
  risk: string;      // where it is weak
  origin: string;    // the short origin tag
  from: string;      // the source
  users: string;     // who has used it
  proof: string;     // how far it has been tested
  fit: string;       // who it suits
  good: string;      // where it works
  ov: string;        // legend for what is drawn on the chart
}

const U_EN = 'Chart analysts and systematic traders. There is no record of a specific institution running this exact rule.';
const P_EN = 'Published by its author and widely used. This exact rule has no formal test on record; the backtest here is what you can check.';
const U_KO = '차트 분석가와 시스템 트레이더들이 널리 써요. 이 규칙 그대로 운용하는 기관에 대한 기록은 없어요.';
const P_KO = '저자가 직접 공개했고 널리 쓰여요. 다만 이 규칙 그대로를 공식 검증한 기록은 없어서, 여기 백테스트로 확인하셔야 해요.';

export const RULE_TEXT: Record<'en' | 'ko', Record<MoreRule, RuleText>> = {
  en: {
    multiTrend: {
      nick: 'Century', rule: 'Multi-horizon trend · 1/3/12m', line: 'Long while at least two of the 1-, 3- and 12-month returns are positive.',
      rules: ['Look at the return over 1, 3 and 12 months.', 'Two or more positive: hold. Otherwise: cash.'],
      risk: 'When the three horizons disagree it switches back and forth.',
      origin: 'AQR trend study · 2017', from: 'Hurst, Ooi and Pedersen, “A Century of Evidence on Trend-Following Investing”, 2017: a blend of 1-, 3- and 12-month trend signals.',
      users: 'The blend of horizons that trend-following futures funds (CTAs) are described as running.',
      proof: 'A published study over more than a century of markets. The paper weights the three signals and goes short as well; here two of three must agree and it only goes long. Crypto is outside the study.',
      fit: 'You want trend following that does not depend on one look-back.', good: 'Trends that show up on short and long horizons together.', ov: '12-month return (one of three signals)',
    },
    dualMom: {
      nick: 'Dual', rule: 'Dual momentum · 12m', line: 'Long while its 12-month return is positive and at least as high as the other major coin’s.',
      rules: ['12-month return above zero, and not behind the other major coin (ETH for BTC, BTC for the rest): hold.', 'Otherwise: cash.'],
      risk: 'It can sit out a rally because the other coin is stronger, and it turns late.',
      origin: 'Antonacci dual momentum · 2014', from: 'Gary Antonacci, “Dual Momentum Investing”, 2014: hold the stronger asset (relative momentum) only while it is rising (absolute momentum).',
      users: 'Used by individual investors and advisers for rotating between asset classes.',
      proof: 'Published tests on stocks and bonds, decided once a month. Here it compares two coins every day; crypto is outside the original.',
      fit: 'You want to be in a coin only when it is both rising and the leader.', good: 'A long rise led clearly by one coin.', ov: '12-month return (hold above 0)',
    },
    turtle2: {
      nick: 'Big Turtle', rule: 'Breakout · 55/20', line: 'Long on a new 55-day high, out on a 20-day low.',
      rules: ['Close above the 55-day high: go long.', 'Close below the 20-day low: exit.'],
      risk: 'It waits a long time for an entry and gives back a lot before it exits.',
      origin: 'Turtle traders · System 2', from: 'System 2 of the Turtle traders (Richard Dennis and William Eckhardt, 1983): in on a 55-day high, out on a 20-day low.',
      users: 'The Turtle traders ran it with real money; the rules were published later (Curtis Faith, “Way of the Turtle”, 2007).',
      proof: 'A classic with a real trading record. The original position sizing and stops are not included here; long only.',
      fit: 'You want only the big trends and can wait months between trades.', good: 'Long, strong trends.', ov: '55-day high · 20-day low',
    },
    donchian: {
      nick: 'Donchian', rule: 'Four-week rule · 20/20', line: 'Long on a new 4-week high, out on a new 4-week low.',
      rules: ['Close above the 20-day high: go long.', 'Close below the 20-day low: exit.'],
      risk: 'In a sideways market it buys highs and sells lows.',
      origin: 'Donchian four-week rule', from: 'Richard Donchian’s four-week rule: buy a new four-week high, sell a new four-week low.',
      users: 'One of the oldest trend-following rules; the Turtle rules grew out of it.', proof: P_EN,
      fit: 'You want the simplest possible trend rule.', good: 'Markets that break out and keep going.', ov: '20-day high · 20-day low',
    },
    ma520: {
      nick: 'Swift', rule: 'MA cross · 5/20', line: 'Long while the 5-day average is above the 20-day average.',
      rules: ['5-day average above the 20-day: hold.', 'Below it: exit.'],
      risk: 'It trades often and pays the fee each time; sideways markets hurt.',
      origin: 'Donchian 5/20 averages', from: 'The 5- and 20-day moving average method popularised by Richard Donchian.',
      users: U_EN, proof: P_EN,
      fit: 'You want to react fast and accept many trades.', good: 'Short, sharp trends.', ov: 'MA5 · MA20',
    },
    triple: {
      nick: 'Triple', rule: 'Triple MA · 4/9/18', line: 'Long while the 4-, 9- and 18-day averages are stacked upward.',
      rules: ['4-day above 9-day above 18-day: hold.', 'Any other order: exit.'],
      risk: 'Very fast: many small trades, each paying the fee.',
      origin: 'R.C. Allen 4-9-18', from: 'R.C. Allen’s 4-9-18 day moving average method, from his book on using those three averages in commodities (1970s).',
      users: U_EN, proof: P_EN,
      fit: 'You want the quickest trend signal here.', good: 'Short trends with clean direction.', ov: 'MA4 · MA9 · MA18',
    },
    macd: {
      nick: 'Pulse', rule: 'MACD · 12/26/9', line: 'Long while the MACD line is above its signal line.',
      rules: ['MACD (12-day EMA minus 26-day EMA) above its 9-day signal: hold.', 'Below it: exit.'],
      risk: 'It flips often when the market has no direction.',
      origin: 'Gerald Appel’s MACD', from: 'MACD, created by Gerald Appel in the late 1970s, with its standard 12, 26, 9 settings.',
      users: U_EN, proof: P_EN,
      fit: 'You want a familiar momentum signal that turns earlier than a moving-average cross.', good: 'Trends that build and fade gradually.', ov: 'EMA12 · EMA26',
    },
    ichimoku: {
      nick: 'Cloud', rule: 'Ichimoku cloud · 9/26/52', line: 'Long while the price is above the cloud.',
      rules: ['Close above both edges of the cloud: hold.', 'Back inside or below it: exit.'],
      risk: 'Slow to enter; a thin cloud gives false exits.',
      origin: 'Hosoda’s Ichimoku · 1969', from: 'Ichimoku Kinko Hyo by Goichi Hosoda, published as a book in 1969 (9, 26, 52).',
      users: 'Widely used by chart analysts, especially in Japan.', proof: P_EN,
      fit: 'You want one picture that says trend or no trend.', good: 'Steady trends.', ov: 'Cloud edges (span A · span B)',
    },
    keltner: {
      nick: 'Channel', rule: 'Keltner channel breakout', line: 'Long above the upper channel, out below the middle line.',
      rules: ['Close above the upper band (20-day EMA + 2 ATR): go long.', 'Close below the 20-day EMA: exit.'],
      risk: 'A breakout that fails right away costs a quick loss.',
      origin: 'Keltner channel · 1960', from: 'Chester Keltner’s channel (“How to Make Money in Commodities”, 1960), in the modern EMA and ATR form.',
      users: U_EN, proof: P_EN,
      fit: 'You want to join a move only once it shows strength.', good: 'Strong moves out of a quiet range.', ov: 'Upper band · EMA20',
    },
    psar: {
      nick: 'Parabolic', rule: 'Parabolic SAR', line: 'Long while the price is above the parabolic stop.',
      rules: ['Price above the stop: hold; the stop climbs faster as the move goes on.', 'Price hits the stop: exit.'],
      risk: 'It is always in or out, so sideways markets cut it up.',
      origin: 'Wilder’s Parabolic SAR · 1978', from: 'Parabolic SAR from J. Welles Wilder, “New Concepts in Technical Trading Systems”, 1978 (step 0.02, maximum 0.20).',
      users: U_EN, proof: P_EN,
      fit: 'You want a trailing stop that tightens by itself.', good: 'Fast, one-way moves.', ov: 'Parabolic stop',
    },
    adx: {
      nick: 'Compass', rule: 'ADX trend · 14', line: 'Long when the trend is strong and upward by Wilder’s directional index.',
      rules: ['ADX above 25 and +DI above −DI: go long.', '+DI falls below −DI: exit.'],
      risk: 'It needs the trend to be visible first, so it enters late.',
      origin: 'Wilder’s ADX · 1978', from: 'ADX and the directional movement system from J. Welles Wilder, “New Concepts in Technical Trading Systems”, 1978. Reading ADX above 25 as a trend is the common convention.',
      users: U_EN, proof: P_EN,
      fit: 'You want to trade only when a trend is actually there.', good: 'Clear, strong trends.', ov: '',
    },
    aroon: {
      nick: 'Dawn', rule: 'Aroon · 25', line: 'Long while the latest high is more recent than the latest low.',
      rules: ['Aroon Up above Aroon Down (25 days): hold.', 'Below it: exit.'],
      risk: 'In a range the two lines cross back and forth.',
      origin: 'Chande’s Aroon · 1995', from: 'The Aroon indicator, introduced by Tushar Chande in 1995 (25 days).',
      users: U_EN, proof: P_EN,
      fit: 'You want a simple read on whether new highs are still coming.', good: 'Markets making new highs regularly.', ov: '',
    },
    cryptoMom: {
      nick: 'Sprinter', rule: 'Crypto momentum · 4 weeks', line: 'Long while the price is higher than four weeks ago.',
      rules: ['Close above the close 28 days ago: hold.', 'Below it: exit.'],
      risk: 'Short look-back: it changes its mind often and pays the fee each time.',
      origin: 'Crypto momentum study · 2021', from: 'Liu and Tsyvinski, “Risks and Returns of Cryptocurrency”, Review of Financial Studies, 2021, which reports short-horizon time-series momentum in cryptocurrencies.',
      users: 'An academic finding, not a known fund strategy.',
      proof: 'The paper studies cryptocurrency returns directly; its working-paper version reports that a week’s Bitcoin return predicts the next one to four weeks. The four-week look-back and the daily check are Moa’s choice, not the paper’s.',
      fit: 'You want a momentum rule studied on crypto itself.', good: 'Runs that last several weeks.', ov: '4-week return (hold above 0)',
    },
    rsi2: {
      nick: 'Snap', rule: 'RSI(2) pullback', line: 'In an uptrend, buys a sharp two-day dip and sells the bounce.',
      rules: ['Above the 200-day average and RSI(2) under 5: buy.', 'Close above the 5-day average: sell.'],
      risk: 'No stop: a dip that keeps falling is held until it bounces.',
      origin: 'Connors RSI(2) · 2008', from: 'The 2-period RSI strategy in Larry Connors and Cesar Alvarez, “Short Term Trading Strategies That Work”, 2008.',
      users: 'Popular with short-term traders of stock indexes.', proof: 'Published by its authors with their own tests on US stock indexes. No independent academic test; crypto is outside it.',
      fit: 'You want short trades that buy dips, only while the long trend is up.', good: 'An uptrend with quick dips.', ov: 'MA5 · MA200',
    },
    double7: {
      nick: 'Double Seven', rule: 'Double 7’s', line: 'In an uptrend, buys a 7-day low and sells a 7-day high.',
      rules: ['Above the 200-day average and the lowest close in 7 days: buy.', 'The highest close in 7 days: sell.'],
      risk: 'No stop: it holds through a fall until a 7-day high comes.',
      origin: 'Connors Double 7’s · 2008', from: 'The “Double 7’s” strategy in Larry Connors and Cesar Alvarez, “Short Term Trading Strategies That Work”, 2008.',
      users: 'Popular with short-term traders of stock indexes.', proof: 'Published by its authors with their own tests on US stock indexes. No independent academic test; crypto is outside it.',
      fit: 'You want a very simple dip-buying rule inside an uptrend.', good: 'An uptrend that swings week to week.', ov: 'MA200',
    },
  },
  ko: {
    multiTrend: {
      nick: '센추리', rule: '다중 기간 추세 · 1/3/12개월', line: '1·3·12개월 수익률 중 둘 이상이 플러스인 동안 들고 있어요.',
      rules: ['1개월·3개월·12개월 수익률을 함께 봐요.', '둘 이상 플러스면 보유, 아니면 현금.'],
      risk: '세 기간의 방향이 엇갈리면 사고팔기를 반복해요.',
      origin: 'AQR 추세 연구 · 2017', from: 'Hurst·Ooi·Pedersen, 「A Century of Evidence on Trend-Following Investing」, 2017. 1·3·12개월 추세 신호를 섞어 써요.',
      users: '추세추종 선물 펀드(CTA)가 쓰는 것으로 알려진 기간 조합이에요.',
      proof: '100년 넘는 시장 자료로 검증한 연구가 있어요. 논문은 세 신호에 가중치를 두고 공매도도 하지만, 여기서는 셋 중 둘이 같을 때만 사고 롱만 해요. 암호화폐는 연구 범위 밖이에요.',
      fit: '한 가지 기간에만 기대지 않는 추세 추종을 원하는 분.', good: '짧게 봐도 길게 봐도 같은 방향인 추세.', ov: '12개월 수익률 (세 신호 중 하나)',
    },
    dualMom: {
      nick: '듀얼', rule: '듀얼 모멘텀 · 12개월', line: '12개월 수익률이 플러스이고, 다른 주요 코인보다 뒤지지 않는 동안 들고 있어요.',
      rules: ['12개월 수익률이 0보다 크고, 비교 코인(BTC는 ETH, 나머지는 BTC)보다 낮지 않으면 보유.', '아니면 현금.'],
      risk: '다른 코인이 더 강하면 상승장에서도 쉴 수 있고, 방향 전환이 늦어요.',
      origin: '안토나치 듀얼 모멘텀 · 2014', from: 'Gary Antonacci, 『Dual Momentum Investing』, 2014. 더 강한 자산을 고르되(상대 모멘텀), 그 자산이 오르는 동안만 들고 가요(절대 모멘텀).',
      users: '개인 투자자와 자문사가 자산군을 갈아탈 때 써요.',
      proof: '주식·채권으로 검증한 공개 자료가 있고, 원래는 한 달에 한 번 판단해요. 여기서는 코인 둘을 매일 비교하고, 암호화폐는 원래 범위 밖이에요.',
      fit: '오르면서 동시에 더 강한 코인만 들고 싶은 분.', good: '한 코인이 뚜렷하게 앞서가는 긴 상승장.', ov: '12개월 수익률 (0 위면 보유)',
    },
    turtle2: {
      nick: '빅터틀', rule: '돌파 · 55/20일', line: '55일 신고가에 사고, 20일 신저가에 팔아요.',
      rules: ['55일 최고가 위로 마감하면 롱.', '20일 최저가 아래로 마감하면 청산.'],
      risk: '진입까지 오래 기다리고, 팔 때는 고점에서 많이 내려온 뒤예요.',
      origin: '터틀 트레이딩 · 시스템 2', from: '터틀 트레이더의 시스템 2(Richard Dennis·William Eckhardt, 1983). 55일 신고가 진입, 20일 신저가 청산.',
      users: '터틀 트레이더들이 실제 자금으로 운용했고, 규칙은 나중에 공개됐어요(Curtis Faith, 『Way of the Turtle』, 2007).',
      proof: '실전 운용 기록이 있는 고전 규칙이에요. 원래 있던 포지션 크기 조절과 손절은 여기에 없고, 롱만 해요.',
      fit: '큰 추세만 타고, 몇 달씩 기다릴 수 있는 분.', good: '길고 강한 추세.', ov: '55일 고가 · 20일 저가',
    },
    donchian: {
      nick: '돈치안', rule: '4주 규칙 · 20/20일', line: '4주 신고가에 사고, 4주 신저가에 팔아요.',
      rules: ['20일 최고가 위로 마감하면 롱.', '20일 최저가 아래로 마감하면 청산.'],
      risk: '횡보장에서는 고점에 사고 저점에 팔게 돼요.',
      origin: '돈치안 4주 규칙', from: 'Richard Donchian의 4주 규칙. 4주 신고가에 사고 4주 신저가에 팔아요.',
      users: '가장 오래된 추세추종 규칙 중 하나로, 터틀 규칙의 바탕이 됐어요.', proof: P_KO,
      fit: '가장 단순한 추세 규칙을 원하는 분.', good: '돌파한 뒤 계속 가는 장.', ov: '20일 고가 · 20일 저가',
    },
    ma520: {
      nick: '스위프트', rule: '이평 교차 · 5/20', line: '5일 평균이 20일 평균 위에 있는 동안 들고 있어요.',
      rules: ['5일 평균이 20일 평균 위면 보유.', '아래로 내려가면 청산.'],
      risk: '매매가 잦아 수수료가 쌓이고, 횡보장에 약해요.',
      origin: '돈치안 5/20 이평', from: 'Richard Donchian이 널리 알린 5일·20일 이동평균 방법이에요.',
      users: U_KO, proof: P_KO,
      fit: '빠르게 반응하고, 잦은 매매를 감수할 수 있는 분.', good: '짧고 빠른 추세.', ov: 'MA5 · MA20',
    },
    triple: {
      nick: '트리플', rule: '삼중 이평 · 4/9/18', line: '4일·9일·18일 평균이 위에서부터 차례로 놓인 동안 들고 있어요.',
      rules: ['4일 > 9일 > 18일 순서면 보유.', '순서가 깨지면 청산.'],
      risk: '아주 빨라서 작은 매매가 많고, 그때마다 수수료를 내요.',
      origin: 'R.C. Allen 4-9-18', from: 'R.C. Allen의 4-9-18일 이동평균 방법. 세 평균을 쓰는 법을 다룬 그의 책(1970년대)에 나와요.',
      users: U_KO, proof: P_KO,
      fit: '여기서 가장 빠른 추세 신호를 원하는 분.', good: '방향이 깔끔한 짧은 추세.', ov: 'MA4 · MA9 · MA18',
    },
    macd: {
      nick: '펄스', rule: 'MACD · 12/26/9', line: 'MACD선이 시그널선 위에 있는 동안 들고 있어요.',
      rules: ['MACD(12일 EMA − 26일 EMA)가 9일 시그널 위면 보유.', '아래로 내려가면 청산.'],
      risk: '방향 없는 장에서는 신호가 자주 뒤집혀요.',
      origin: 'Gerald Appel의 MACD', from: 'Gerald Appel이 1970년대 후반에 만든 MACD. 표준 설정 12·26·9를 써요.',
      users: U_KO, proof: P_KO,
      fit: '이평 교차보다 조금 일찍 도는, 익숙한 모멘텀 신호를 원하는 분.', good: '천천히 만들어지고 천천히 꺾이는 추세.', ov: 'EMA12 · EMA26',
    },
    ichimoku: {
      nick: '구름', rule: '일목 구름 · 9/26/52', line: '가격이 구름 위에 있는 동안 들고 있어요.',
      rules: ['종가가 구름 양쪽 선보다 위면 보유.', '구름 안이나 아래로 들어오면 청산.'],
      risk: '진입이 느리고, 구름이 얇으면 잘못 나오는 일이 생겨요.',
      origin: '호소다 일목균형표 · 1969', from: '일목균형표. 호소다 고이치가 만들어 1969년에 책으로 냈어요(9·26·52).',
      users: '차트 분석가들이 널리 쓰고, 특히 일본에서 많이 써요.', proof: P_KO,
      fit: '추세인지 아닌지를 한눈에 보고 싶은 분.', good: '꾸준히 이어지는 추세.', ov: '구름 경계 (선행스팬 A · B)',
    },
    keltner: {
      nick: '채널', rule: '켈트너 채널 돌파', line: '채널 상단 위에서 사고, 중간선 아래에서 팔아요.',
      rules: ['종가가 상단(20일 EMA + 2 ATR) 위면 롱.', '20일 EMA 아래로 마감하면 청산.'],
      risk: '돌파가 바로 실패하면 빠르게 손실이 나요.',
      origin: '켈트너 채널 · 1960', from: 'Chester Keltner의 채널(『How to Make Money in Commodities』, 1960). 요즘 쓰는 EMA·ATR 방식이에요.',
      users: U_KO, proof: P_KO,
      fit: '힘이 확인된 뒤에만 따라붙고 싶은 분.', good: '조용하다가 강하게 움직이는 장.', ov: '상단 밴드 · EMA20',
    },
    psar: {
      nick: '파라볼릭', rule: '파라볼릭 SAR', line: '가격이 파라볼릭 스톱 위에 있는 동안 들고 있어요.',
      rules: ['가격이 스톱 위면 보유. 움직임이 이어질수록 스톱이 빨리 따라 올라와요.', '가격이 스톱에 닿으면 청산.'],
      risk: '늘 들어가 있거나 나와 있어서, 횡보장에서 손실이 쌓여요.',
      origin: '와일더 파라볼릭 SAR · 1978', from: 'J. Welles Wilder, 『New Concepts in Technical Trading Systems』, 1978의 파라볼릭 SAR(가속 0.02, 최대 0.20).',
      users: U_KO, proof: P_KO,
      fit: '스스로 조여 오는 추적 손절을 원하는 분.', good: '한 방향으로 빠르게 가는 장.', ov: '파라볼릭 스톱',
    },
    adx: {
      nick: '컴퍼스', rule: 'ADX 추세 · 14', line: '추세가 강하고 위쪽일 때만 들고 있어요.',
      rules: ['ADX가 25보다 높고 +DI가 −DI 위면 롱.', '+DI가 −DI 아래로 내려가면 청산.'],
      risk: '추세가 눈에 보인 뒤에야 들어가서 진입이 늦어요.',
      origin: '와일더 ADX · 1978', from: 'J. Welles Wilder, 『New Concepts in Technical Trading Systems』, 1978의 ADX와 방향성 지수. ADX 25 이상을 추세로 보는 건 널리 쓰는 관례예요.',
      users: U_KO, proof: P_KO,
      fit: '추세가 실제로 있을 때만 매매하고 싶은 분.', good: '뚜렷하고 강한 추세.', ov: '',
    },
    aroon: {
      nick: '새벽', rule: '아룬 · 25', line: '최근 고점이 최근 저점보다 더 가까운 동안 들고 있어요.',
      rules: ['아룬 업이 아룬 다운 위면 보유(25일).', '아래로 내려가면 청산.'],
      risk: '박스권에서는 두 선이 자주 엇갈려요.',
      origin: '찬드의 아룬 · 1995', from: 'Tushar Chande가 1995년에 소개한 아룬 지표(25일).',
      users: U_KO, proof: P_KO,
      fit: '신고가가 계속 나오는지만 간단히 보고 싶은 분.', good: '신고가를 꾸준히 만드는 장.', ov: '',
    },
    cryptoMom: {
      nick: '스프린터', rule: '크립토 모멘텀 · 4주', line: '가격이 4주 전보다 높은 동안 들고 있어요.',
      rules: ['종가가 28일 전 종가보다 높으면 보유.', '낮으면 청산.'],
      risk: '보는 기간이 짧아 자주 뒤집히고, 그때마다 수수료를 내요.',
      origin: '암호화폐 모멘텀 연구 · 2021', from: 'Liu·Tsyvinski, 「Risks and Returns of Cryptocurrency」, Review of Financial Studies, 2021. 암호화폐에 단기 시계열 모멘텀이 있다고 보고해요.',
      users: '학술 연구 결과이고, 알려진 펀드 전략은 아니에요.',
      proof: '암호화폐 수익률을 직접 다룬 논문이에요. 워킹페이퍼 판은 비트코인의 한 주 수익률이 다음 1~4주 수익률을 예측한다고 보고해요. 4주라는 기간과 매일 확인하는 방식은 논문이 아니라 Moa가 정했어요.',
      fit: '암호화폐 자체로 연구된 모멘텀 규칙을 원하는 분.', good: '몇 주씩 이어지는 상승.', ov: '4주 수익률 (0 위면 보유)',
    },
    rsi2: {
      nick: '스냅', rule: 'RSI(2) 눌림목', line: '상승 추세에서 이틀짜리 급락을 사고, 반등에 팔아요.',
      rules: ['200일 평균 위이고 RSI(2)가 5 미만이면 매수.', '종가가 5일 평균 위로 올라오면 매도.'],
      risk: '손절이 없어요. 계속 떨어지면 반등할 때까지 들고 있어요.',
      origin: '코너스 RSI(2) · 2008', from: 'Larry Connors·Cesar Alvarez, 『Short Term Trading Strategies That Work』, 2008의 2일 RSI 전략.',
      users: '주가지수 단기 매매자들이 널리 써요.', proof: '저자들이 미국 주가지수로 한 자체 검증과 함께 공개했어요. 독립적인 학술 검증은 없고, 암호화폐는 범위 밖이에요.',
      fit: '큰 추세가 위일 때만, 눌림에 짧게 사고 싶은 분.', good: '빠른 눌림이 섞인 상승장.', ov: 'MA5 · MA200',
    },
    double7: {
      nick: '더블세븐', rule: '더블 세븐', line: '상승 추세에서 7일 저가에 사고, 7일 고가에 팔아요.',
      rules: ['200일 평균 위이고 종가가 7일 중 가장 낮으면 매수.', '종가가 7일 중 가장 높으면 매도.'],
      risk: '손절이 없어요. 7일 고가가 나올 때까지 하락을 견뎌야 해요.',
      origin: '코너스 더블 세븐 · 2008', from: 'Larry Connors·Cesar Alvarez, 『Short Term Trading Strategies That Work』, 2008의 “Double 7’s” 전략.',
      users: '주가지수 단기 매매자들이 널리 써요.', proof: '저자들이 미국 주가지수로 한 자체 검증과 함께 공개했어요. 독립적인 학술 검증은 없고, 암호화폐는 범위 밖이에요.',
      fit: '상승 추세 안에서 아주 단순하게 눌림을 사고 싶은 분.', good: '주 단위로 오르내리는 상승장.', ov: 'MA200',
    },
  },
};

/** One field of every added rule, for spreading into i18n's per-field maps. */
export function more<K extends keyof RuleText>(lang: 'en' | 'ko', key: K): Record<MoreRule, RuleText[K]> {
  return Object.fromEntries(Object.entries(RULE_TEXT[lang]).map(([id, v]) => [id, v[key]])) as Record<MoreRule, RuleText[K]>;
}
