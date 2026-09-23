import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  describeConfig,
  envSchema,
  findWorkspaceRoot,
  loadConfig,
  parseConfig,
} from './index.js';

const ROOT = findWorkspaceRoot(import.meta.dirname) ?? '';
const EXAMPLE_PATH = path.join(ROOT, '.env.example');
const example = parseEnv(readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, string>;
const CAP_NAMES = [
  'HOUSE_MAX_PER_TX_USD',
  'SANDBOX_MAX_PER_PLAN_USD',
  'DAILY_SPEND_CAP_USD',
  'MIN_BUY_USD',
  'MAX_PRINCIPAL_USD',
];

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('env schema vs .env.example', () => {
  it('validates exactly the variables declared in .env.example', () => {
    expect(Object.keys(envSchema.shape).sort()).toEqual(Object.keys(example).sort());
  });

  it('parses .env.example and yields the documented defaults', () => {
    const config = parseConfig(example);
    expect(config.executionMode).toBe('simulate');
    expect(config.binance.baseUrl).toBe('https://web3.binance.com/build');
    expect(config.caps).toEqual({
      houseMaxPerTxUsd: 25,
      sandboxMaxPerPlanUsd: 5,
      dailySpendCapUsd: 50,
      minBuyUsd: 2,
      maxPrincipalUsd: 1000,
    });
    expect(config.binance.apiKey).toBeUndefined();
    expect(config.houseWalletPrivateKey).toBeUndefined();
    expect(config.judgeCodes).toEqual([]);
    expect(config.regionTag).toBe('kr-dev');
  });

  it('uses the same values as .env.example when a variable is absent', () => {
    const fromExample = parseConfig(example);
    const fromNothing = parseConfig({ DATABASE_URL: example.DATABASE_URL, REGION_TAG: 'kr-dev' });
    expect(fromNothing).toEqual(fromExample);
  });
});

describe('caps', () => {
  it('are frozen', () => {
    const { caps } = parseConfig({});
    expect(Object.isFrozen(caps)).toBe(true);
    expect(() => {
      (caps as { houseMaxPerTxUsd: number }).houseMaxPerTxUsd = 1_000_000;
    }).toThrow(TypeError);
  });

  it.each([
    ['0', 'must be greater than 0'],
    ['-5', 'must be greater than 0'],
    ['abc', 'must be a number'],
    ['Infinity', 'must be a number'],
  ])('rejects HOUSE_MAX_PER_TX_USD=%s', (value, message) => {
    const error = errorOf(() => parseConfig({ HOUSE_MAX_PER_TX_USD: value }));
    expect(error.issues).toContainEqual(expect.stringContaining('HOUSE_MAX_PER_TX_USD'));
    expect(error.message).toContain(message);
  });

  it('rejects a minimum buy above the per-plan sandbox cap', () => {
    const error = errorOf(() => parseConfig({ MIN_BUY_USD: '6' }));
    expect(error.issues.join('\n')).toContain(
      'MIN_BUY_USD must not exceed SANDBOX_MAX_PER_PLAN_USD',
    );
  });

  it('rejects a per-transaction cap above the daily cap', () => {
    const error = errorOf(() => parseConfig({ HOUSE_MAX_PER_TX_USD: '60' }));
    expect(error.issues.join('\n')).toContain(
      'HOUSE_MAX_PER_TX_USD must not exceed DAILY_SPEND_CAP_USD',
    );
  });
});

describe('secrets and modes', () => {
  it('treats blank values as unset', () => {
    const config = parseConfig({ BINANCE_WEB3_API_KEY: '  ', TELEGRAM_BOT_TOKEN: '' });
    expect(config.binance.apiKey).toBeUndefined();
    expect(config.telegram.botToken).toBeUndefined();
  });

  it('requires keys, house key and database in live mode', () => {
    const error = errorOf(() => parseConfig({ EXECUTION_MODE: 'live' }));
    for (const key of [
      'BINANCE_WEB3_API_KEY',
      'BINANCE_WEB3_API_SECRET',
      'HOUSE_WALLET_PRIVATE_KEY',
      'DATABASE_URL',
    ]) {
      expect(error.issues).toContain(`${key} is required when EXECUTION_MODE=live`);
    }
  });

  it('never echoes a malformed private key', () => {
    const secret = '0xnot-a-real-key-but-still-secret';
    const error = errorOf(() => parseConfig({ HOUSE_WALLET_PRIVATE_KEY: secret }));
    expect(error.message).toContain('HOUSE_WALLET_PRIVATE_KEY');
    expect(error.message).not.toContain(secret);
  });

  it('requires https for the Web3 API base URL', () => {
    const error = errorOf(() =>
      parseConfig({ BINANCE_WEB3_BASE_URL: 'http://web3.binance.com/build' }),
    );
    expect(error.issues.join('\n')).toContain('BINANCE_WEB3_BASE_URL must be an https URL');
  });

  it('splits and de-duplicates-checks judge codes', () => {
    expect(parseConfig({ JUDGE_CODES: ' A1, B2 ,,C3' }).judgeCodes).toEqual(['A1', 'B2', 'C3']);
    expect(() => parseConfig({ JUDGE_CODES: 'A1,A1' })).toThrow(ConfigError);
  });

  it('describeConfig shows presence of secrets, not their values', () => {
    const key = `0x${'ab'.repeat(32)}`;
    const described = JSON.stringify(
      describeConfig(
        parseConfig({
          BINANCE_WEB3_API_KEY: 'key-value',
          BINANCE_WEB3_API_SECRET: 'secret-value',
          HOUSE_WALLET_PRIVATE_KEY: key,
          DATABASE_URL: 'postgres://ijaro:hunter2@db.example:5432/ijaro',
        }),
      ),
    );
    for (const leaked of ['key-value', 'secret-value', key, 'hunter2']) {
      expect(described).not.toContain(leaked);
    }
    expect(described).toContain('postgres://db.example:5432/ijaro');
  });

  it('loadConfig lets real environment variables win over the .env file', () => {
    const config = loadConfig({ envFile: EXAMPLE_PATH, env: { MIN_BUY_USD: '3' } });
    expect(config.caps.minBuyUsd).toBe(3);
    expect(config.caps.houseMaxPerTxUsd).toBe(25);
  });
});

describe('architecture: caps are read only in packages/config', () => {
  const SOURCE = /\.(ts|tsx|mts|js|mjs|cjs)$/;
  const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage']);
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (SKIP.has(entry.name)) return [];
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : SOURCE.test(entry.name) ? [full] : [];
    });
  }

  it('no source file outside packages/config mentions a cap variable', () => {
    const configDir = path.join(ROOT, 'packages', 'config') + path.sep;
    const offenders = ['apps', 'packages', 'scripts']
      .flatMap((dir) => walk(path.join(ROOT, dir)))
      .filter((file) => !file.startsWith(configDir))
      .filter((file) => CAP_NAMES.some((name) => readFileSync(file, 'utf8').includes(name)));
    expect(offenders).toEqual([]);
  });
});
