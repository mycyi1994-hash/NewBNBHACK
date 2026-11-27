// What the app says about the short-term agents: standard rules on hourly or 4-hour candles (see SHORT_INTERVAL in
// agents.ts). Each names its real source. Where that source is a daily rule, the text says this is Moa's shorter
// version and that nothing published tests it on these candles; the past results here are all there is.
import type { RuleText } from './ruleText.ts';

export type ShortTextRule = 'rsi2h' | 'rsi2q' | 'ema921h' | 'macd4h' | 'bollh' | 'rsih' | 'donch1h' | 'donch4h';

const U_EN = 'Short-term traders use these indicators on hourly and 4-hour charts. There is no record of an institution running this exact rule.';
const P_EN = 'No published test on hourly or 4-hour candles: Moa’s shorter version. The past results here (the last 90 days of hourly, or a year of 4-hour prices) are what you can check.';
const U_KO = '단기 매매자들이 1시간·4시간 차트에서 이 지표들을 써요. 이 규칙 그대로 운용하는 기관에 대한 기록은 없어요.';
const P_KO = '1시간·4시간 봉으로 공개 검증한 기록은 없어요. Moa가 짧게 바꾼 버전이에요. 여기 지난 결과(1시간봉 90일, 4시간봉 1년)로 확인하셔야 해요.';

export const SHORT_TEXT: Record<'en' | 'ko', Record<ShortTextRule, RuleText>> = {
  en: {
    rsi2h: {
      nick: 'Snap Hour', rule: 'RSI(2) pullback · 1h', line: 'Above its 200-hour average, buys a sharp hourly dip (RSI(2) under 10) and sells the bounce.',
      rules: ['Hourly close above the 200-hour average and RSI(2) under 10: buy.', 'Close above the 5-hour average: sell.'],
      risk: 'No stop: a dip that keeps falling is held until it bounces. Many small trades, each paying the fee.',
      origin: 'Connors RSI(2), on hourly candles', from: 'The 2-period RSI strategy of Larry Connors and Cesar Alvarez (“Short Term Trading Strategies That Work”, 2008), a daily rule, run here on hourly candles.',
      users: U_EN, proof: P_EN, fit: 'You want quick dip buys while the short trend is up.', good: 'A rising market with quick hourly dips.', ov: 'MA5 · MA200 (hours)',
    },
    rsi2q: {
      nick: 'Snap Four', rule: 'RSI(2) pullback · 4h', line: 'Above its 200-candle average, buys a sharp 4-hour dip (RSI(2) under 10) and sells the bounce.',
      rules: ['4-hour close above the 200-candle average and RSI(2) under 10: buy.', 'Close above the 5-candle average: sell.'],
      risk: 'No stop: a dip that keeps falling is held until it bounces.',
      origin: 'Connors RSI(2), on 4-hour candles', from: 'The 2-period RSI strategy of Larry Connors and Cesar Alvarez (2008), a daily rule, run here on 4-hour candles.',
      users: U_EN, proof: P_EN, fit: 'You want dip buys that last a day or two.', good: 'An uptrend with dips that recover within days.', ov: 'MA5 · MA200 (4-hour)',
    },
    ema921h: {
      nick: 'Dart', rule: 'EMA cross · 9/21 · 1h', line: 'Holds while the 9-hour average is above the 21-hour average.',
      rules: ['9-hour EMA above the 21-hour EMA: hold.', 'Below it: sell to cash.'],
      risk: 'In a sideways market it flips in and out every few hours and pays the fee each time.',
      origin: 'EMA 9/21 crossover', from: 'A common short-term crossover of two exponential averages with no single author; 9 and 21 are the usual settings.',
      users: U_EN, proof: 'A widely used chart signal with no published test of this exact rule. The past results here (the last 90 days of hourly prices) are what you can check.', fit: 'You want to ride short moves and step aside quickly.', good: 'Clean moves that last a day or more.', ov: 'EMA9 · EMA21 (hours)',
    },
    macd4h: {
      nick: 'Pulse Four', rule: 'MACD · 12/26/9 · 4h', line: 'Holds while MACD is above its signal line on 4-hour candles.',
      rules: ['4-hour MACD (12, 26) above its 9-period signal: hold.', 'Below it: sell to cash.'],
      risk: 'It reacts late and gives back part of each move before it exits.',
      origin: 'Gerald Appel’s MACD, on 4-hour candles', from: 'MACD, created by Gerald Appel in the late 1970s with its standard 12, 26, 9 settings, run here on 4-hour candles.',
      users: U_EN, proof: P_EN, fit: 'You want swings of a few days without watching the chart.', good: 'Moves that last a few days.', ov: 'EMA12 · EMA26 (4-hour)',
    },
    bollh: {
      nick: 'Spring Hour', rule: 'Bollinger reversion · 1h', line: 'Buys when the hourly price drops under its lower Bollinger band, sells back at the middle.',
      rules: ['Hourly close under the lower band (20, 2σ): buy.', 'Back above the middle band: sell.'],
      risk: 'In a sharp fall the price can stay under the band and keep dropping after it buys.',
      origin: 'Bollinger Bands, on hourly candles', from: 'Built on John Bollinger’s bands (1980s), run here on hourly candles.',
      users: U_EN, proof: P_EN, fit: 'You want to buy short-lived panics and sell the calm.', good: 'A range that swings back and forth within days.', ov: 'Bollinger bands (hours)',
    },
    rsih: {
      nick: 'Bounce Hour', rule: 'RSI bounce · 30/55 · 1h', line: 'Buys after a sharp hourly drop (RSI under 30), sells on the way back (above 55).',
      rules: ['Hourly RSI(14) under 30: buy.', 'Back above 55: sell.'],
      risk: 'In a crash hourly RSI can stay low for days, so it can buy early and hold on the way down.',
      origin: 'Wilder’s RSI, on hourly candles', from: 'Built on the RSI of J. Welles Wilder (“New Concepts in Technical Trading Systems”, 1978), run here on hourly candles.',
      users: U_EN, proof: P_EN, fit: 'You want to buy sharp drops and sell the bounce within a day or two.', good: 'Choppy markets with quick rebounds.', ov: 'RSI 30 / 55 (hours)',
    },
    donch1h: {
      nick: 'Hare', rule: 'Breakout · 20/10 · 1h', line: 'Buys a new 20-hour high, sells on a 10-hour low.',
      rules: ['Close above the 20-hour high: buy.', 'Close below the 10-hour low: sell.'],
      risk: 'Most hourly breakouts fail, so it takes many small losses while it waits for a run.',
      origin: 'Turtle System 1, on hourly candles', from: 'System 1 of the Turtle traders (Richard Dennis and William Eckhardt, 1983), a daily rule, run here on hourly candles.',
      users: U_EN, proof: P_EN, fit: 'You want to catch fast runs and accept many small misses.', good: 'Sudden runs that keep going for hours.', ov: '20-hour high · 10-hour low',
    },
    donch4h: {
      nick: 'Fox', rule: 'Breakout · 20/10 · 4h', line: 'Buys a new 20-candle high on 4-hour candles, sells on a 10-candle low.',
      rules: ['Close above the 20-candle high (about 3 days): buy.', 'Close below the 10-candle low: sell.'],
      risk: 'Many breakouts fail; it pays small losses while it waits for a trend of a few days.',
      origin: 'Turtle System 1, on 4-hour candles', from: 'System 1 of the Turtle traders (Richard Dennis and William Eckhardt, 1983), a daily rule, run here on 4-hour candles.',
      users: U_EN, proof: P_EN, fit: 'You want to ride moves of a few days.', good: 'Trends that last several days.', ov: '20-candle high · 10-candle low (4-hour)',
    },
  },
  ko: {
    rsi2h: {
      nick: '스냅 아워', rule: 'RSI(2) 눌림목 · 1시간', line: '200시간 평균 위에서 1시간봉이 급하게 빠지면(RSI(2) 10 미만) 사고, 반등에 팔아요.',
      rules: ['1시간 종가가 200시간 평균 위이고 RSI(2)가 10 미만이면 매수.', '5시간 평균 위로 올라오면 매도.'],
      risk: '손절이 없어요. 계속 떨어지면 반등할 때까지 들고 있어요. 매매가 잦아 수수료가 쌓여요.',
      origin: '코너스 RSI(2), 1시간봉', from: 'Larry Connors·Cesar Alvarez의 2일 RSI 전략(2008). 원래는 하루 봉 규칙인데, 여기선 1시간봉으로 돌려요.',
      users: U_KO, proof: P_KO, fit: '짧은 상승 추세에서 빠른 눌림을 사고 싶은 분.', good: '1시간 단위로 빠르게 눌렸다 오르는 상승장.', ov: '5시간 · 200시간 평균선',
    },
    rsi2q: {
      nick: '스냅 포', rule: 'RSI(2) 눌림목 · 4시간', line: '4시간봉 200개 평균 위에서 급하게 빠지면(RSI(2) 10 미만) 사고, 반등에 팔아요.',
      rules: ['4시간 종가가 200개 평균 위이고 RSI(2)가 10 미만이면 매수.', '5개 평균 위로 올라오면 매도.'],
      risk: '손절이 없어요. 계속 떨어지면 반등할 때까지 들고 있어요.',
      origin: '코너스 RSI(2), 4시간봉', from: 'Larry Connors·Cesar Alvarez의 2일 RSI 전략(2008). 원래는 하루 봉 규칙인데, 여기선 4시간봉으로 돌려요.',
      users: U_KO, proof: P_KO, fit: '하루이틀짜리 눌림을 사고 싶은 분.', good: '며칠 안에 회복하는 눌림이 섞인 상승장.', ov: '4시간봉 5개 · 200개 평균선',
    },
    ema921h: {
      nick: '다트', rule: '평균선 교차 · 9/21 · 1시간', line: '9시간 평균선이 21시간 평균선 위에 있는 동안 들고 있어요.',
      rules: ['9시간 EMA가 21시간 EMA 위면 보유.', '아래로 내려가면 팔고 쉬어요.'],
      risk: '옆으로 기는 장에서는 몇 시간마다 사고팔아 수수료가 쌓여요.',
      origin: 'EMA 9/21 교차', from: '두 지수 평균선의 교차를 보는 흔한 단기 신호예요. 만든 사람이 따로 없고, 9와 21이 흔히 쓰는 값이에요.',
      users: U_KO, proof: '널리 쓰는 차트 신호지만 이 규칙 그대로 공개 검증한 기록은 없어요. 여기 지난 결과(1시간봉 90일)로 확인하셔야 해요.', fit: '짧은 흐름을 타고 빨리 빠지고 싶은 분.', good: '하루 이상 이어지는 깔끔한 흐름.', ov: '9시간 · 21시간 평균선',
    },
    macd4h: {
      nick: '펄스 포', rule: 'MACD · 12/26/9 · 4시간', line: '4시간봉 MACD가 시그널선 위에 있는 동안 들고 있어요.',
      rules: ['4시간 MACD(12, 26)가 9개 시그널선 위면 보유.', '아래로 내려가면 팔고 쉬어요.'],
      risk: '늦게 반응해서, 빠지기 전에 오른 몫을 일부 돌려줘요.',
      origin: 'Gerald Appel의 MACD, 4시간봉', from: 'Gerald Appel이 1970년대 후반에 만든 MACD(표준 12·26·9). 여기선 4시간봉으로 돌려요.',
      users: U_KO, proof: P_KO, fit: '차트를 계속 보지 않고 며칠짜리 흐름을 타고 싶은 분.', good: '며칠 이어지는 흐름.', ov: '4시간봉 12개 · 26개 평균선',
    },
    bollh: {
      nick: '스프링 아워', rule: '볼린저 역추세 · 1시간', line: '1시간봉이 볼린저 하단 아래로 빠지면 사고, 중간선으로 돌아오면 팔아요.',
      rules: ['1시간 종가가 하단(20, 2σ) 아래면 매수.', '중간선 위로 돌아오면 매도.'],
      risk: '급락장에선 하단 아래에 머물며 산 뒤에도 더 떨어질 수 있어요.',
      origin: '볼린저 밴드, 1시간봉', from: 'John Bollinger의 밴드(1980년대)를 1시간봉으로 돌려요.',
      users: U_KO, proof: P_KO, fit: '잠깐의 공포에 사고 진정되면 팔고 싶은 분.', good: '며칠 안에 오르내리는 박스권.', ov: '볼린저 밴드 (1시간)',
    },
    rsih: {
      nick: '바운스 아워', rule: 'RSI 반등 · 30/55 · 1시간', line: '1시간봉이 많이 떨어지면(RSI 30 아래) 사고, 회복하면(55 위) 팔아요.',
      rules: ['1시간 RSI(14)가 30 아래면 매수.', '55 위로 돌아오면 매도.'],
      risk: '폭락 땐 1시간 RSI가 며칠씩 낮게 머물러, 일찍 사서 떨어지는 동안 들고 있을 수 있어요.',
      origin: 'Wilder의 RSI, 1시간봉', from: 'J. Welles Wilder의 RSI(1978)를 1시간봉으로 돌려요.',
      users: U_KO, proof: P_KO, fit: '급락을 사서 하루이틀 안에 반등에 팔고 싶은 분.', good: '빠르게 되돌리는 출렁이는 장.', ov: 'RSI 30 / 55 (1시간)',
    },
    donch1h: {
      nick: '토끼', rule: '돌파 · 20/10 · 1시간', line: '20시간 신고가에 사고, 10시간 신저가에 팔아요.',
      rules: ['20시간 최고가 위로 마감하면 매수.', '10시간 최저가 아래로 마감하면 매도.'],
      risk: '1시간 돌파는 대부분 실패해서, 큰 흐름을 기다리는 동안 작은 손실이 잦아요.',
      origin: '터틀 시스템 1, 1시간봉', from: '터틀 트레이더의 시스템 1(Richard Dennis·William Eckhardt, 1983). 원래 하루 봉 규칙인데, 여기선 1시간봉으로 돌려요.',
      users: U_KO, proof: P_KO, fit: '빠른 급등을 잡고, 잦은 헛방은 감수하는 분.', good: '몇 시간씩 이어지는 급등.', ov: '20시간 고가 · 10시간 저가',
    },
    donch4h: {
      nick: '여우', rule: '돌파 · 20/10 · 4시간', line: '4시간봉 20개 신고가에 사고, 10개 신저가에 팔아요.',
      rules: ['4시간봉 20개(약 3일) 최고가 위로 마감하면 매수.', '10개 최저가 아래로 마감하면 매도.'],
      risk: '돌파가 자주 실패해서, 며칠짜리 흐름을 기다리는 동안 작은 손실을 내요.',
      origin: '터틀 시스템 1, 4시간봉', from: '터틀 트레이더의 시스템 1(Richard Dennis·William Eckhardt, 1983). 원래 하루 봉 규칙인데, 여기선 4시간봉으로 돌려요.',
      users: U_KO, proof: P_KO, fit: '며칠짜리 흐름을 타고 싶은 분.', good: '며칠 이어지는 추세.', ov: '4시간봉 20개 고가 · 10개 저가',
    },
  },
};
