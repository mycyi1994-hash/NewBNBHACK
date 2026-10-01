/**
 * pnpm lp:market [--tokens 0x…,0x…] — the tokenized-stock pools already on Uniswap v4 on BSC, read
 * live: every hookless USDT/USDC pool of each token at the standard fee tiers, its price, its
 * in-range liquidity, and the gap to Binance's own price for the token (the public RWA Dynamic V2
 * `tokenInfo.price`). This is the market docs/RWA_LP.md §1 describes and the RwaSessionHook is
 * for, measured again by anyone with one command. Read-only: no key, no transaction.
 * Tokens: the registry (DATABASE_URL), or --tokens. Exit: 0 read · 1 a read failed · 2 usage ·
 * 3 no token to read.
 */
import { RWA_DYNAMIC_V2_URL } from '@yieldvest/agent';
import { createBscClient, type BscClient } from '@yieldvest/chain';
import { loadConfig } from '@yieldvest/config';
import { toUnits } from '@yieldvest/core';
import { createDb, listInstruments } from '@yieldvest/db';
import {
  feePercent,
  formatE18,
  gapPips,
  readMarketPools,
  type MarketPool,
} from '@yieldvest/rwa-lp';
import { getAddress, isAddress, parseAbi, type Address } from 'viem';
import { parseFlags } from './args.js';

interface Token {
  address: Address;
  symbol: string;
  decimals: number;
}

const usage = 'usage: pnpm lp:market [--tokens 0x…,0x…]';
const DECIMAL = /^\d+(\.\d+)?$/;

/** Binance's price for one whole token (USD, 18 decimals), or why there is none. */
async function binancePrice(address: Address): Promise<{ e18: bigint } | { error: string }> {
  const url = new URL(RWA_DYNAMIC_V2_URL);
  url.searchParams.set('chainId', '56');
  url.searchParams.set('contractAddress', address);
  try {
    const res = await fetch(url, {
      headers: { 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      code?: unknown;
      data?: { tokenInfo?: { price?: unknown } };
    };
    const price = body.data?.tokenInfo?.price;
    if (body.code !== '000000' || typeof price !== 'string' || !DECIMAL.test(price)) {
      return { error: `no tokenInfo.price (code ${JSON.stringify(body.code)})` };
    }
    // Binance quotes up to 20 decimals: the 19th onwards is below a wei of USD, cut.
    return { e18: toUnits(price.replace(/^(\d+\.\d{18})\d+$/, '$1'), 18) };
  } catch (error) {
    return {
      error: error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : 'failed',
    };
  }
}

/** A signed percentage of `price` against `reference`, two decimals, from the exact gap. */
function gapText(price: bigint, reference: bigint): string {
  const pips = gapPips(price, reference);
  const sign = price < reference ? '−' : '+';
  return `${sign}${feePercent(Number(pips))} vs Binance`;
}

function poolLine(pool: MarketPool, reference: bigint | undefined): string {
  const price = pool.atPriceLimit
    ? 'drained (at the tick limit)'.padEnd(14)
    : `${formatE18(pool.priceE18)} ${pool.quote}`.padEnd(14);
  const liquidity = pool.liquidity === 0n ? 'no liquidity in range' : `liquidity ${pool.liquidity}`;
  const gap =
    reference !== undefined && !pool.atPriceLimit ? ` · ${gapText(pool.priceE18, reference)}` : '';
  return `  ${pool.quote} ${feePercent(pool.fee).padEnd(6)} ${price} ${liquidity}${gap}`;
}

const erc20 = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

async function tokensToRead(
  client: BscClient,
  tokensFlag: string | undefined,
): Promise<Token[] | string> {
  if (tokensFlag !== undefined) {
    const parts = tokensFlag.split(',').map((t) => t.trim());
    const bad = parts.find((t) => !isAddress(t, { strict: false }));
    if (bad !== undefined) return `not an address: ${bad}`;
    // Symbol and decimals from the token itself, not from the caller.
    return Promise.all(
      parts.map(async (t) => {
        const address = getAddress(t);
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address, abi: erc20, functionName: 'symbol' }),
          client.readContract({ address, abi: erc20, functionName: 'decimals' }),
        ]);
        return { address, symbol, decimals };
      }),
    );
  }
  const config = loadConfig();
  if (!config.databaseUrl) return [];
  const { db, close } = createDb(config.databaseUrl);
  try {
    return (await listInstruments(db))
      .filter((i) => i.chainId === 56)
      .map((i) => ({ address: getAddress(i.address), symbol: i.symbol, decimals: i.decimals }));
  } finally {
    await close();
  }
}

const flags = parseFlags(process.argv.slice(2), { values: ['tokens'] });
if (!flags.ok) {
  console.log(`${flags.error}\n${usage}`);
  process.exitCode = 2;
} else {
  const client = createBscClient(loadConfig().bsc);
  const tokens = await tokensToRead(client, flags.values.tokens);
  if (typeof tokens === 'string') {
    console.log(`${tokens}\n${usage}`);
    process.exitCode = 2;
  } else if (tokens.length === 0) {
    console.log('UNAVAILABLE: no token to read — set DATABASE_URL (the registry) or pass --tokens');
    process.exitCode = 3;
  } else {
    console.log(
      `lp:market — hookless Uniswap v4 pools of tokenized stocks on BSC (USDT/USDC, standard tiers)`,
    );
    for (const token of tokens) {
      try {
        const [{ blockNumber, pools }, reference] = await Promise.all([
          readMarketPools(client, token),
          binancePrice(token.address),
        ]);
        const ref = 'e18' in reference ? reference.e18 : undefined;
        console.log(
          `${token.symbol} ${token.address} · block ${blockNumber} · Binance ${
            ref === undefined
              ? `UNAVAILABLE (${'error' in reference ? reference.error : ''})`
              : `${formatE18(ref)} USD`
          }`,
        );
        if (pools.length === 0) console.log('  no pool');
        for (const pool of pools) console.log(poolLine(pool, ref));
      } catch (error) {
        console.log(
          `${token.symbol} ${token.address} · UNAVAILABLE: ${
            error instanceof Error ? error.message.split('\n')[0] : String(error)
          }`,
        );
        process.exitCode = 1;
      }
    }
  }
}
