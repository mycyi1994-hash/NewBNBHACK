/**
 * pnpm reach — can this host reach the Binance Web3 API, and do signed calls work? (TASKS M0-03/04)
 *
 *   1. unsigned GET (no key needed): proves the gateway answers with a JSON envelope from here
 *      (a 40101 "Invalid API Key" is the expected, healthy answer; 4030x means region/VPN blocks).
 *   2. signed RWA token list (BSC).
 *   3. signed Market price batch for a few tokens from step 2. Its body shape is not documented
 *      anywhere (docs/DECISIONS.md V-09); this probe is how G1 settles it, and says so.
 *
 * Read-only: no quotes, no transactions. Every attempt goes to api_calls when DATABASE_URL is set.
 * Flags: --fixtures (save responses under fixtures/), --no-db.
 * Exit: 0 all probes ok · 1 a probe failed · 3 signed probes UNAVAILABLE (no API key).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BinanceApiError,
  BinanceClient,
  createFixtureRecorder,
  type ApiCallRecord,
  type ApiModule,
} from '@ijaro/binance';
import { describeConfig, findWorkspaceRoot, loadConfig } from '@ijaro/config';
import { createApiCallSink, createDb } from '@ijaro/db';

const { values: flags } = parseArgs({
  options: {
    fixtures: { type: 'boolean', default: false },
    'no-db': { type: 'boolean', default: false },
  },
});

const config = loadConfig();
const root = findWorkspaceRoot() ?? process.cwd();
const database = config.databaseUrl && !flags['no-db'] ? createDb(config.databaseUrl) : undefined;
const recorded: ApiCallRecord[] = [];
const sink = database ? createApiCallSink(database.db) : undefined;
let sinkError: unknown;
let lastSkewMs: number | null = null;

const client = new BinanceClient({
  baseUrl: config.binance.baseUrl,
  apiKey: config.binance.apiKey,
  apiSecret: config.binance.apiSecret,
  region: config.regionTag ?? null,
  onApiCall: async (record) => {
    recorded.push(record);
    await sink?.(record);
  },
  onSinkError: (error) => {
    sinkError = error;
  },
  clockSkewWarnMs: 0,
  onClockSkew: (skewMs) => {
    lastSkewMs = skewMs;
  },
  ...(flags.fixtures
    ? {
        fixtures: createFixtureRecorder({ rootDir: path.join(root, 'fixtures') }),
        recordAllFixtures: true,
      }
    : {}),
});

type Outcome = 'ok' | 'fail';
const outcomes: Outcome[] = [];

function line(label: string, method: string, apiPath: string, detail: string) {
  console.log(`${label.padEnd(9)} ${method.padEnd(4)} ${apiPath.padEnd(40)} ${detail}`);
}

async function probe<T>(
  label: string,
  module: ApiModule,
  endpoint: string,
  method: 'GET' | 'POST',
  apiPath: string,
  options: { query?: Record<string, string>; body?: unknown; signed?: boolean; note?: string },
  onSuccess: (data: T) => string,
  expectError?: (error: BinanceApiError) => string | undefined,
): Promise<T | undefined> {
  try {
    const res = await client.request<T>(module, endpoint, { method, path: apiPath, ...options });
    line(
      label,
      method,
      apiPath,
      `HTTP ${res.httpStatus} code ${res.code} ${res.latencyMs} ms — ${onSuccess(res.data)}${options.note ? ` [${options.note}]` : ''}`,
    );
    outcomes.push('ok');
    return res.data;
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    const last = recorded.at(-1);
    const status = error.httpStatus === null ? 'no response' : `HTTP ${error.httpStatus}`;
    const verdict = expectError?.(error);
    line(
      label,
      method,
      apiPath,
      `${status} code ${error.code ?? '-'} ${last ? `${last.latencyMs} ms ` : ''}"${error.msg}" — ${verdict ?? 'FAILED'}${options.note ? ` [${options.note}]` : ''}`,
    );
    outcomes.push(verdict?.startsWith('reached') ? 'ok' : 'fail');
    return undefined;
  }
}

console.log(
  `reach — ${new Date().toISOString()} — ${config.binance.baseUrl} — region ${config.regionTag ?? 'unset'}`,
);
console.log(`config — ${JSON.stringify(describeConfig(config))}`);

await probe(
  'unsigned',
  'market',
  'getSupportedChains',
  'GET',
  '/api/v1/dex/market/supported/chain',
  { signed: false },
  () => 'answered without a key (unexpected, but reachable)',
  (error) => {
    if (error.kind !== 'api') return undefined;
    if (error.code === 40301 || error.code === 40302 || error.code === 40303) {
      return 'BLOCKED by IP compliance (DECISIONS Q-01)';
    }
    return 'reached the gateway (expected: signature required)';
  },
);

let exitCode = 0;
if (!client.hasCredentials) {
  console.log(
    'UNAVAILABLE: no API key (BINANCE_WEB3_API_KEY / BINANCE_WEB3_API_SECRET not set) — skipped signed probes: rwa/getRwaTokenList, market/getTokenPrice',
  );
  exitCode = 3;
} else {
  interface RwaToken {
    binanceChainId?: string;
    tokenContractAddress?: string;
    platformId?: string;
    tokenSymbol?: string;
  }
  const tokens = await probe<RwaToken[]>(
    'signed',
    'rwa',
    'getRwaTokenList',
    'GET',
    '/api/v1/dex/market/rwa/tokens',
    { query: { binanceChainId: '56' } },
    (data) => {
      const byPlatform = new Map<string, number>();
      for (const t of data)
        byPlatform.set(t.platformId ?? '?', (byPlatform.get(t.platformId ?? '?') ?? 0) + 1);
      return `${data.length} RWA tokens on BSC (${[...byPlatform].map(([p, n]) => `${p} ${n}`).join(', ')})`;
    },
  );
  const sample = (tokens ?? []).filter((t) => t.tokenContractAddress).slice(0, 3);
  if (sample.length === 0) {
    line(
      'signed',
      'POST',
      '/api/v1/dex/market/price',
      'SKIPPED — no token addresses from the RWA list',
    );
    outcomes.push('fail');
  } else {
    await probe<{ tokenContractAddress?: string; price?: string }[]>(
      'signed',
      'market',
      'getTokenPrice',
      'POST',
      '/api/v1/dex/market/price',
      {
        body: sample.map((t) => ({
          binanceChainId: '56',
          tokenContractAddress: t.tokenContractAddress,
        })),
        note: 'body shape UNVERIFIED — DECISIONS V-09',
      },
      (data) => `${data.length} prices (${sample.map((t) => t.tokenSymbol ?? '?').join(', ')})`,
    );
  }
  if (outcomes.includes('fail')) exitCode = 1;
}
if (outcomes[0] === 'fail') exitCode = 1;

console.log(
  `clock skew (server − local, last response): ${lastSkewMs === null ? 'n/a' : `${Math.round(lastSkewMs)} ms`}`,
);
if (!database) {
  console.log(
    `api_calls: not recorded (${flags['no-db'] ? '--no-db' : 'no DATABASE_URL'}); ${recorded.length} attempts made`,
  );
} else if (sinkError) {
  const reason = sinkError instanceof Error ? sinkError.message : JSON.stringify(sinkError);
  console.log(`api_calls: FAILED to record — ${reason} (run pnpm db:migrate?)`);
  exitCode = exitCode || 1;
} else {
  console.log(`api_calls: ${recorded.length} rows recorded`);
}
await database?.close();
process.exitCode = exitCode;
