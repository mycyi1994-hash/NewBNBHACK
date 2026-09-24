import { utilizationBps, underlyingFromVTokens } from '@ijaro/core';
import { describe, expect, it } from 'vitest';
import { readVTokenState, type BscClient } from './index.js';

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
    expect(utilizationBps(state.cash, state.totalBorrows, state.totalReserves)).toBe(7278);
    // 1 vUSDT (1e8 units) ≈ 0.0265 USDT
    expect(underlyingFromVTokens(10n ** 8n, state.exchangeRateStored)).toBe(26511585476404609n);
  });
});
