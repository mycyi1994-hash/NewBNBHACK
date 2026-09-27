import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
      minBuyUsd: 0.25,
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

describe('session secret', () => {
  it('is optional, never shown, and must be long enough to sign cookies', () => {
    expect(parseConfig({}).sessionSecret).toBeUndefined();
    const secret = 's'.repeat(32);
    const config = parseConfig({ SESSION_SECRET: secret });
    expect(config.sessionSecret).toBe(secret);
    expect(JSON.stringify(describeConfig(config))).not.toContain(secret);
    expect(describeConfig(config).sessionSecret).toBe(true);
    expect(() => parseConfig({ SESSION_SECRET: 'short' })).toThrow(
      'SESSION_SECRET must be at least 32 characters',
    );
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

  // Consumers turn caps back into text for toUnits(): String(5e-7) is '5e-7', which it refuses.
  it.each(
    CAP_NAMES.flatMap((name) =>
      ['1e21', '0x19', '0.0000005', '2.5e1', '+5', '25.', '.5', '1_000'].map((raw) => [name, raw]),
    ),
  )('rejects %s=%s (not a plain decimal)', (name, raw) => {
    const error = errorOf(() => parseConfig({ [name]: raw }));
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatch(
      new RegExp(`^${name} must be (a plain decimal such as 25 or 0\\.25|a number)`),
    );
    expect(error.message).not.toContain(raw);
  });

  it('bounds every cap at 1,000,000 and the minimum buy at one cent', () => {
    for (const name of CAP_NAMES) {
      expect(errorOf(() => parseConfig({ [name]: '1000000.5' })).issues).toEqual([
        `${name} must be at most 1000000`,
      ]);
    }
    expect(errorOf(() => parseConfig({ MIN_BUY_USD: '0.009' })).issues).toEqual([
      'MIN_BUY_USD must be at least 0.01',
    ]);
    expect(parseConfig({ MIN_BUY_USD: '0.01' }).caps.minBuyUsd).toBe(0.01);
    expect(parseConfig({ MAX_PRINCIPAL_USD: '1000000' }).caps.maxPrincipalUsd).toBe(1_000_000);
  });

  it('keeps accepted caps numeric, and their text form a plain decimal again', () => {
    const { caps } = parseConfig({
      HOUSE_MAX_PER_TX_USD: ' 12.345678 ',
      MAX_PRINCIPAL_USD: '0.000001',
      DAILY_SPEND_CAP_USD: '999999.999999',
    });
    expect(caps).toMatchObject({
      houseMaxPerTxUsd: 12.345678,
      maxPrincipalUsd: 0.000001,
      dailySpendCapUsd: 999_999.999999,
    });
    for (const value of Object.values(caps)) expect(String(value)).toMatch(/^\d+(\.\d{1,6})?$/);
  });

  it('rejects a minimum buy above the per-plan sandbox cap', () => {
    const error = errorOf(() => parseConfig({ MIN_BUY_USD: '6' }));
    expect(error.issues.join('\n')).toContain(
      'MIN_BUY_USD must not exceed SANDBOX_MAX_PER_PLAN_USD',
    );
  });

  it('rejects a sandbox plan cap above the house per-transaction cap (the house signs judge buys)', () => {
    const error = errorOf(() =>
      parseConfig({ SANDBOX_MAX_PER_PLAN_USD: '30', HOUSE_MAX_PER_TX_USD: '25' }),
    );
    expect(error.issues).toEqual([
      'SANDBOX_MAX_PER_PLAN_USD must not exceed HOUSE_MAX_PER_TX_USD (judge plans are signed by the house wallet)',
    ]);
    // Equal is fine: a judge buy may use the whole house per-transaction cap.
    expect(
      parseConfig({ SANDBOX_MAX_PER_PLAN_USD: '25', HOUSE_MAX_PER_TX_USD: '25' }).caps,
    ).toMatchObject({ sandboxMaxPerPlanUsd: 25, houseMaxPerTxUsd: 25 });
    // Lowering the house cap alone below the default sandbox cap ($5) is caught too.
    expect(errorOf(() => parseConfig({ HOUSE_MAX_PER_TX_USD: '4' })).issues).toContain(
      'SANDBOX_MAX_PER_PLAN_USD must not exceed HOUSE_MAX_PER_TX_USD (judge plans are signed by the house wallet)',
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

  it('loadConfig never lets a blank real cap hide the cap in the .env file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ijaro-config-'));
    try {
      const envFile = path.join(dir, '.env');
      writeFileSync(
        envFile,
        'DAILY_SPEND_CAP_USD=10\nHOUSE_MAX_PER_TX_USD=5\nBINANCE_WEB3_API_KEY=key-from-file\n',
      );
      for (const blank of ['', '   ']) {
        // Before: the blank variable won, counted as unset, and the default daily cap (50) applied.
        const { caps } = loadConfig({
          envFile,
          env: { DAILY_SPEND_CAP_USD: blank, HOUSE_MAX_PER_TX_USD: blank },
        });
        expect([caps.dailySpendCapUsd, caps.houseMaxPerTxUsd]).toEqual([10, 5]);
      }
      // A real value still wins over the file.
      expect(loadConfig({ envFile, env: { DAILY_SPEND_CAP_USD: '8' } }).caps.dailySpendCapUsd).toBe(
        8,
      );
      // Everything else keeps "blank = unset": that is its safe side, and the web tests use it
      // to keep a developer's keys out of the test process.
      expect(
        loadConfig({ envFile, env: { BINANCE_WEB3_API_KEY: '' } }).binance.apiKey,
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Files under `root` that name a cap variable outside the allowed places, relative to `root`.
 * Scanned: every text file (any extension: .cts, .jsx, .sh, .yml, nested .env files, …) under
 * apps/, packages/, scripts/, skills/ and .github/, and every file at the root. Allowed:
 * packages/config, the root env files (.env.example documents the caps, a local .env sets them)
 * and Markdown prose at the root, like docs/*.md, which is not scanned.
 */
function capOffenders(root: string): string[] {
  const TREES = ['apps', 'packages', 'scripts', 'skills', '.github'];
  const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo', '.git']);
  const configDir = path.join(root, 'packages', 'config') + path.sep;
  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          if (SKIP.has(entry.name)) return [];
          const full = path.join(dir, entry.name);
          return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : [];
        })
      : [];
  const rootFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => !/^\.env(\..+)?$/.test(entry.name) && !entry.name.endsWith('.md'))
    .map((entry) => path.join(root, entry.name));
  return [...TREES.flatMap((tree) => walk(path.join(root, tree))), ...rootFiles]
    .filter((file) => !file.startsWith(configDir))
    .filter((file) => {
      const bytes = readFileSync(file);
      if (bytes.includes(0)) return false; // binary (images, fonts)
      const text = bytes.toString('utf8');
      return CAP_NAMES.some((name) => text.includes(name));
    })
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .sort();
}

describe('architecture: caps are read only in packages/config', () => {
  it('no file outside packages/config and the root env files names a cap variable', () => {
    expect(capOffenders(ROOT)).toEqual([]);
  });

  it('looks at every file type, skills/, .github/ and the root, not only .ts sources', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ijaro-arch-'));
    try {
      const put = (file: string, text: string | Buffer) => {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), text);
      };
      const cap = 'DAILY_SPEND_CAP_USD';
      // Allowed places.
      put('packages/config/src/index.ts', `const cap = '${cap}';`);
      put('.env.example', `${cap}=50\n`);
      put('.env', `${cap}=10\n`);
      put('CLAUDE.md', `total <= ${cap}\n`);
      put('docs/SPEC.md', `${cap}\n`);
      put('apps/web/public/logo.png', Buffer.concat([Buffer.from([0x89, 0, 1]), Buffer.from(cap)]));
      // Everything else.
      put('apps/agent/src/caps.cts', `process.env.${cap}`);
      put('apps/web/components/Cap.jsx', `<p>{'${cap}'}</p>`);
      put('apps/web/.env.production', `${cap}=500\n`);
      put('packages/core/src/legacy.cjs', `module.exports = '${cap}';`);
      put('scripts/cap.sh', `echo $${cap}\n`);
      put('skills/ijaro/SKILL.md', `Read ${cap} from the environment.\n`);
      put('.github/workflows/ci.yml', `env:\n  ${cap}: 5000\n`);
      put('fly.toml', `[env]\n  ${cap} = "5000"\n`);
      put('vitest.config.ts', `export const cap = '${cap}';`);
      expect(capOffenders(root)).toEqual([
        '.github/workflows/ci.yml',
        'apps/agent/src/caps.cts',
        'apps/web/.env.production',
        'apps/web/components/Cap.jsx',
        'fly.toml',
        'packages/core/src/legacy.cjs',
        'scripts/cap.sh',
        'skills/ijaro/SKILL.md',
        'vitest.config.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
