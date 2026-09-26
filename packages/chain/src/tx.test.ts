/** Executor building blocks: calldata decoded from recorded API responses, logs, signable txs. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  parseTransaction,
  type Hex,
  type Log,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { BSC_USDT } from './index.js';
import {
  apiInt,
  decodeApprove,
  decodeVenusCall,
  encodeApprove,
  MAX_GAS_LIMIT,
  signableTx,
  transferredFrom,
  transferredTo,
} from './tx.js';

const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', 'fixtures');
const VUSDT = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';
const HOUSE = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

function defiItems(file: string): { callDataType: string; to: string; data: string }[] {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as {
    response: {
      body: { data: { dataList: { callDataType: string; to: string; data: string }[] } };
    };
  };
  return fixture.response.body.data.dataList;
}

describe('approve calldata', () => {
  it('round-trips an exact approval', () => {
    const data = encodeApprove(VUSDT, 1_000_000_000_000_000_000n);
    expect(data.slice(0, 10)).toBe('0x095ea7b3');
    expect(decodeApprove(data)).toEqual({ spender: VUSDT, amount: 1_000_000_000_000_000_000n });
  });

  it('exposes the unlimited approval in the DeFi build (Q-16), so it can be refused', () => {
    const [approve] = defiItems('defi-transaction/buildDeFiDepositTransaction-20260924-3.json');
    expect(approve?.callDataType).toBe('APPROVE');
    expect(decodeApprove(approve?.data ?? '')).toEqual({ spender: VUSDT, amount: 2n ** 256n - 1n });
  });

  it('refuses calldata that is not approve()', () => {
    const [, deposit] = defiItems('defi-transaction/buildDeFiDepositTransaction-20260924-3.json');
    expect(() => decodeApprove(deposit?.data ?? '')).toThrow();
  });
});

describe('Venus calldata (fixtures: 1 USDT deposit and redeem builds)', () => {
  it('reads mint(1 USDT) and redeem(vTokens)', () => {
    const [, deposit] = defiItems('defi-transaction/buildDeFiDepositTransaction-20260924-3.json');
    expect(deposit?.to).toBe(VUSDT);
    expect(decodeVenusCall(deposit?.data ?? '')).toEqual({ fn: 'mint', amount: 10n ** 18n });
    const [redeem] = defiItems('defi-transaction/buildDeFiRedeemTransaction-20260924-3.json');
    const decoded = decodeVenusCall(redeem?.data ?? '');
    expect(decoded.fn).toBe('redeem');
    // vUSDT has 8 decimals and ~0.02 USDT per vToken unit scale: 1 USDT ≈ 4e8–1e10 vToken units.
    expect(decoded.amount > 10n ** 8n && decoded.amount < 10n ** 11n).toBe(true);
  });

  it('refuses anything else', () => {
    expect(() => decodeVenusCall(encodeApprove(VUSDT, 1n))).toThrow();
  });
});

const transferEvent = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function transferLog(token: string, from: string, to: string, value: bigint): Log {
  return {
    address: token as Hex,
    topics: encodeEventTopics({
      abi: transferEvent,
      eventName: 'Transfer',
      args: { from: from as Hex, to: to as Hex },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  };
}

describe('receipt log amounts', () => {
  const token = '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436';
  const logs = [
    transferLog(BSC_USDT, HOUSE, OTHER, 5n * 10n ** 18n),
    transferLog(token, OTHER, HOUSE, 21_000_000_000_000_000n),
    transferLog(token, OTHER, HOUSE, 1_000n),
    transferLog(token, HOUSE, OTHER, 7n),
    transferLog(OTHER, OTHER, HOUSE, 999n),
  ];

  it('sums what reached the wallet, per token', () => {
    expect(transferredTo(logs, token, HOUSE)).toBe(21_000_000_000_001_000n);
    expect(transferredTo(logs, token.toLowerCase(), HOUSE.toUpperCase().replace('0X', '0x'))).toBe(
      21_000_000_000_001_000n,
    );
    expect(transferredFrom(logs, BSC_USDT, HOUSE)).toBe(5n * 10n ** 18n);
    expect(transferredTo(logs, BSC_USDT, HOUSE)).toBe(0n);
  });
});

describe('apiInt', () => {
  it('reads decimal and hex API fields', () => {
    expect(apiInt('58339710', 'gasPrice')).toBe(58_339_710n);
    expect(apiInt('0x0', 'value')).toBe(0n);
    expect(() => apiInt('', 'gas')).toThrow('gas is missing');
    expect(() => apiInt(undefined, 'gas')).toThrow('gas is missing');
    expect(() => apiInt('1.5', 'gas')).toThrow('not an integer');
  });
});

describe('signableTx', () => {
  // Hardhat's public test account #0 — a key everyone knows, never funded by us.
  const account = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  const call = {
    to: OTHER,
    data: '0x' as const,
    value: 0n,
    gas: 450_000n,
    gasPrice: 58_339_710n,
    nonce: 7,
  };

  it('builds EIP-1559 when the API gives a priority fee (docs Step 4), legacy otherwise', async () => {
    const eip1559 = signableTx({ ...call, maxPriorityFeePerGas: 58_339_710n });
    expect(eip1559).toMatchObject({
      type: 'eip1559',
      chainId: 56,
      maxFeePerGas: 58_339_710n,
      nonce: 7,
    });
    const raw = await account.signTransaction(eip1559);
    expect(parseTransaction(raw)).toMatchObject({
      chainId: 56,
      nonce: 7,
      gas: 450_000n,
      type: 'eip1559',
    });
    expect(signableTx(call)).toMatchObject({ type: 'legacy', gasPrice: 58_339_710n });
  });

  it('refuses gas outside the bounds and a priority fee above the max fee', () => {
    expect(() => signableTx({ ...call, gas: MAX_GAS_LIMIT + 1n })).toThrow('gas limit');
    expect(() => signableTx({ ...call, gas: 0n })).toThrow('gas limit');
    expect(() => signableTx({ ...call, gasPrice: 3_000_000_001n })).toThrow('gas price');
    expect(() => signableTx({ ...call, maxPriorityFeePerGas: 58_339_711n })).toThrow(
      'priority fee',
    );
  });
});
