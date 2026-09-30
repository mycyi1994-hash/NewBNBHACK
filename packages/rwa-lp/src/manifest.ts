/**
 * Deployment manifests: packages/rwa-lp/deployments/<chainId>-<symbol>.json, written by
 * contracts/script/DeployRwaLp.s.sol only when it broadcasts (a dry run writes nothing). An empty
 * directory means nothing is deployed, and readers say so (UNAVAILABLE) instead of guessing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { RWA_SESSION_HOOK_FLAGS } from './addresses.js';

export const DEPLOYMENTS_DIR = fileURLToPath(new URL('../deployments/', import.meta.url));

/** Uniswap v4 marks a dynamic-fee pool with this fee value. */
export const DYNAMIC_FEE_FLAG = 0x800000;

export interface RwaLpDeployment {
  file: string;
  chainId: number;
  rwaSymbol: string;
  rwaToken: Address;
  quoteToken: Address;
  poolManager: Address;
  calendar: Address;
  hook: Address;
  oracle: Address;
  vault: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  poolId: Hex;
}

const ADDRESS_FIELDS = [
  'rwaToken',
  'quoteToken',
  'poolManager',
  'calendar',
  'hook',
  'oracle',
  'vault',
  'currency0',
  'currency1',
] as const;

/** Validates one manifest; throws with the file name and the first problem found. */
export function parseDeployment(json: unknown, file: string): RwaLpDeployment {
  const fail = (problem: string): never => {
    throw new Error(`${file}: ${problem}`);
  };
  if (typeof json !== 'object' || json === null) return fail('not a JSON object');
  const raw = json as Record<string, unknown>;
  const addresses = {} as Record<(typeof ADDRESS_FIELDS)[number], Address>;
  for (const field of ADDRESS_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
      return fail(`${field} is not an address`);
    }
    addresses[field] = getAddress(value);
  }
  const { chainId, rwaSymbol, fee, tickSpacing, poolId } = raw;
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    return fail('chainId is not a positive integer');
  }
  if (typeof rwaSymbol !== 'string' || rwaSymbol === '') return fail('rwaSymbol is missing');
  if (fee !== DYNAMIC_FEE_FLAG) return fail('fee is not the dynamic-fee flag');
  if (typeof tickSpacing !== 'number' || !Number.isInteger(tickSpacing) || tickSpacing < 1) {
    return fail('tickSpacing is not a positive integer');
  }
  if (typeof poolId !== 'string' || !isHex(poolId) || poolId.length !== 66) {
    return fail('poolId is not 32 bytes of hex');
  }
  const { currency0, currency1, rwaToken, quoteToken, hook } = addresses;
  if (BigInt(currency0) >= BigInt(currency1)) return fail('currency0 must sort below currency1');
  const pair = new Set([currency0, currency1]);
  if (!pair.has(rwaToken) || !pair.has(quoteToken) || rwaToken === quoteToken) {
    return fail('rwaToken and quoteToken must be the two pool currencies');
  }
  if ((BigInt(hook) & 0x3fffn) !== BigInt(RWA_SESSION_HOOK_FLAGS)) {
    return fail('hook address does not carry the RwaSessionHook permission flags');
  }
  return { file, chainId, rwaSymbol, fee, tickSpacing, poolId, ...addresses };
}

/** Every manifest in `dir`, sorted by file name; a missing directory holds none. */
export function loadDeployments(dir: string = DEPLOYMENTS_DIR): RwaLpDeployment[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseDeployment(JSON.parse(readFileSync(path.join(dir, name), 'utf8')), name));
}
