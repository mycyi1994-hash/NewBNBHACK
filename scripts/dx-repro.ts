/**
 * pnpm dx:repro — runs each reproducible finding of dx/findings against the platform as it is
 * today, so the DX report quotes current behaviour with a time (DX_PROTOCOL §3.3, REPLAN §7).
 *
 * Read-only: nothing is signed or sent. Quotes and builds are what a wallet asks before it signs;
 * the DeFi and swap builds name a fresh address made for this run, which holds nothing. The
 * rate-limit finding sends six quote requests in half a second on purpose (one burst).
 * Findings that need a Binance Web3 API key, or `baw`, are SKIPPED without one.
 *
 * Flags: --only <slug,slug> · --baw <path to the baw executable> · --list
 * Exit: 0 every selected finding ran or was skipped · 1 a repro could not run · 2 usage.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchRwaTokens, type RwaToken } from '@yieldvest/agent';
import {
  BinanceApiError,
  BinanceClient,
  RateLimiter,
  buildDeFi,
  buildSwap,
  getQuote,
  listDeFiInvestments,
} from '@yieldvest/binance';
import { BSC_USDT } from '@yieldvest/chain';
import { loadConfig, type Config } from '@yieldvest/config';
import { UNISWAP_V4_BSC } from '@yieldvest/rwa-lp';
import { toEventSelector, toHex, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseFlags } from './args';
import {
  approvesUnlimited,
  logRangeRefused,
  ondoMinimum,
  oneCodeTwoCauses,
  quoteExpired,
  referenceIsDerived,
  signedOutLooksSuccessful,
  slidingWindow429,
  tickersRepeatPerChain,
  wafChallenge,
  type ApiAnswer,
  type PublicRwaEntry,
  type Verdict,
} from './dx-repro-checks';

interface Context {
  config: Config;
  /** A signed client, or null without an API key. */
  client: BinanceClient | null;
  /** The `baw` executable, if one was given or found. */
  baw: string | null;
  /** An address made for this run: no balance, no position, never funded. */
  empty: `0x${string}`;
}

interface Repro {
  slug: string;
  /** The dx/LOG.md entry it reproduces (heading time, UTC). */
  logEntry: string;
  needs: 'nothing' | 'binance-key' | 'baw';
  run: (ctx: Context) => Promise<Verdict>;
}

const DOCS_FULL = 'https://web3.binance.com/en/dev-docs/llms-full.txt';
const PUBLIC_RWA_LIST =
  'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1';
const PUBLIC_BSC_RPC = 'https://bsc-dataseed.bnbchain.org';
const INITIALIZE = toEventSelector(
  'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
);

/** What a Binance Web3 API call answered, success or error. */
async function answerOf(call: () => Promise<{ httpStatus: number }>): Promise<ApiAnswer> {
  try {
    const res = await call();
    return { ok: true, httpStatus: res.httpStatus, code: 0, msg: 'success' };
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    // The envelope's code may arrive as a number or a numeric string.
    const code = error.code === null || error.code === undefined ? null : Number(error.code);
    return { ok: false, httpStatus: error.httpStatus, code, msg: error.msg };
  }
}

function signedClient(config: Config, limiter?: RateLimiter): BinanceClient | null {
  if (!config.binance.apiKey || !config.binance.apiSecret) return null;
  return new BinanceClient({
    baseUrl: config.binance.baseUrl,
    apiKey: config.binance.apiKey,
    apiSecret: config.binance.apiSecret,
    region: config.regionTag ?? null,
    ...(limiter ? { limiter } : {}),
  });
}

/** The registry's BSC token with this symbol (stock addresses are never constants, D-07). */
async function token(client: BinanceClient, symbol: string): Promise<RwaToken> {
  const found = (await fetchRwaTokens(client)).find(
    (t) => t.tokenSymbol === symbol && t.binanceChainId === '56',
  );
  if (!found) throw new Error(`${symbol} is not in the RWA token list`);
  return found;
}

async function rpc<T>(
  method: string,
  params: unknown[],
): Promise<{ result?: T; error?: { code?: number; message?: string } }> {
  const res = await fetch(PUBLIC_BSC_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
}

const REPROS: readonly Repro[] = [
  {
    slug: 'docs-waf-challenge',
    logEntry: '2026-09-23 17:44',
    needs: 'nothing',
    run: async () => {
      const res = await fetch(DOCS_FULL, { headers: { 'user-agent': 'curl/8.5.0' } });
      const body = await res.arrayBuffer();
      return wafChallenge({
        status: res.status,
        wafAction: res.headers.get('x-amzn-waf-action'),
        bodyBytes: body.byteLength,
      });
    },
  },
  {
    slug: 'rwa-list-tickers-per-chain',
    logEntry: '2026-10-01 06:04',
    needs: 'nothing',
    run: async () => {
      const res = await fetch(PUBLIC_RWA_LIST, { headers: { 'accept-encoding': 'identity' } });
      const json = (await res.json()) as { data?: PublicRwaEntry[] };
      return tickersRepeatPerChain(json.data ?? [], 'NVDA');
    },
  },
  {
    slug: 'bsc-public-rpc-log-range',
    logEntry: '2026-09-30 02:10',
    needs: 'nothing',
    run: async () => {
      const head = await rpc<string>('eth_blockNumber', []);
      if (!head.result) throw new Error(`eth_blockNumber: ${head.error?.message ?? 'no answer'}`);
      const latest = BigInt(head.result);
      const blocks = 200;
      const logs = await rpc<unknown[]>('eth_getLogs', [
        {
          address: UNISWAP_V4_BSC.poolManager,
          topics: [INITIALIZE],
          fromBlock: toHex(latest - BigInt(blocks - 1)),
          toBlock: toHex(latest),
        },
      ]);
      return logRangeRefused(blocks, {
        ...(logs.error ? { error: logs.error } : {}),
        resultCount: logs.result?.length ?? 0,
      });
    },
  },
  {
    slug: 'baw-status-signed-out',
    logEntry: '2026-10-01 06:19',
    needs: 'baw',
    run: (ctx) => {
      // A HOME that has never signed in; node runs baw's own entry file, so PATH is not needed.
      const home = mkdtempSync(path.join(tmpdir(), 'dx-repro-baw-'));
      try {
        const out = execFileSync(
          process.execPath,
          [realpathSync(ctx.baw ?? ''), 'wallet', 'status', '--json'],
          { encoding: 'utf8', timeout: 30_000, env: { HOME: home } },
        );
        return Promise.resolve(signedOutLooksSuccessful(JSON.parse(out) as unknown));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    slug: 'quote-id-expiry',
    logEntry: '2026-09-24 00:52',
    needs: 'binance-key',
    run: async (ctx) => {
      const client = ctx.client as BinanceClient;
      const nvdab = await token(client, 'NVDAB');
      const amount = parseUnits('5', 18);
      const quote = await getQuote(client, {
        fromToken: BSC_USDT,
        toToken: nvdab.tokenContractAddress,
        amount,
        userWalletAddress: ctx.empty,
      });
      const quoteId = quote.routes[0]?.quoteId;
      if (!quoteId) throw new Error('the quote returned no route');
      const age = 35;
      await sleep(age * 1000);
      const swap = await answerOf(async () => {
        await buildSwap(client, {
          quoteId,
          fromToken: BSC_USDT,
          toToken: nvdab.tokenContractAddress,
          amount,
          userWalletAddress: ctx.empty,
          slippagePercent: '0.5',
        });
        return { httpStatus: 200 };
      });
      return quoteExpired(age, swap);
    },
  },
  {
    slug: 'defi-40484-two-causes',
    logEntry: '2026-09-24 00:49',
    needs: 'binance-key',
    run: async (ctx) => {
      const client = ctx.client as BinanceClient;
      const [venus] = await listDeFiInvestments(client, {
        defiProtocolId: 'venus',
        investType: 'Earn',
        tokenAddress: BSC_USDT,
      });
      if (!venus) throw new Error('no Venus USDT investment listed');
      const build = (action: 'deposit' | 'redeem') =>
        answerOf(() =>
          client.request(
            'defi-transaction',
            action === 'deposit' ? 'buildDeFiDepositTransaction' : 'buildDeFiRedeemTransaction',
            {
              method: 'POST',
              path: `/api/v1/defi/transaction/${action}`,
              body: {
                address: ctx.empty,
                investmentId: venus.investmentId,
                token: { tokenAddress: BSC_USDT, amount: '1' },
                simulate: true,
              },
            },
          ),
        );
      return oneCodeTwoCauses(await build('deposit'), await build('redeem'));
    },
  },
  {
    slug: 'defi-unlimited-approve',
    logEntry: '2026-09-24 00:49',
    needs: 'binance-key',
    run: async (ctx) => {
      const client = ctx.client as BinanceClient;
      const [venus] = await listDeFiInvestments(client, {
        defiProtocolId: 'venus',
        investType: 'Earn',
        tokenAddress: BSC_USDT,
      });
      if (!venus) throw new Error('no Venus USDT investment listed');
      const build = await buildDeFi(client, 'deposit', {
        address: ctx.empty,
        investmentId: venus.investmentId,
        tokenAddress: BSC_USDT,
        amount: '1',
      });
      return approvesUnlimited(build);
    },
  },
  {
    slug: 'reference-price-derived',
    logEntry: '2026-09-24 00:55',
    needs: 'binance-key',
    run: async (ctx) => {
      const tokens = await fetchRwaTokens(ctx.client as BinanceClient);
      return referenceIsDerived(
        tokens.map((t) => ({
          symbol: t.tokenSymbol,
          tokenPrice: t.tokenPrice ?? null,
          referencePrice: t.referencePrice ?? null,
          ratio: t.tokenToShareRatio,
        })),
      );
    },
  },
  {
    slug: 'ondo-minimum-order',
    logEntry: '2026-09-24 00:46',
    needs: 'binance-key',
    run: async (ctx) => {
      const client = ctx.client as BinanceClient;
      const nvdaon = await token(client, 'NVDAon');
      const quote = await answerOf(async () => {
        await getQuote(client, {
          fromToken: BSC_USDT,
          toToken: nvdaon.tokenContractAddress,
          amount: parseUnits('5', 18),
          userWalletAddress: ctx.empty,
        });
        return { httpStatus: 200 };
      });
      return ondoMinimum(quote);
    },
  },
  {
    slug: 'rate-limit-sliding-window',
    logEntry: '2026-09-24 01:52',
    needs: 'binance-key',
    run: async (ctx) => {
      // Our own limiter would space these out (it is the fix); this client lets them through.
      const open = new RateLimiter({
        perEndpoint: { max: 1_000, windowMs: 1_000, marginMs: 0 },
        global: { capacity: 1_000, perSecond: 1_000 },
        groups: { defi: { max: 1_000, windowMs: 1_000, marginMs: 0 } },
      });
      const client = signedClient(ctx.config, open) as BinanceClient;
      const nvdab = await token(ctx.client as BinanceClient, 'NVDAB');
      await sleep(1_100); // a quiet window before the burst
      const attempts = await Promise.all(
        [0, 65, 130, 195, 260, 450].map(async (offset) => {
          await sleep(offset);
          const atMs = Date.now();
          try {
            const res = await client.request('trading', 'getAggregatedQuote', {
              method: 'GET',
              path: '/api/v1/dex/aggregator/quote',
              query: {
                binanceChainId: '56',
                amount: parseUnits('50', 18).toString(),
                fromTokenAddress: BSC_USDT,
                toTokenAddress: nvdab.tokenContractAddress,
              },
              retries: 0,
            });
            return { httpStatus: res.httpStatus, atMs };
          } catch (error) {
            if (!(error instanceof BinanceApiError)) throw error;
            return { httpStatus: error.httpStatus, atMs };
          }
        }),
      );
      return slidingWindow429(attempts);
    },
  },
];

const usage = 'usage: pnpm dx:repro [--only <slug,slug>] [--baw <path>] [--list]';

const flags = parseFlags(process.argv.slice(2), { values: ['only', 'baw'], switches: ['list'] });
if (!flags.ok) {
  console.error(`${flags.error}\n${usage}`);
  process.exit(2);
}
if (flags.switches.list) {
  for (const r of REPROS) console.log(`${r.slug.padEnd(28)} ${r.logEntry} UTC  needs ${r.needs}`);
  process.exit(0);
}
const only = flags.values.only?.split(',').map((s) => s.trim());
const unknown = only?.filter((s) => !REPROS.some((r) => r.slug === s)) ?? [];
if (unknown.length > 0) {
  console.error(`unknown finding: ${unknown.join(', ')}\n${usage}`);
  process.exit(2);
}

const config = loadConfig();
const ctx: Context = {
  config,
  client: signedClient(config),
  baw: flags.values.baw ?? null,
  empty: privateKeyToAccount(generatePrivateKey()).address,
};

console.log(`dx:repro — ${new Date().toISOString()} — fresh empty address ${ctx.empty}`);
for (const repro of REPROS.filter((r) => !only || only.includes(r.slug))) {
  const at = new Date().toISOString();
  if (repro.needs === 'binance-key' && !ctx.client) {
    console.log(`${repro.slug.padEnd(28)} SKIPPED (no Binance Web3 API key in the config)`);
    continue;
  }
  if (repro.needs === 'baw' && !ctx.baw) {
    console.log(`${repro.slug.padEnd(28)} SKIPPED (no baw: --baw <path>)`);
    continue;
  }
  try {
    const verdict = await repro.run(ctx);
    console.log(
      `${repro.slug.padEnd(28)} ${verdict.reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'} ${at} — ${verdict.observed}`,
    );
  } catch (error) {
    console.log(
      `${repro.slug.padEnd(28)} ERROR ${at} — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
