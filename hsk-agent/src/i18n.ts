// UI strings in English and Korean. Moa's own replies follow the language the user writes in.
// Tone: an exchange, not a chatbot. Labels are nouns, numbers lead, no greetings. Jargon gets a tooltip.
import { createContext, useContext } from 'react';

export type Lang = 'en' | 'ko';

const en = {
  navTrade: 'Trade', navAsk: 'Moa', navBots: 'Bots', langLabel: 'KO',
  aiOnline: 'Online', aiOffline: 'Offline', newChat: 'New', close: 'Close', messageMoa: 'Message Moa', send: 'Send',

  // market
  cex: 'CEX', cexSub: 'HashKey Global', dex: 'DEX', dexSub: 'HSKSwap',
  perpetual: 'Perp', tipPerp: 'Perpetual futures contract on HashKey Global. Shown for reference; Moa trades spot on HSKSwap.',
  change24h: '24h change', mark: 'Mark price', index: 'Index price', high24h: '24h high', low24h: '24h low', vol24h: '24h volume',
  tipMark: 'The fair price the exchange uses for margin and liquidations.',
  tipIndex: 'Average spot price across major exchanges.',
  live: 'Live', orderBook: 'Order book', recentTrades: 'Trades', recentSwaps: 'Swaps',
  price: 'Price', size: 'Size (BTC)', time: 'Time', side: 'Side', amount: 'Amount', when: 'Age', buy: 'Buy', sell: 'Sell',
  spread: 'Spread', loadingCandles: 'Loading candles…', readingChain: 'Reading HSK Chain…',
  poolLine: 'Pool price, every swap in 24h', fewSwaps: 'Fewer than two swaps in 24h.', noSwaps: 'No swaps in 24h.',
  fewSwapsNote: (n: number) => `Only ${n} swap${n === 1 ? '' : 's'} in 24h. A pool price moves only when someone trades.`,
  swaps24h: '24h swaps', block: 'Block', poolOf: (s: string) => `Pool ${s}`, poolUsdt: 'Pool USDT',
  dataNote: 'Data: HashKey Global public API, HSK Chain mainnet (177).',
  feedDown: 'Feed unavailable:',
  dexVsPerp: (price: string, pct: string) => `HSKSwap BTC ${price} · ${pct} vs this perp`,
  spreadTitle: 'HSKSwap vs Gate', colAsset: 'Coin', colPool: 'HSKSwap', colGap: 'vs Gate',
  seesNote: 'HSKSwap: the price you get on HSK Chain. Gate: Gate.io spot price, for reference.',
  tipGate: 'Positive means HSKSwap is pricier than Gate.io right now.',

  // vault
  vaultTitle: 'Vault', vaultContract: 'Contract', localFork: 'Test vault',
  tipFork: 'Running on a local copy of HSK Chain for testing. No real money moves.',
  vaultNone: 'No vault · execution off', vaultDown: 'Vault unreachable · execution off',
  withdraw: 'Withdrawals', ownerOnly: 'Owner only', execution: 'Execution', execRule: '“execute” only',
  perTrade: 'Max per trade', perDay: 'Max per day', leftToday: 'Left today', balance: 'Balance', noVault: 'No vault on this server.',
  spentToday: 'Today',
  footRule: (per: string) => `Max $${per} a trade. Moa trades only when your message says “execute”.`,

  // assistant
  heroTitle: 'Tell Moa a goal',
  heroSub: 'Say what to buy, how often and when to stop. You see the plan before anything runs.',
  dockPlaceholder: 'Buy $10 of HSK every day for 2 weeks. Sell half if it drops 15%.',
  replyPlaceholder: 'Add details, or say “execute”…',
  starters: [
    { title: 'DCA', sub: 'Fixed amount on a schedule', prompt: 'Buy $10 of HSK every day for 2 weeks, sell half if it drops 15%' },
    { title: 'Target', sub: 'Reach a quantity by a date', prompt: 'Collect 5,000 HSK by Dec 31 under $0.08, budget $400' },
    { title: 'Take profit', sub: 'Sell into strength', prompt: 'Buy $25 of ETH every week for 2 months, sell a third at +30%' },
  ],
  protectTitle: 'How Moa protects you',
  protect1: (t: string, d: string) => `Your vault caps spending at $${t} a trade and $${d} a day.`,
  protect1none: 'Spending caps are set in your vault contract.',
  protect2: 'Nothing trades until your message says “execute”.',
  protect3: 'Only you can withdraw. Moa can only swap inside the vault.',
  steps: { thinking: 'Reading message', market: 'Reading HSK Chain prices', plan: 'Building plan', execute: 'Sending trade to vault', writing: 'Writing reply' },
  plan: 'Plan preview', needs: 'Missing:', createBot: 'Create bot', openBot: 'Open bot',
  runFirst: 'Run the first buy…', runFirstPrompt: 'Execute the first buy now',
  botCreated: 'Bot created.',
  planSteps: (n: number) => `${n} step${n === 1 ? '' : 's'}`,
  guard1: 'HSKSwap only, only the coins in this plan', guard2: 'Skips a buy when the pool trades far above Gate', guard3: 'Nothing outside the plan without confirmation',
  executed: 'Filled on HSK Chain', notExecuted: 'Rejected',
  paid: 'Paid', sold: 'Sold', received: 'Received', avgPrice: 'Price', poolFee: 'Pool fee', viewTx: 'Transaction',
  offline: 'Offline: AI server unreachable, parsed on this device.',
  tags: { accumulate: 'DCA', stopLoss: 'Stop', takeProfit: 'TP', earn: 'Yield' },

  // bots
  bots: 'Bots', botsSub: 'One goal per bot. Each fill links to its HSK Chain transaction.', newBot: '+ New bot', noBots: 'No bots yet',
  noBotsSub: 'Tell Moa a goal on the right, e.g. “Buy $10 of HSK every day for 2 weeks”.',
  colBot: 'Bot', colGoal: 'Goal', colSpent: 'Spent', colProgress: 'Progress', colStatus: 'Status',
  botsHint: 'Add another goal any time: tell Moa on the right.',
  draft: 'Draft', manual: 'Manual runs', created: 'Created', delete: 'Delete', goal: 'Goal', planSaved: 'Plan',
  progress: 'Spent', spent: (a: string, b: string) => `$${a} of $${b}`, spentOpen: (a: string) => `$${a} so far`,
  buysDone: (n: number, total: number) => `${n} of ${total} buys done`,
  timeline: 'Timeline',
  tlCreated: 'Bot created',
  tlFill: (side: string, paid: string, got: string, price: string) => `${side}: ${paid} → ${got} at $${price}`,
  tlNext: (usd: string, asset: string) => `Next: buy $${usd} of ${asset}. Runs when you say “execute” to Moa.`,
  tlStop: (frac: string, asset: string, price: string, pct: number, avg: string) => `Stop: sell ${frac} of ${asset} at $${price} or lower (${pct}% under your average $${avg}).`,
  tlStopWait: (pct: number) => `Stop: arms after the first fill, ${pct}% under your average price.`,
  tlTp: (frac: string, asset: string, price: string, pct: number) => `Take profit: sell ${frac} of ${asset} at $${price} or higher (+${pct}%).`,
  nextRunOff: 'Scheduled runs start when the vault is on HSK mainnet. Until then, each run happens when you say “execute” to Moa.',
  limits: 'Vault limits',
  half: 'half', third: 'a third', all: 'all',
};

const ko: typeof en = {
  navTrade: '트레이드', navAsk: 'Moa', navBots: '봇', langLabel: 'EN',
  aiOnline: '연결됨', aiOffline: '오프라인', newChat: '새로', close: '닫기', messageMoa: 'Moa에게 메시지', send: '보내기',

  cex: 'CEX', cexSub: 'HashKey Global', dex: 'DEX', dexSub: 'HSKSwap',
  perpetual: '무기한', tipPerp: 'HashKey Global의 무기한 선물. 참고용이며, Moa는 HSKSwap 현물로 거래해요.',
  change24h: '24h 변동', mark: '마크 가격', index: '인덱스 가격', high24h: '24h 고가', low24h: '24h 저가', vol24h: '24h 거래량',
  tipMark: '거래소가 증거금과 청산에 쓰는 공정 가격.',
  tipIndex: '주요 거래소 현물 가격의 평균.',
  live: '실시간', orderBook: '호가', recentTrades: '체결', recentSwaps: '스왑',
  price: '가격', size: '수량 (BTC)', time: '시간', side: '구분', amount: '금액', when: '경과', buy: '매수', sell: '매도',
  spread: '스프레드', loadingCandles: '캔들 불러오는 중…', readingChain: 'HSK 체인 읽는 중…',
  poolLine: '풀 가격, 24시간 전체 스왑', fewSwaps: '24시간 스왑 2건 미만.', noSwaps: '24시간 스왑 없음.',
  fewSwapsNote: (n) => `24시간 동안 스왑 ${n}건. 풀 가격은 누군가 거래할 때만 움직여요.`,
  swaps24h: '24h 스왑', block: '블록', poolOf: (s) => `풀 ${s}`, poolUsdt: '풀 USDT',
  dataNote: '데이터: HashKey Global 공개 API, HSK 체인 메인넷(177).',
  feedDown: '시세 불러오기 실패:',
  dexVsPerp: (price, pct) => `HSKSwap BTC ${price} · 이 무기한 대비 ${pct}`,
  spreadTitle: 'HSKSwap vs Gate', colAsset: '코인', colPool: 'HSKSwap', colGap: 'Gate 대비',
  seesNote: 'HSKSwap: HSK 체인에서 실제로 사는 가격. Gate: Gate.io 현물 가격(참고용).',
  tipGate: '양수면 지금 HSKSwap이 Gate.io보다 비싸다는 뜻이에요.',

  vaultTitle: '볼트', vaultContract: '컨트랙트', localFork: '테스트 볼트',
  tipFork: '테스트용 HSK 체인 로컬 복사본에서 돌아가요. 실제 돈은 움직이지 않아요.',
  vaultNone: '볼트 없음 · 실행 꺼짐', vaultDown: '볼트 응답 없음 · 실행 꺼짐',
  withdraw: '출금', ownerOnly: '소유자만', execution: '실행', execRule: '“실행”일 때만',
  perTrade: '1회 최대', perDay: '하루 최대', leftToday: '오늘 남은 한도', balance: '잔고', noVault: '이 서버에 볼트 없음.',
  spentToday: '오늘',
  footRule: (per) => `1회 최대 $${per}. 메시지에 “실행”이 있을 때만 거래해요.`,

  heroTitle: 'Moa에게 목표를 말해 보세요',
  heroSub: '무엇을, 얼마씩, 언제 멈출지 말하면 돼요. 실행 전에 계획을 먼저 보여드려요.',
  dockPlaceholder: 'HSK를 2주 동안 매일 10달러씩 매수. 15% 빠지면 절반 매도.',
  replyPlaceholder: '조건을 덧붙이거나 “실행”이라고 입력…',
  starters: [
    { title: '분할매수', sub: '정해진 금액을 주기적으로', prompt: 'HSK를 2주 동안 매일 10달러씩 사고, 15% 빠지면 절반 팔아줘' },
    { title: '목표 수량', sub: '기한까지 수량 채우기', prompt: '12월 31일까지 HSK 5,000개를 0.08달러 이하로 모아줘. 예산은 400달러' },
    { title: '익절', sub: '오를 때 나눠 팔기', prompt: 'ETH를 두 달 동안 매주 25달러씩 사고, 30% 오르면 1/3 팔아줘' },
  ],
  protectTitle: 'Moa가 지키는 것',
  protect1: (t, d) => `볼트가 1회 $${t}, 하루 $${d}까지만 쓰게 막아요.`,
  protect1none: '지출 한도는 볼트 컨트랙트에 정해져요.',
  protect2: '메시지에 “실행”이 있기 전에는 아무것도 거래하지 않아요.',
  protect3: '출금은 나만 할 수 있어요. Moa는 볼트 안에서 스왑만 해요.',
  steps: { thinking: '메시지 읽는 중', market: 'HSK 체인 가격 조회 중', plan: '계획 작성 중', execute: '볼트로 거래 전송 중', writing: '답변 작성 중' },
  plan: '계획 미리보기', needs: '필요:', createBot: '봇 만들기', openBot: '봇 열기',
  runFirst: '첫 매수 실행하기…', runFirstPrompt: '첫 매수 지금 실행해줘',
  botCreated: '봇을 만들었어요.',
  planSteps: (n) => `${n}단계`,
  guard1: 'HSKSwap에서, 계획에 있는 코인만', guard2: '풀이 Gate보다 많이 비싸면 매수 건너뜀', guard3: '계획 밖의 거래는 확인 후에만',
  executed: 'HSK 체인 체결', notExecuted: '거절됨',
  paid: '지불', sold: '매도', received: '받음', avgPrice: '체결가', poolFee: '풀 수수료', viewTx: '거래 기록',
  offline: '오프라인: AI 서버 연결 불가, 기기에서 해석함.',
  tags: { accumulate: '분할', stopLoss: '손절', takeProfit: '익절', earn: '예치' },

  bots: '봇', botsSub: '봇 하나에 목표 하나. 체결마다 HSK 체인 거래 기록이 붙어요.', newBot: '+ 새 봇', noBots: '아직 봇이 없어요',
  noBotsSub: '오른쪽 Moa에게 목표를 말해 보세요. 예: “HSK를 2주 동안 매일 10달러씩”.',
  colBot: '봇', colGoal: '목표', colSpent: '사용', colProgress: '진행', colStatus: '상태',
  botsHint: '다른 목표도 언제든 오른쪽 Moa에게 말하면 돼요.',
  draft: '초안', manual: '수동 실행', created: '생성', delete: '삭제', goal: '목표', planSaved: '계획',
  progress: '사용 금액', spent: (a, b) => `$${b} 중 $${a}`, spentOpen: (a) => `지금까지 $${a}`,
  buysDone: (n, total) => `${total}회 중 ${n}회 매수 완료`,
  timeline: '타임라인',
  tlCreated: '봇 생성',
  tlFill: (side, paid, got, price) => `${side}: ${paid} → ${got}, 체결가 $${price}`,
  tlNext: (usd, asset) => `다음: ${asset} $${usd} 매수. Moa에게 “실행”이라고 하면 실행돼요.`,
  tlStop: (frac, asset, price, pct, avg) => `손절: $${price} 이하가 되면 ${asset} ${frac} 매도 (평단 $${avg}보다 ${pct}% 아래).`,
  tlStopWait: (pct) => `손절: 첫 체결 후 평단보다 ${pct}% 아래로 설정돼요.`,
  tlTp: (frac, asset, price, pct) => `익절: $${price} 이상이 되면 ${asset} ${frac} 매도 (+${pct}%).`,
  nextRunOff: '볼트가 HSK 메인넷에 올라가면 예약 실행이 시작돼요. 그전에는 Moa에게 “실행”이라고 할 때마다 한 번씩 실행돼요.',
  limits: '볼트 한도',
  half: '절반', third: '1/3', all: '전부',
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
