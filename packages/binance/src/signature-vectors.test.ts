/**
 * Signature vectors against the official connector (TASKS M0-03, SPEC §12).
 *
 * The connector (@binance-web3/wallet 12.3.0 → @binance-web3/common 1.1.0) builds and signs each
 * request itself; an axios adapter captures what it would put on the wire. We then recompute
 * X-OC-SIGN with our own signer from the captured timestamp, method, wire path and body, and
 * require byte equality. Date is frozen so the vectors are fixed and recorded below; each pinned
 * signature was also reproduced with `openssl dgst -sha256 -hmac` (a third implementation).
 */
import { Web3Wallet } from '@binance-web3/wallet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatTimestamp, preHash, signPreHash } from './sign.js';

const API_KEY = 'vector-api-key';
const API_SECRET = 'vector-secret-key';
const FROZEN_TIME = Date.parse('2026-05-11T10:08:57.715Z');
// Public BSC USDT (SPEC §3.4) and a burn address; only signing inputs here.
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const DEAD = '0x000000000000000000000000000000000000dEaD';

interface Captured {
  method: string;
  url: string;
  body: string;
  timestamp: string;
  signature: string;
}

function connectorWithCapture() {
  const wallet = new Web3Wallet({
    configurationRestAPI: { apiKey: API_KEY, apiSecret: API_SECRET },
  });
  const rest = wallet.restAPI;
  const captured: Captured[] = [];
  const config = (rest as unknown as { configuration: { baseOptions: Record<string, unknown> } })
    .configuration;
  config.baseOptions.adapter = (request: {
    method?: string;
    url?: string;
    data?: unknown;
    headers: Record<string, unknown> & { get?: (name: string) => unknown };
  }) => {
    const header = (name: string) => String(request.headers.get?.(name) ?? request.headers[name]);
    captured.push({
      method: String(request.method).toUpperCase(),
      url: String(request.url),
      body: typeof request.data === 'string' ? request.data : '',
      timestamp: header('X-OC-TIMESTAMP'),
      signature: header('X-OC-SIGN'),
    });
    return Promise.resolve({
      data: '{"code":0,"msg":"success","data":null,"timestamp":0,"success":true}',
      status: 200,
      statusText: 'OK',
      headers: {},
      config: request,
    });
  };
  return { rest, captured };
}

function wirePath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

describe('X-OC-SIGN matches the official connector', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN_TIME);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cases: {
    name: string;
    call: (rest: ReturnType<typeof connectorWithCapture>['rest']) => Promise<unknown>;
    method: string;
    path: string;
    body: string;
    signature: string;
  }[] = [
    {
      name: 'GET RWA token list with query (getRwaTokenList)',
      call: (rest) => rest.getRwaTokenList({ binanceChainId: '56' }),
      method: 'GET',
      path: '/build/api/v1/dex/market/rwa/tokens?binanceChainId=56',
      body: '',
      signature: 'z9yvAt+inUMp+WJIStv9C7SQnFD7adhF531mAhtbW4g=',
    },
    {
      name: 'GET aggregated quote with RFQ wallet (getAggregatedQuote)',
      call: (rest) =>
        rest.getAggregatedQuote({
          binanceChainId: '56',
          amount: '5000000000000000000',
          fromTokenAddress: USDT,
          toTokenAddress: DEAD,
          userWalletAddress: DEAD,
        }),
      method: 'GET',
      path:
        '/build/api/v1/dex/aggregator/quote?binanceChainId=56&amount=5000000000000000000' +
        `&fromTokenAddress=${USDT}&toTokenAddress=${DEAD}&userWalletAddress=${DEAD}`,
      body: '',
      signature: '8hjHUniPWyAmkpXLCXwukgXw6qgqm0pc0a+ThkSCaOI=',
    },
    {
      name: 'GET with characters that need encoding (searchRwaToken)',
      call: (rest) => rest.searchRwaToken({ keyword: "McDonald's & Co 100%" }),
      method: 'GET',
      path: '/build/api/v1/dex/market/rwa/search?keyword=McDonald%27s+%26+Co+100%25',
      body: '',
      signature: 'ItArp4BZmZXsblB97cFGLo8Xo6PUvUF8Q1hk/vAXq7g=',
    },
    {
      name: 'POST JSON body (buildDeFiDepositTransaction)',
      call: (rest) =>
        rest.buildDeFiDepositTransaction({
          address: DEAD,
          investmentId: 'vector-investment',
          token: { tokenAddress: USDT, amount: '10' },
          simulate: true,
        }),
      method: 'POST',
      path: '/build/api/v1/defi/transaction/deposit',
      body: `{"address":"${DEAD}","investmentId":"vector-investment","token":{"tokenAddress":"${USDT}","amount":"10"},"simulate":true}`,
      signature: 'XFVcPdOIEIRUHdeHZCfSMstJfn4lTvSmko9b04iIpE8=',
    },
    {
      name: 'POST B402 envelope body (getB402SupportedConfigurationsV2)',
      call: (rest) => rest.getB402SupportedConfigurationsV2({ body: {} }),
      method: 'POST',
      path: '/build/api/v2/b402/supported',
      body: '{"body":{}}',
      signature: 'gzsmHn+pBB9sYYtwGaV6qaIbB+tfF35hnPQxfp5+x3E=',
    },
  ];

  for (const vector of cases) {
    it(vector.name, async () => {
      const { rest, captured } = connectorWithCapture();
      await vector.call(rest);
      expect(captured).toHaveLength(1);
      const wire = captured[0]!;
      expect(wire.timestamp).toBe(formatTimestamp(FROZEN_TIME));
      expect(wire.method).toBe(vector.method);
      expect(wirePath(wire.url)).toBe(vector.path);
      expect(wire.body).toBe(vector.body);

      const ours = signPreHash(
        API_SECRET,
        preHash({
          timestamp: wire.timestamp,
          method: wire.method,
          requestPath: vector.path,
          body: wire.body,
        }),
      );
      expect(ours).toBe(wire.signature);
      expect(ours).toBe(vector.signature);
    });
  }

  it('documents a connector anomaly: GET /order/{orderId} also signs a JSON body', async () => {
    const { rest, captured } = connectorWithCapture();
    await rest.getRfqOrderStatus({ orderId: 'vector-order' });
    const wire = captured[0]!;
    expect(wire.method).toBe('GET');
    expect(wirePath(wire.url)).toBe('/build/api/v1/dex/aggregator/order/vector-order');
    expect(wire.body).toBe('{"orderId":"vector-order"}');
    // Our signer still reproduces the connector's bytes, but our client never sends GET bodies.
    const ours = signPreHash(
      API_SECRET,
      preHash({
        timestamp: wire.timestamp,
        method: 'GET',
        requestPath: wirePath(wire.url),
        body: wire.body,
      }),
    );
    expect(ours).toBe(wire.signature);
  });
});

describe('pre-hash string from the docs', () => {
  it('matches the GET example in llms-full.txt § Authentication › 3.1 (L223)', () => {
    expect(
      preHash({
        timestamp: '2026-05-11T10:08:57.715Z',
        method: 'GET',
        requestPath: '/build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT',
        body: '',
      }),
    ).toBe('2026-05-11T10:08:57.715ZGET/build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT');
  });

  it('uppercases the method', () => {
    expect(preHash({ timestamp: 't', method: 'post', requestPath: '/p', body: '{}' })).toBe(
      'tPOST/p{}',
    );
  });
});
