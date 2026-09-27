import { createServer, type Server } from 'node:http';
import { utilizationBps, underlyingFromVTokens } from '@ijaro/core';
import { createPublicClient, custom, fallback } from 'viem';
import { bsc } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { assertBscChain, createBscClient, readVTokenState, type BscClient } from './index.js';

// Values read from BSC block 123664140 on 2026-09-24 (dx/LOG.md 00:49 entry, scripts/spike-venus.ts).
const VUSDT = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';
const RECORDED: Record<string, unknown> = {
  symbol: 'vUSDT',
  decimals: 8,
  underlying: '0x55d398326f99059fF775485246999027B3197955',
  comptroller: '0xfD36E2c2a6789Db23113685031d7F16329158384',
  exchangeRateStored: 265115854764046092440821898n,
  getCash: 50523730686338373473609589n,
  totalBorrows: 135119487085807693844682283n,
  totalReserves: 52893137961736919400n,
  supplyRatePerBlock: 445461184n,
  actionPaused: false,
};

/** Replays recorded on-chain answers; records which block every read was pinned to. */
function recordedClient() {
  const blocks = new Set<bigint | undefined>();
  const client = {
    getBlockNumber: () => Promise.resolve(123664140n),
    readContract: ({
      functionName,
      blockNumber,
    }: {
      functionName: string;
      blockNumber?: bigint;
    }) => {
      blocks.add(blockNumber);
      if (!(functionName in RECORDED))
        return Promise.reject(new Error(`unexpected ${functionName}`));
      return Promise.resolve(RECORDED[functionName]);
    },
  };
  return { client: client as unknown as BscClient, blocks };
}

describe('readVTokenState', () => {
  it('reads every field at one block and feeds the core maths', async () => {
    const { client, blocks } = recordedClient();
    const state = await readVTokenState(client, VUSDT);
    expect(state.symbol).toBe('vUSDT');
    expect(state.underlying).toBe('0x55d398326f99059fF775485246999027B3197955');
    expect(state.mintPaused).toBe(false);
    expect([...blocks]).toEqual([123664140n]);
    expect(utilizationBps(state.cash, state.totalBorrows, state.totalReserves)).toBe(7279);
    // 1 vUSDT (1e8 units) ≈ 0.0265 USDT
    expect(underlyingFromVTokens(10n ** 8n, state.exchangeRateStored)).toBe(26511585476404609n);
  });
});

/** A BSC client over fake JSON-RPC transports; each answers eth_chainId with its entry. */
function fakeRpcs(...answers: (string | Error)[]): BscClient {
  const transports = answers.map((answer) =>
    custom({
      request: ({ method }: { method: string }) => {
        if (method !== 'eth_chainId') return Promise.reject(new Error(`unexpected ${method}`));
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    }),
  );
  const [only] = transports;
  const transport = transports.length === 1 && only ? only : fallback(transports);
  return createPublicClient({ chain: bsc, transport }) as unknown as BscClient;
}

/** A local JSON-RPC server whose eth_chainId is `chainIdHex`. */
async function rpcServer(chainIdHex: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const { id } = JSON.parse(body) as { id: number };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: chainIdHex }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe('assertBscChain', () => {
  it('passes when the primary and the fallback RPC are both BSC mainnet (56)', async () => {
    await expect(assertBscChain(fakeRpcs('0x38', '0x38'))).resolves.toEqual([]);
  });

  it('asks the fallback directly, which the fallback transport only reaches on failure', async () => {
    await expect(assertBscChain(fakeRpcs('0x38', '0x61'))).rejects.toThrow(
      'BSC RPC check failed: fallback RPC is on chain 97, not 56',
    );
  });

  it('fails on another chain, a malformed answer, or an RPC that does not answer', async () => {
    await expect(assertBscChain(fakeRpcs('0x1', '0x38'))).rejects.toThrow(
      'primary RPC is on chain 1, not 56',
    );
    await expect(assertBscChain(fakeRpcs('56', '0x38'))).rejects.toThrow(
      'primary RPC is on chain "56", not 56',
    );
    await expect(assertBscChain(fakeRpcs('0x38', new Error('connection refused')))).rejects.toThrow(
      'BSC RPC check failed: fallback RPC did not answer eth_chainId: An unknown RPC error occurred. (connection refused)',
    );
    // Every problem is reported at once.
    await expect(assertBscChain(fakeRpcs('0x61', '0x1'))).rejects.toThrow(
      'primary RPC is on chain 97, not 56; fallback RPC is on chain 1, not 56',
    );
  });

  it('on request, only warns about an RPC that does not answer — a wrong chain still fails', async () => {
    const warned = await assertBscChain(fakeRpcs('0x38', new Error('connection refused')), {
      unreachable: 'warn',
    });
    expect(warned).toEqual([
      'fallback RPC did not answer eth_chainId: An unknown RPC error occurred. (connection refused)',
    ]);
    await expect(
      assertBscChain(fakeRpcs('0x61', new Error('connection refused')), { unreachable: 'warn' }),
    ).rejects.toThrow('BSC RPC check failed: primary RPC is on chain 97, not 56');
  });

  it('checks a client without a fallback as it is', async () => {
    await expect(assertBscChain(fakeRpcs('0x38'))).resolves.toEqual([]);
    await expect(assertBscChain(fakeRpcs('0x61'))).rejects.toThrow('RPC is on chain 97, not 56');
  });

  it('checks both URLs of a real createBscClient, naming hosts but never paths', async () => {
    const mainnet = await rpcServer('0x38');
    const testnet = await rpcServer('0x61');
    try {
      const ok = createBscClient({ rpcUrl: mainnet.url, rpcUrlFallback: mainnet.url });
      await expect(assertBscChain(ok)).resolves.toEqual([]);
      const wrong = createBscClient({
        rpcUrl: `${mainnet.url}/v1/primary-api-key`,
        rpcUrlFallback: `${testnet.url}/v1/fallback-api-key`,
      });
      const error = await assertBscChain(wrong).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `BSC RPC check failed: fallback RPC (${new URL(testnet.url).host}) is on chain 97, not 56`,
      );
    } finally {
      for (const { server } of [mainnet, testnet]) {
        server.closeAllConnections();
        server.close();
      }
    }
  });

  it('names the reason when a real RPC URL refuses the connection, without its path', async () => {
    const mainnet = await rpcServer('0x38');
    const gone = await rpcServer('0x38');
    await new Promise<void>((resolve) => gone.server.close(() => resolve()));
    try {
      const client = createBscClient({
        rpcUrl: mainnet.url,
        rpcUrlFallback: `${gone.url}/v1/fallback-api-key`,
      });
      const error = await assertBscChain(client).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(
        /^BSC RPC check failed: fallback RPC \(127\.0\.0\.1:\d+\) did not answer eth_chainId: HTTP request failed\. \(connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/,
      );
      expect((error as Error).message).not.toContain('fallback-api-key');
    } finally {
      mainnet.server.closeAllConnections();
      mainnet.server.close();
    }
  });
});
