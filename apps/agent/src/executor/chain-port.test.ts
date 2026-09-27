/**
 * viemChainPort's receipt handling, with a stub client: viem follows a replacement transaction
 * (same nonce, other bytes) and returns its receipt — that is never taken for ours.
 */
import type { BscClient } from '@ijaro/chain';
import { WaitForTransactionReceiptTimeoutError, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { viemChainPort } from './chain-port.js';

const OURS: Hex = `0x${'11'.repeat(32)}`;
const OTHER: Hex = `0x${'22'.repeat(32)}`;

const receipt = (transactionHash: Hex) => ({
  transactionHash,
  status: 'success' as const,
  blockNumber: 1n,
  gasUsed: 21_000n,
  effectiveGasPrice: 1n,
  logs: [],
});

function port(wait: () => Promise<unknown>) {
  return viemChainPort({ waitForTransactionReceipt: wait } as unknown as BscClient);
}

describe('viemChainPort.waitForReceipt', () => {
  it('returns our own receipt', async () => {
    const got = await port(() => Promise.resolve(receipt(OURS))).waitForReceipt(OURS, 1_000);
    expect(got).toMatchObject({ status: 'success', blockNumber: 1n });
  });

  it("reports a replacement's receipt as not mined, whatever the hash's spelling", async () => {
    expect(await port(() => Promise.resolve(receipt(OTHER))).waitForReceipt(OURS, 1_000)).toBe(
      undefined,
    );
    const upper: Hex = `0x${'11'.repeat(32).toUpperCase()}`;
    expect(
      await port(() => Promise.resolve(receipt(upper))).waitForReceipt(OURS, 1_000),
    ).toMatchObject({
      status: 'success',
    });
  });

  it('reports a timeout as not mined and passes any other error on', async () => {
    const timeout = new WaitForTransactionReceiptTimeoutError({ hash: OURS });
    expect(await port(() => Promise.reject(timeout)).waitForReceipt(OURS, 1_000)).toBe(undefined);
    await expect(
      port(() => Promise.reject(new Error('rpc exploded'))).waitForReceipt(OURS, 1_000),
    ).rejects.toThrow('rpc exploded');
  });
});
