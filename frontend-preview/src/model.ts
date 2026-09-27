export const ASSETS = [
  { ticker: 'NVDA', name: 'NVIDIA', letter: 'N' },
  { ticker: 'TSLA', name: 'Tesla', letter: 'T' },
  { ticker: 'MSFT', name: 'Microsoft', letter: 'M' },
  { ticker: 'QQQ', name: 'Nasdaq-100', letter: 'Q' },
] as const;
export type Ticker = (typeof ASSETS)[number]['ticker'];
export type Funding = 'interest' | 'contribution';
export type Receipt = {
  id: number;
  ticker: Ticker;
  funding: Funding;
  sourceCents: number;
  investedCents: number;
  carriedCents: number;
};
export type DemoState = {
  ticker: Ticker;
  funding: Funding;
  availableCents: number;
  carriedCents: number;
  receipts: Receipt[];
};
export const THRESHOLD_CENTS = 25;
export const initialState: DemoState = {
  ticker: 'NVDA',
  funding: 'interest',
  availableCents: 18,
  carriedCents: 3,
  receipts: [{
    id: 1, ticker: 'NVDA', funding: 'interest',
    sourceCents: 28, investedCents: 25, carriedCents: 3,
  }],
};
export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const remaining = (available: number) => Math.max(0, THRESHOLD_CENTS - available);
export const progress = (available: number) => Math.max(0, Math.min(100, available / THRESHOLD_CENTS * 100));

export function contributionCents(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents >= THRESHOLD_CENTS && cents <= 100_000 ? cents : null;
}

export type Action =
  | { type: 'asset'; ticker: Ticker }
  | { type: 'funding'; funding: Funding }
  | { type: 'accrue' }
  | { type: 'purchase'; expectedReceiptCount: number; contribution?: number }
  | { type: 'reset' };

export function demoReducer(state: DemoState, action: Action): DemoState {
  switch (action.type) {
    case 'asset': return { ...state, ticker: action.ticker };
    case 'funding': return { ...state, funding: action.funding };
    case 'accrue': return { ...state, availableCents: state.availableCents + 10 };
    case 'reset': return initialState;
    case 'purchase': {
      // Demo transactions use integer cents, and repeated confirmations cannot spend twice.
      if (action.expectedReceiptCount !== state.receipts.length) return state;
      const interest = state.funding === 'interest';
      const source = interest ? state.availableCents : action.contribution;
      if (source === undefined || !Number.isSafeInteger(source) || source < THRESHOLD_CENTS || source > 100_000) return state;
      const invested = interest ? THRESHOLD_CENTS : source;
      const carried = source - invested;
      const receipt: Receipt = {
        id: state.receipts[0].id + 1,
        ticker: state.ticker,
        funding: state.funding,
        sourceCents: source,
        investedCents: invested,
        carriedCents: carried,
      };
      return {
        ...state,
        availableCents: interest ? carried : state.availableCents,
        carriedCents: interest ? carried : state.carriedCents,
        receipts: [receipt, ...state.receipts],
      };
    }
  }
}
