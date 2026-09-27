/**
 * Shared wiring for the worker and the one-shot scripts: a Binance client whose every attempt
 * lands in api_calls, the BSC client, the house wallet address, the alerter, and — only through
 * `executorDeps(rt, 'live')`, which requires EXECUTION_MODE=live — the house signer.
 */
import path from 'node:path';
import { BinanceClient, createFixtureRecorder } from '@yieldvest/binance';
import { createBscClient } from '@yieldvest/chain';
import { findWorkspaceRoot, type Config } from '@yieldvest/config';
import { createApiCallSink, createDb, recordDxEvent } from '@yieldvest/db';
import { privateKeyToAccount } from 'viem/accounts';
import { createAlerter, type Alerter } from './alerts.js';
import type { CycleDeps } from './cycle.js';
import { watchDxFindings } from './dx-watch.js';
import { viemChainPort } from './executor/chain-port.js';
import { houseSigner } from './executor/signer.js';

export interface Runtime {
  config: Config;
  client: BinanceClient;
  bsc: ReturnType<typeof createBscClient>;
  database: ReturnType<typeof createDb>;
  /** Telegram when configured, the log otherwise (FAILED cycles, first-sighting DX events). */
  alerter: Alerter;
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
  const houseAddress = config.houseWalletPrivateKey
    ? privateKeyToAccount(config.houseWalletPrivateKey).address
    : undefined;
  const redact = houseRedactions(houseAddress);
  const { botToken, opsChatId } = config.telegram;
  const alerter = createAlerter({
    telegram: botToken && opsChatId ? { botToken, chatId: opsChatId } : undefined,
    redact,
  });
  const sink = watchDxFindings(createApiCallSink(database.db), {
    record: (event) => recordDxEvent(database.db, event),
    alerter,
  });
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
    alerter,
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

/**
 * What the cycle runner and the executor need. `live` hands over the house signer, and only when
 * the configuration itself says EXECUTION_MODE=live: a flag alone never unlocks signing.
 */
export function executorDeps(rt: Runtime, mode: 'simulate' | 'live'): CycleDeps {
  if (!rt.houseAddress) throw new Error('HOUSE_WALLET_PRIVATE_KEY is required (the house address)');
  if (mode === 'live' && rt.config.executionMode !== 'live') {
    throw new Error('live execution needs EXECUTION_MODE=live in the configuration');
  }
  const key = rt.config.houseWalletPrivateKey;
  return {
    mode,
    client: rt.client,
    chain: viemChainPort(rt.bsc),
    db: rt.database.db,
    house: rt.houseAddress,
    ...(mode === 'live' && key ? { signer: houseSigner(key) } : {}),
    log: (line) => console.log(maskHouse(line, rt.redact)),
    now: () => new Date(),
    config: rt.config,
    alerter: rt.alerter,
  };
}
