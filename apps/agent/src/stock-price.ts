/**
 * Independent US stock price for the tape (DECISIONS Q-06, SPEC §5.5 v2). The Web3 API's RWA
 * `referencePrice` is the token price ÷ multiplier, so it cannot show a premium. The public bapi
 * RWA Dynamic V2 returns `stockInfo.price`, the US stock price, "May be `null` outside trading
 * hours". It is documented only in the official Skills Hub skill binance-tokenized-securities-info
 * (API 5); unauthenticated; the tape makes one call per ticker per run.
 */
export const RWA_DYNAMIC_V2_URL =
  'https://www.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai';

export type StockQuoteResult =
  | { ok: true; /** USD per share; null outside US trading hours. */ stockPrice: string | null }
  | { ok: false; error: string };

const DECIMAL = /^\d+(\.\d+)?$/;

/** Validates a Dynamic V2 body (`{ code: "000000", success: true, data.stockInfo.price }`). */
export function parseRwaDynamic(body: unknown): StockQuoteResult {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'not a JSON object' };
  const { code, success, data } = body as { code?: unknown; success?: unknown; data?: unknown };
  if (code !== '000000' || success !== true) {
    return { ok: false, error: `code ${JSON.stringify(code)}` };
  }
  const stockInfo =
    typeof data === 'object' && data !== null
      ? (data as { stockInfo?: { price?: unknown } | null }).stockInfo
      : undefined;
  if (!stockInfo) return { ok: false, error: 'no stockInfo' };
  const { price } = stockInfo;
  if (price === null) return { ok: true, stockPrice: null };
  if (typeof price === 'string' && DECIMAL.test(price)) return { ok: true, stockPrice: price };
  return { ok: false, error: `unexpected stockInfo.price ${JSON.stringify(price)}` };
}

export async function fetchStockQuote(
  contractAddress: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<StockQuoteResult> {
  const url = new URL(RWA_DYNAMIC_V2_URL);
  url.searchParams.set('chainId', '56');
  url.searchParams.set('contractAddress', contractAddress);
  try {
    const res = await (options.fetch ?? fetch)(url, {
      // The skill's example sends Accept-Encoding: identity.
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // An empty 202 is what a WAF challenge looks like (dx/LOG.md 2026-09-23 17:44).
      return { ok: false, error: `HTTP ${res.status}, body is not JSON` };
    }
    return parseRwaDynamic(body);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One call per ticker: every issuer's token of a ticker tracks the same stock. */
export async function stockQuotesByTicker(
  instruments: readonly { ticker: string; address: string }[],
  quote: (contractAddress: string) => Promise<StockQuoteResult>,
): Promise<Map<string, StockQuoteResult>> {
  const addressByTicker = new Map<string, string>();
  for (const i of instruments)
    if (!addressByTicker.has(i.ticker)) addressByTicker.set(i.ticker, i.address);
  const results = await Promise.all(
    [...addressByTicker].map(async ([ticker, address]) => [ticker, await quote(address)] as const),
  );
  return new Map(results);
}
