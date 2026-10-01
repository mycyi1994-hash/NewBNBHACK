/**
 * Deployment manifests: packages/rwa-lp/deployments/<chainId>-<symbol>.json, written by
 * contracts/script/DeployRwaLp.s.sol only when it broadcasts (a dry run writes nothing). An empty
 * directory means nothing is deployed, and readers say so (UNAVAILABLE) instead of guessing; so does
 * a manifest that fails validation, without hiding the others.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { RWA_SESSION_HOOK_FLAGS, UNISWAP_V4_BSC } from './addresses.js';
import { poolIdOf } from './market.js';

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
  // The status reader asks the hook about the key and the PoolManager about the id: they must be
  // the same pool.
  const keyId = poolIdOf({ currency0, currency1, fee, tickSpacing, hooks: hook });
  if (keyId !== poolId.toLowerCase())
    return fail(`poolId is not the id of its pool key (${keyId})`);
  if (chainId === UNISWAP_V4_BSC.chainId && addresses.poolManager !== UNISWAP_V4_BSC.poolManager) {
    return fail(
      `poolManager is not Uniswap's PoolManager on chain 56 (${UNISWAP_V4_BSC.poolManager})`,
    );
  }
  return { file, chainId, rwaSymbol, fee, tickSpacing, poolId, ...addresses };
}

/** A manifest that cannot be used, and why (the file name leads the reason). */
export interface ManifestProblem {
  file: string;
  reason: string;
}

function readManifest(dir: string, name: string): RwaLpDeployment {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
  } catch (error) {
    throw new Error(
      `${name}: not readable JSON (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  return parseDeployment(json, name);
}

/**
 * Every manifest in `dir`, sorted by file name; a missing directory holds none. One that cannot
 * be read or fails validation goes to `problems`, so a reader reports it and still reads the rest.
 */
export function loadDeployments(dir: string = DEPLOYMENTS_DIR): {
  deployments: RwaLpDeployment[];
  problems: ManifestProblem[];
} {
  const deployments: RwaLpDeployment[] = [];
  const problems: ManifestProblem[] = [];
  if (!existsSync(dir)) return { deployments, problems };
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const name of names) {
    try {
      deployments.push(readManifest(dir, name));
    } catch (error) {
      problems.push({ file: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deployments, problems };
}
