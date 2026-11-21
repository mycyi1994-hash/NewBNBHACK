// UI strings in English and Korean. Moa's own replies follow the language the user writes in.
// Tone: an exchange, not a chatbot. Labels are nouns, numbers lead, no greetings.
import { createContext, useContext } from 'react';

export type Lang = 'en' | 'ko';

const en = {
  navTrade: 'Trade', navAsk: 'Strategy', navBots: 'Bots',
  vaultNone: 'No vault · execution off',
  vaultOn: (addr: string, bal: string, left: string) => `Vault ${addr} · ${bal} USDT · $${left} left today`,
  cex: 'CEX', cexSub: 'HashKey Global', dex: 'DEX', dexSub: 'HSKSwap',
  perpetual: 'Perp', usdtMargined: 'USDT-margined',
  change24h: '24h change', mark: 'Mark', index: 'Index', high24h: '24h high', low24h: '24h low', vol24h: '24h volume',
  live: 'Live', orderBook: 'Order book', recentTrades: 'Trades', recentSwaps: 'Swaps',
  price: 'Price', size: 'Size (BTC)', time: 'Time', side: 'Side', amount: 'Amount', when: 'Age', buy: 'Buy', sell: 'Sell',
  spread: 'Spread', loadingCandles: 'Loading candles…', readingChain: 'Reading HSK Chain…',
  poolLine: 'Pool price, every swap in 24h', fewSwaps: 'Fewer than two swaps in 24h.', noSwaps: 'No swaps in 24h.',
  swaps24h: '24h swaps', block: 'Block', poolOf: (s: string) => `Pool ${s}`, poolUsdt: 'Pool USDT',
  dataNote: 'Data: HashKey Global public API, HSK Chain mainnet (177).',
  orderTitle: 'Strategy',
  instructions: 'Instructions',
  dockPlaceholder: 'Buy $10 of HSK every day for 2 weeks. Sell half if it drops 15%.',
  ask: 'Preview plan',
  askNote: 'You get a plan first. Trades run only when a message says “execute”.',
  starters: [
    { title: 'DCA', sub: 'Fixed amount on a schedule', prompt: 'Collect $10 of HSK every day for 2 weeks, sell half if it drops 15%' },
    { title: 'Stop loss', sub: 'Sell when price falls', prompt: 'If HSK falls 15%, sell half' },
    { title: 'Target', sub: 'Reach a quantity by a date', prompt: 'Accumulate 5,000 HSK by Dec 31 under 0.08, budget $400' },
    { title: 'Take profit', sub: 'Sell into strength', prompt: 'Buy $25 of ETH every week for 2 months, take a third at +30%, then stake idle USDT' },
  ],
  spreadTitle: 'HSKSwap vs spot', colAsset: 'Asset', colPool: 'Pool', colGap: 'vs spot',
  seesNote: 'Pool: HSKSwap. Spot: Gate.',
  vaultTitle: 'Vault', vaultContract: 'Contract', localFork: 'Local fork',
  withdraw: 'Withdrawals', ownerOnly: 'Owner only', execution: 'Execution', execRule: 'On “execute” only',
  heroTitle: 'New strategy',
  heroSub: 'Describe what to buy, how often and when to stop. You review the plan before anything runs.',
  heroPlaceholder: 'Collect 5,000 HSK by Dec 31, stop if it drops 15%…',
  replyPlaceholder: 'Add details, or say “execute”…', send: 'Send', you: 'You', started: 'Session',
  steps: { thinking: 'Reading message', market: 'Reading HSK Chain prices', plan: 'Building plan', execute: 'Sending trade to vault', writing: 'Writing reply' },
  plan: 'Plan preview', guardrails: 'Rules', needs: 'Missing:', createBot: 'Create bot', noPlan: 'No plan yet. Describe a strategy to see the steps here.',
  guard1: 'HSKSwap only, only the coins in this plan', guard2: 'Skips a buy when the pool trades far above spot', guard3: 'Nothing outside the plan without confirmation',
  executed: 'Filled on HSK Chain', notExecuted: 'Rejected',
  offline: 'Offline: AI server unreachable, parsed on this device.',
  tags: { accumulate: 'DCA', stopLoss: 'Stop', takeProfit: 'TP', earn: 'Yield' },
  bots: 'Bots', botsSub: 'One goal per bot.', newBot: 'New bot', noBots: 'No bots',
  noBotsSub: 'Create one from Strategy, e.g. “Buy $10 of HSK every day for 2 weeks”.',
  colBot: 'Bot', colGoal: 'Goal', colSpent: 'Spent', colStatus: 'Status',
  draft: 'Draft', created: 'Created', delete: 'Delete', overview: 'Overview', activity: 'Activity', goal: 'Goal',
  progress: 'Spent', spent: (a: string, b: string) => `$${a} of $${b}`, spentOpen: (a: string) => `$${a} so far`,
  nextRun: 'Next run', nextRunOff: 'Scheduled runs start when the vault is on HSK mainnet. Until then, say “execute” in Strategy to run a step.',
  limits: 'Vault limits', perTrade: 'Max per trade', perDay: 'Max per day', leftToday: 'Left today', balance: 'Balance', noVault: 'No vault on this server.',
  noTrades: 'No fills', noTradesSub: 'Fills for this bot show here with the HSK Chain transaction.',
  langLabel: 'KO',
  feedDown: 'Feed unavailable:',
  dexVsPerp: (price: string, pct: string) => `HSKSwap WBTC ${price} · ${pct} vs perp`,
};

const ko: typeof en = {
  navTrade: '트레이드', navAsk: '전략', navBots: '봇',
  vaultNone: '볼트 없음 · 실행 꺼짐',
  vaultOn: (addr, bal, left) => `볼트 ${addr} · ${bal} USDT · 오늘 남은 한도 $${left}`,
  cex: 'CEX', cexSub: 'HashKey Global', dex: 'DEX', dexSub: 'HSKSwap',
  perpetual: '무기한', usdtMargined: 'USDT 마진',
  change24h: '24h 변동', mark: '마크', index: '인덱스', high24h: '24h 고가', low24h: '24h 저가', vol24h: '24h 거래량',
  live: '실시간', orderBook: '호가', recentTrades: '체결', recentSwaps: '스왑',
  price: '가격', size: '수량 (BTC)', time: '시간', side: '구분', amount: '금액', when: '경과', buy: '매수', sell: '매도',
  spread: '스프레드', loadingCandles: '캔들 불러오는 중…', readingChain: 'HSK 체인 읽는 중…',
  poolLine: '풀 가격, 24시간 전체 스왑', fewSwaps: '24시간 스왑 2건 미만.', noSwaps: '24시간 스왑 없음.',
  swaps24h: '24h 스왑', block: '블록', poolOf: (s) => `풀 ${s}`, poolUsdt: '풀 USDT',
  dataNote: '데이터: HashKey Global 공개 API, HSK 체인 메인넷(177).',
  orderTitle: '전략',
  instructions: '지시',
  dockPlaceholder: 'HSK를 2주 동안 매일 10달러씩 매수. 15% 빠지면 절반 매도.',
  ask: '계획 미리보기',
  askNote: '먼저 계획을 보여줘요. 거래는 메시지에 “실행”이 있을 때만 해요.',
  starters: [
    { title: '분할매수', sub: '정해진 금액을 주기적으로', prompt: 'HSK를 2주 동안 매일 10달러씩 모아줘. 15% 빠지면 절반 팔아줘' },
    { title: '손절', sub: '가격이 떨어지면 매도', prompt: 'HSK가 15% 떨어지면 절반 팔아줘' },
    { title: '목표 수량', sub: '기한까지 수량 채우기', prompt: '12월 31일까지 HSK 5,000개를 0.08 이하로 모아줘. 예산은 400달러' },
    { title: '익절', sub: '오를 때 나눠 팔기', prompt: 'ETH를 두 달 동안 매주 25달러씩 사고, 30% 오르면 1/3 익절해줘. 남는 USDT는 예치해줘' },
  ],
  spreadTitle: 'HSKSwap vs 현물', colAsset: '자산', colPool: '풀', colGap: '현물 대비',
  seesNote: '풀: HSKSwap. 현물: Gate.',
  vaultTitle: '볼트', vaultContract: '컨트랙트', localFork: '로컬 포크',
  withdraw: '출금', ownerOnly: '소유자만', execution: '실행', execRule: '“실행”일 때만',
  heroTitle: '새 전략',
  heroSub: '무엇을, 얼마씩, 언제 멈출지 적어 주세요. 실행 전에 계획을 먼저 확인해요.',
  heroPlaceholder: '12월 31일까지 HSK 5,000개, 15% 빠지면 중단…',
  replyPlaceholder: '조건을 덧붙이거나 “실행”이라고 입력…', send: '보내기', you: '나', started: '세션',
  steps: { thinking: '메시지 읽는 중', market: 'HSK 체인 가격 조회 중', plan: '계획 작성 중', execute: '볼트로 거래 전송 중', writing: '답변 작성 중' },
  plan: '계획 미리보기', guardrails: '규칙', needs: '필요:', createBot: '봇 만들기', noPlan: '아직 계획이 없어요. 전략을 입력하면 단계가 여기에 나와요.',
  guard1: 'HSKSwap에서, 계획에 있는 코인만', guard2: '풀이 현물보다 많이 비싸면 매수 건너뜀', guard3: '계획 밖의 거래는 확인 후에만',
  executed: 'HSK 체인 체결', notExecuted: '거절됨',
  offline: '오프라인: AI 서버 연결 불가, 기기에서 해석함.',
  tags: { accumulate: '분할', stopLoss: '손절', takeProfit: '익절', earn: '예치' },
  bots: '봇', botsSub: '봇 하나에 목표 하나.', newBot: '새 봇', noBots: '봇 없음',
  noBotsSub: '전략에서 만들 수 있어요. 예: “HSK를 2주 동안 매일 10달러씩”.',
  colBot: '봇', colGoal: '목표', colSpent: '사용', colStatus: '상태',
  draft: '초안', created: '생성', delete: '삭제', overview: '개요', activity: '활동', goal: '목표',
  progress: '사용 금액', spent: (a, b) => `$${b} 중 $${a}`, spentOpen: (a) => `지금까지 $${a}`,
  nextRun: '다음 실행', nextRunOff: '볼트가 HSK 메인넷에 올라가면 예약 실행이 시작돼요. 그전에는 전략 화면에서 “실행”이라고 입력하면 한 단계를 실행해요.',
  limits: '볼트 한도', perTrade: '1회 최대', perDay: '하루 최대', leftToday: '오늘 남은 한도', balance: '잔고', noVault: '이 서버에 볼트 없음.',
  noTrades: '체결 없음', noTradesSub: '이 봇의 체결이 HSK 체인 거래와 함께 여기에 표시돼요.',
  langLabel: 'EN',
  feedDown: '시세 불러오기 실패:',
  dexVsPerp: (price, pct) => `HSKSwap WBTC ${price} · 무기한 대비 ${pct}`,
};

export const STRINGS = { en, ko };
export type Strings = typeof en;
export const LangContext = createContext<{ lang: Lang; t: Strings; setLang: (l: Lang) => void }>({ lang: 'en', t: en, setLang: () => {} });
export const useT = () => useContext(LangContext);

export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('moa.lang');
    if (saved === 'en' || saved === 'ko') return saved;
  } catch { /* storage unavailable */ }
  return typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
}
export function saveLang(l: Lang) {
  try { localStorage.setItem('moa.lang', l); } catch { /* storage unavailable */ }
}
