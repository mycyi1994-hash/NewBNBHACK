// What the app says about Moa AI (src/aiPilot.ts). No published source and no backtest: an AI model decides, inside
// limits fixed in code, and its only record is the one this server keeps from its first decision on.
import type { RuleText } from './ruleText.ts';

export type AiTextRule = 'aiPilot';

export const AI_TEXT: Record<'en' | 'ko', Record<AiTextRule, RuleText>> = {
  en: {
    aiPilot: {
      nick: 'Moa AI', rule: 'AI-decided share · 4h', line: 'Every 4 hours an AI model reads the coin’s numbers and sets how much of the budget to hold; code keeps the limits.',
      rules: ['When each 4-hour candle closes, the AI reads a snapshot of numbers (returns, averages, volatility, the pool against the exchange, the pool’s flow for HSK) and sets a share of the budget from 0% to 100%.', 'Code limits it: steps of 5%, at most 25 points a decision, changes under 10 points ignored, one decision per 4 hours; when anything is wrong it keeps the last share.'],
      risk: 'An AI model can be wrong, and nobody has tested this one on past prices: there is no backtest. It can hold the coin into a fall.',
      origin: 'AI · Moa', from: 'An AI model (Anthropic Claude) called by this server every 4 hours with numbers the app computes; the limits are in Moa’s code.',
      users: 'Only Moa. No record of anyone else running it.',
      proof: 'None. No backtest: a model’s past decisions cannot be replayed honestly. Its record starts with its first decision and is kept here.',
      fit: 'You want to try an AI deciding, with a small budget and your own limits.', good: 'Unknown: there is no record yet.', ov: '',
    },
  },
  ko: {
    aiPilot: {
      nick: 'Moa AI', rule: 'AI가 정하는 비중 · 4시간', line: '4시간마다 AI 모델이 코인의 숫자를 읽고 예산 중 얼마를 들고 있을지 정해요. 한도는 코드가 지켜요.',
      rules: ['4시간 캔들이 닫힐 때마다 AI가 숫자 묶음(수익률, 평균선, 변동성, 풀과 거래소의 차이, HSK는 풀의 매수·매도 흐름)을 읽고 예산의 0%~100% 사이 비중을 정해요.', '코드가 한도를 지켜요: 5% 단위, 한 번에 최대 25%p, 10%p보다 작은 변화는 무시, 4시간에 한 번. 뭔가 잘못되면 직전 비중을 그대로 둬요.'],
      risk: 'AI 모델은 틀릴 수 있고, 이 모델을 과거 가격으로 검증한 적이 없어요. 백테스트가 없어요. 떨어지는 장에서도 들고 있을 수 있어요.',
      origin: 'AI · Moa', from: '이 서버가 4시간마다 앱이 계산한 숫자로 AI 모델(Anthropic Claude)을 불러요. 한도는 Moa 코드에 있어요.',
      users: 'Moa만 써요. 다른 곳에서 쓴 기록은 없어요.',
      proof: '없어요. 모델의 지난 판단은 정직하게 다시 돌려볼 수 없어서 백테스트가 없어요. 첫 판단부터 여기 기록해요.',
      fit: '작은 예산과 내 한도 안에서 AI의 판단을 써 보고 싶은 분.', good: '아직 몰라요. 기록이 없어요.', ov: '',
    },
  },
};
