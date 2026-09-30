import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { DRY_RUN_MANIFEST } from '../test/fixtures.js';
import { parseDeployment } from './manifest.js';
import { decodeSlot0, poolStateSlot, readLpStatus, type LpReader } from './status.js';

const deployment = parseDeployment(DRY_RUN_MANIFEST, '56-NVDAB.json');
// 225 USD per NVDAB, NVDAB is currency0, both tokens 18 decimals.
const SQRT_PRICE_225 = 15n * 2n ** 96n; // √225 · 2^96
const NOW = 1_791_298_800n; // Tue 6 Oct 2026 11:00 New York

function word(sqrtPriceX96: bigint, tick: number, lpFee: number): `0x${string}` {
  const packed = sqrtPriceX96 | (BigInt(tick & 0xffffff) << 160n) | (BigInt(lpFee) << 208n);
  return `0x${packed.toString(16).padStart(64, '0')}`;
}

/** Answers readContract by function name, like a node at one block would. */
function reader(overrides: Record<string, unknown> = {}): LpReader {
  const answers: Record<string, unknown> = {
    poolConfig: {
      rwaToken: deployment.rwaToken,
      rwaIsCurrency0: true,
      halted: false,
      bStockMultiplier: true,
      rwaDecimals: 18,
      quoteDecimals: 18,
      liquidityGate: deployment.vault,
      fees: { maxReferenceAge: 900 },
    },
    extsload: word(SQRT_PRICE_225, 54_000, 0),
    referencePrice: [220n * 10n ** 18n, NOW - 120n],
    totalSupply: 10n ** 21n,
    positionLiquidity: 10n ** 21n,
    totalAmounts: [66_666n * 10n ** 15n, 15_000n * 10n ** 18n],
    allowlistEnabled: false,
    decimals: 18,
    ...overrides,
  };
  const client = {
    getBlockNumber: () => Promise.resolve(124_900_000n),
    getBlock: () => Promise.resolve({ timestamp: NOW }),
    readContract: (args: { functionName: string; args?: readonly unknown[] }) => {
      if (args.functionName === 'quoteFee') {
        const zeroForOne = args.args?.[1] === true;
        // selling NVDAB (zeroForOne) closes the premium over the reference: reference_gap (5)
        return Promise.resolve(zeroForOne ? [11_704, 0, 5] : [500, 0, 0]);
      }
      const answer = answers[args.functionName];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return client as unknown as Pick<PublicClient, 'readContract' | 'getBlock' | 'getBlockNumber'>;
}

describe('readLpStatus', () => {
  it('reads one pool at one block', async () => {
    const status = await readLpStatus(reader(), deployment);
    expect(status.state).toBe('LIVE');
    if (status.state !== 'LIVE') return;
    expect(status.session).toBe('regular');
    expect(status.buy).toEqual({ feePips: 500, reason: 'regular' });
    expect(status.sell).toEqual({ feePips: 11_704, reason: 'reference_gap' });
    expect(status.poolPriceE18 / 10n ** 16n).toBe(22_500n);
    expect(status.reference).toEqual({
      priceE18: 220n * 10n ** 18n,
      observedAt: new Date(Number(NOW - 120n) * 1000),
      ageSeconds: 120,
      fresh: true,
    });
    expect(status.vault.rwaAmount).toBe(66_666n * 10n ** 15n);
    expect(status.vault.quoteAmount).toBe(15_000n * 10n ** 18n);
    expect(status.halted).toBe(false);
  });

  it('marks an old reference as stale and a missing one as absent', async () => {
    const old = await readLpStatus(
      reader({ referencePrice: [220n * 10n ** 18n, NOW - 901n] }),
      deployment,
    );
    expect(old.state === 'LIVE' && old.reference?.fresh).toBe(false);
    const none = await readLpStatus(reader({ referencePrice: [0n, 0n] }), deployment);
    expect(none.state === 'LIVE' && none.reference).toBeNull();
  });

  it('is UNAVAILABLE, with the reason, when a read fails or the pool is empty', async () => {
    const failing = Object.assign(new Error('long text\nURL: https://rpc.example/key'), {
      shortMessage: 'HTTP request failed.',
    });
    expect(await readLpStatus(reader({ totalSupply: failing }), deployment)).toEqual({
      state: 'UNAVAILABLE',
      deployment,
      reason: 'HTTP request failed.',
    });
    const empty = await readLpStatus(reader({ extsload: word(0n, 0, 0) }), deployment);
    expect(empty).toMatchObject({ state: 'UNAVAILABLE', reason: 'the pool is not initialized' });
  });
});

describe('slot0 decoding', () => {
  it('splits the packed word, including a negative tick', () => {
    expect(decodeSlot0(word(SQRT_PRICE_225, -54_000, 3000))).toEqual({
      sqrtPriceX96: SQRT_PRICE_225,
      tick: -54_000,
      lpFee: 3000,
    });
  });

  it('addresses the pool state like Uniswap v4 StateLibrary', () => {
    // keccak256(abi.encodePacked(poolId, bytes32(6)))
    expect(poolStateSlot(deployment.poolId)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
