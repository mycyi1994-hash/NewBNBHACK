// What the app says about the spread hunter (src/spread.ts). No published source: it is Moa's own rule, and its only
// evidence is the gap history this server has recorded.
import type { RuleText } from './ruleText.ts';

export type SpreadTextRule = 'spread';

export const SPREAD_TEXT: Record<'en' | 'ko', Record<SpreadTextRule, RuleText>> = {
  en: {
    spread: {
      nick: 'Spread Hunter', rule: 'HSKSwap discount · round trip', line: 'Buys on HSKSwap when it is cheaper than HashKey Global by more than a round trip costs; sells back on HSKSwap once the discount closes.',
      rules: ['Pool price under HashKey Global by more than 0.6% plus the pool’s price impact: buy on HSKSwap.', 'Pool price back at or over HashKey Global: sell on HSKSwap.'],
      risk: 'It holds the coin while it waits for the discount to close, so a falling market can cost more than the discount was worth. Gaps can stay open for days.',
      origin: 'Moa’s own rule', from: 'Moa’s rule on the HSKSwap price against HashKey Global (Gate when HashKey Global does not answer), recorded by this server every 5 minutes.',
      users: 'Only Moa. No record of anyone else running it.',
      proof: 'No published test. The only evidence is the gap history this server has recorded, and the past result appears only once a day of records has built up.',
      fit: 'You want to buy the coin cheaper than the exchange price and accept holding it for a while.', good: 'A thin pool that lags the exchange and catches up.', ov: '',
    },
  },
  ko: {
    spread: {
      nick: '스프레드 헌터', rule: 'HSKSwap 할인 · 왕복', line: 'HSKSwap이 HashKey Global보다 왕복 비용 이상 싸면 사고, 차이가 닫히면 HSKSwap에서 다시 팔아요.',
      rules: ['풀 가격이 HashKey Global보다 0.6%와 풀 가격 영향을 더한 것보다 더 싸면 HSKSwap에서 사요.', '풀 가격이 HashKey Global과 같아지거나 더 비싸지면 HSKSwap에서 팔아요.'],
      risk: '차이가 닫힐 때까지 코인을 들고 있어서, 그사이 시장이 떨어지면 할인보다 더 잃을 수 있어요. 차이가 며칠씩 안 닫히기도 해요.',
      origin: 'Moa 자체 규칙', from: 'HSKSwap 가격과 HashKey Global 가격(답이 없으면 Gate)을 이 서버가 5분마다 기록해서 판단해요.',
      users: 'Moa만 써요. 다른 곳에서 쓴 기록은 없어요.',
      proof: '공개된 검증은 없어요. 이 서버가 기록한 가격 차이가 유일한 근거이고, 기록이 하루 쌓인 뒤부터 지난 결과를 보여 줘요.',
      fit: '코인을 거래소보다 싸게 사고, 잠시 들고 있어도 괜찮은 분.', good: '풀이 거래소를 늦게 따라가다 따라잡을 때.', ov: '',
    },
  },
};
