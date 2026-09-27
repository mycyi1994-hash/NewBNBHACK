import { describe, expect, it } from 'vitest';
import {
  RWA_DYNAMIC_V2_URL,
  fetchStockQuote,
  parseRwaDynamic,
  stockQuotesByTicker,
} from './stock-price.js';

/** The response example in the official skill (binance-tokenized-securities-info, API 5). */
const DOC_EXAMPLE = {
  code: '000000',
  data: {
    symbol: '<TOKEN_SYMBOL_ON>',
    ticker: '<UNDERLYING_TICKER>',
    tokenInfo: { price: '310.384196924055952519', sharesMultiplier: '1.001084338309087472' },
    stockInfo: { price: null, priceHigh52w: '328.83', priceLow52w: '140.53' },
    statusInfo: { openState: null, marketStatus: null, reasonCode: null },
  },
  success: true,
};

const withPrice = (price: unknown) => ({
  ...DOC_EXAMPLE,
  data: { ...DOC_EXAMPLE.data, stockInfo: { ...DOC_EXAMPLE.data.stockInfo, price } },
});

describe('parseRwaDynamic', () => {
  it('reads a null stock price outside trading hours (the documented example)', () => {
    expect(parseRwaDynamic(DOC_EXAMPLE)).toEqual({ ok: true, stockPrice: null });
  });

  it('reads a decimal stock price', () => {
    expect(parseRwaDynamic(withPrice('224.87'))).toEqual({ ok: true, stockPrice: '224.87' });
  });

  it('rejects error envelopes, missing stockInfo and odd prices', () => {
    expect(parseRwaDynamic({ code: '000002', success: false })).toEqual({
      ok: false,
      error: 'code "000002"',
    });
    expect(parseRwaDynamic({ code: '000000', success: true, data: {} })).toEqual({
      ok: false,
      error: 'no stockInfo',
    });
    expect(parseRwaDynamic({ code: '000000', success: true, data: null })).toMatchObject({
      ok: false,
    });
    expect(parseRwaDynamic(withPrice(224.87))).toEqual({
      ok: false,
      error: 'unexpected stockInfo.price 224.87',
    });
    expect(parseRwaDynamic('nope')).toEqual({ ok: false, error: 'not a JSON object' });
  });
});

describe('fetchStockQuote', () => {
  const ADDRESS = '0x02fc0000000000000000000000000000000007436';

  it('calls the documented endpoint with chainId and contractAddress', async () => {
    const seen: string[] = [];
    const fake = (input: string | URL | Request, init?: RequestInit) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity');
      return Promise.resolve(new Response(JSON.stringify(withPrice('224.87'))));
    };
    expect(await fetchStockQuote(ADDRESS, { fetch: fake })).toEqual({
      ok: true,
      stockPrice: '224.87',
    });
    expect(seen).toEqual([`${RWA_DYNAMIC_V2_URL}?chainId=56&contractAddress=${ADDRESS}`]);
  });

  it('turns HTTP errors, an empty WAF 202 and network failures into errors', async () => {
    const respond = (response: Response) => () => Promise.resolve(response);
    expect(
      await fetchStockQuote(ADDRESS, { fetch: respond(new Response('', { status: 403 })) }),
    ).toEqual({ ok: false, error: 'HTTP 403' });
    expect(
      await fetchStockQuote(ADDRESS, { fetch: respond(new Response('', { status: 202 })) }),
    ).toEqual({ ok: false, error: 'HTTP 202, body is not JSON' });
    const offline = () => Promise.reject(new TypeError('fetch failed'));
    expect(await fetchStockQuote(ADDRESS, { fetch: offline })).toEqual({
      ok: false,
      error: 'fetch failed',
    });
  });
});

describe('stockQuotesByTicker', () => {
  it('asks once per ticker and shares the answer across issuers', async () => {
    const asked: string[] = [];
    const quote = (address: string) => {
      asked.push(address);
      return Promise.resolve({
        ok: true as const,
        stockPrice: address === '0xb' ? '224.87' : null,
      });
    };
    const result = await stockQuotesByTicker(
      [
        { ticker: 'NVDA', address: '0xb' },
        { ticker: 'NVDA', address: '0xo' },
        { ticker: 'AAPL', address: '0xa' },
      ],
      quote,
    );
    expect(asked).toEqual(['0xb', '0xa']);
    expect(result.get('NVDA')).toEqual({ ok: true, stockPrice: '224.87' });
    expect(result.get('AAPL')).toEqual({ ok: true, stockPrice: null });
  });
});
