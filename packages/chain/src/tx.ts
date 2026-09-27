/**
 * Transaction building blocks for the executor (SPEC §5.8): decode what the APIs hand us before we
 * sign it, encode our own exact approvals, and read amounts back from receipt logs. Everything
 * here is pure except the two allowance/balance reads.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
  type TransactionSerializable,
} from 'viem';
import { BSC_CHAIN_ID, type BscClient } from './index.js';

export const erc20WriteAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** Venus vToken writes: mint(underlying amount), redeem(vToken amount). */
export const vTokenWriteAbi = parseAbi([
  'function mint(uint256 mintAmount) returns (uint256)',
  'function redeem(uint256 redeemTokens) returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/**
 * Upper bounds we refuse to sign above. BSC runs near 0.05–0.06 gwei (G1: swap gasPrice 58339710
 * wei); a swap estimate was 450,000 gas. A value past these bounds means a broken quote or a
 * hostile payload, not a busy chain.
 */
export const MAX_GAS_PRICE_WEI = 3_000_000_000n;
export const MAX_GAS_LIMIT = 1_500_000n;

export function encodeApprove(spender: string, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20WriteAbi,
    functionName: 'approve',
    args: [getAddress(spender), amount],
  });
}

/** The spender and amount of approve() calldata; throws for any other call. */
export function decodeApprove(data: string): { spender: Address; amount: bigint } {
  const decoded = decodeFunctionData({ abi: erc20WriteAbi, data: data as Hex });
  if (decoded.functionName !== 'approve') {
    throw new Error(`expected approve(), got ${decoded.functionName}()`);
  }
  const [spender, amount] = decoded.args;
  return { spender, amount };
}

/** A Venus mint() or redeem() call and its argument; any other selector throws while decoding. */
export function decodeVenusCall(data: string): { fn: 'mint' | 'redeem'; amount: bigint } {
  const decoded = decodeFunctionData({ abi: vTokenWriteAbi, data: data as Hex });
  return { fn: decoded.functionName, amount: decoded.args[0] };
}

function transfers(logs: readonly Log[], token: string) {
  return parseEventLogs({ abi: erc20WriteAbi, eventName: 'Transfer', logs: [...logs] }).filter(
    (log) => isAddressEqual(log.address, getAddress(token)),
  );
}

/** Sum of `token` Transfer events to `to` in the receipt logs (what actually arrived). */
export function transferredTo(logs: readonly Log[], token: string, to: string): bigint {
  return transfers(logs, token)
    .filter((log) => isAddressEqual(log.args.to, getAddress(to)))
    .reduce((sum, log) => sum + log.args.value, 0n);
}

/** Sum of `token` Transfer events from `from` in the receipt logs (what actually left). */
export function transferredFrom(logs: readonly Log[], token: string, from: string): bigint {
  return transfers(logs, token)
    .filter((log) => isAddressEqual(log.args.from, getAddress(from)))
    .reduce((sum, log) => sum + log.args.value, 0n);
}

export async function readAllowance(
  client: BscClient,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  return client.readContract({
    address: getAddress(token),
    abi: erc20WriteAbi,
    functionName: 'allowance',
    args: [getAddress(owner), getAddress(spender)],
  });
}

export async function readTokenBalance(
  client: BscClient,
  token: string,
  holder: string,
): Promise<bigint> {
  return client.readContract({
    address: getAddress(token),
    abi: erc20WriteAbi,
    functionName: 'balanceOf',
    args: [getAddress(holder)],
  });
}

/** Decimal or 0x-prefixed integer text from an API field (docs: `int(value, 0)`). */
export function apiInt(value: string | number | null | undefined, field: string): bigint {
  if (value === null || value === undefined || value === '') throw new Error(`${field} is missing`);
  const text = String(value).trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) throw new Error(`${field} is not an integer: ${text}`);
  return BigInt(text);
}

export interface UnsignedCall {
  to: string;
  data: string;
  value: bigint;
  gas: bigint;
  gasPrice: bigint;
  /** Present → EIP-1559 with maxFeePerGas = gasPrice (docs Step 4); absent → legacy. */
  maxPriorityFeePerGas?: bigint;
  nonce: number;
}

/** A BSC transaction ready for the signer, refused past the gas bounds. */
export function signableTx(call: UnsignedCall): TransactionSerializable {
  if (call.gas <= 0n || call.gas > MAX_GAS_LIMIT)
    throw new Error(`gas limit ${call.gas} is out of bounds`);
  if (call.gasPrice <= 0n || call.gasPrice > MAX_GAS_PRICE_WEI) {
    throw new Error(`gas price ${call.gasPrice} wei is out of bounds`);
  }
  const base = {
    chainId: BSC_CHAIN_ID,
    nonce: call.nonce,
    to: getAddress(call.to),
    data: call.data as Hex,
    value: call.value,
    gas: call.gas,
  };
  if (call.maxPriorityFeePerGas !== undefined) {
    if (call.maxPriorityFeePerGas > call.gasPrice) throw new Error('priority fee above max fee');
    return {
      ...base,
      type: 'eip1559',
      maxFeePerGas: call.gasPrice,
      maxPriorityFeePerGas: call.maxPriorityFeePerGas,
    };
  }
  return { ...base, type: 'legacy', gasPrice: call.gasPrice };
}
