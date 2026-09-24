/**
 * Shared wiring for the worker and the one-shot scripts: a Binance client whose every attempt
 * lands in api_calls, the BSC client, and the house wallet address (address only — this process
 * never signs in M0; EXECUTION_MODE stays simulate).
 */
import path from 'node:path';
import { BinanceClient, createFixtureRecorder } from '@ijaro/binance';
import { createBscClient } from '@ijaro/chain';
import { findWorkspaceRoot, type Config } from '@ijaro/config';
import { createApiCallSink, createDb } from '@ijaro/db';
import { privateKeyToAccount } from 'viem/accounts';

export interface Runtime {
  config: Config;
  client: BinanceClient;
  bsc: ReturnType<typeof createBscClient>;
  database: ReturnType<typeof createDb>;
  /** Checksummed house address, or undefined when HOUSE_WALLET_PRIVATE_KEY is unset. */
  houseAddress: `0x${string}` | undefined;
  /** Values to redact from fixtures and logs (house address in all spellings). */
  redact: string[];
  sinkErrors: unknown[];
  close: () => Promise<void>;
}

export function houseRedactions(address: string | undefined): string[] {
  if (!address) return [];
  const bare = address.slice(2);
  return [address, address.toLowerCase(), bare, bare.toLowerCase()];
}

export function createRuntime(config: Config, options: { fixtures?: boolean } = {}): Runtime {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required (api_calls, instruments)');
  const database = createDb(config.databaseUrl);
  const sink = createApiCallSink(database.db);
  const houseAddress = config.houseWalletPrivateKey
    ? privateKeyToAccount(config.houseWalletPrivateKey).address
    : undefined;
  const redact = houseRedactions(houseAddress);
  const sinkErrors: unknown[] = [];
  const root = findWorkspaceRoot() ?? process.cwd();
  const client = new BinanceClient({
    baseUrl: config.binance.baseUrl,
    apiKey: config.binance.apiKey,
    apiSecret: config.binance.apiSecret,
    region: config.regionTag ?? null,
    onApiCall: sink,
    onSinkError: (error) => sinkErrors.push(error),
    redact,
    ...(options.fixtures
      ? { fixtures: createFixtureRecorder({ rootDir: path.join(root, 'fixtures'), redact }) }
      : {}),
  });
  return {
    config,
    client,
    bsc: createBscClient(config.bsc),
    database,
    houseAddress,
    redact,
    sinkErrors,
    close: () => database.close(),
  };
}

/** Replaces the house address (any spelling) with a placeholder for console output. */
export function maskHouse(text: string, redact: readonly string[]): string {
  let out = text;
  for (const value of redact) out = out.replaceAll(new RegExp(value, 'gi'), '[house]');
  return out;
}
