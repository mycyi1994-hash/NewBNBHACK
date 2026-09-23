/**
 * The only module that reads environment variables (CLAUDE.md rule 5: caps are configured in env
 * and read in exactly one place). Everything else receives a validated, frozen `Config`.
 * ESLint forbids `process.env` outside this package; a test forbids the cap names elsewhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

/** An empty value in .env (`KEY=`) means "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());

const httpUrl = (fallback: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), {
        message: 'must be an http(s) URL',
      })
      .default(fallback),
  );

const usd = (fallback: number) =>
  z.preprocess(
    blankToUndefined,
    // zod 4 numbers already exclude NaN and ±Infinity.
    z.coerce
      .number({ message: 'must be a number' })
      .positive({ message: 'must be greater than 0' })
      .default(fallback),
  );

export const envSchema = z
  .object({
    BINANCE_WEB3_API_KEY: optionalText,
    BINANCE_WEB3_API_SECRET: optionalText,
    // Base URL and /build prefix: docs/DECISIONS.md V-01.
    BINANCE_WEB3_BASE_URL: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .refine((v) => URL.canParse(v) && new URL(v).protocol === 'https:', {
          message: 'must be an https URL (the API key travels in headers)',
        })
        .default('https://web3.binance.com/build'),
    ),
    BSC_RPC_URL: httpUrl('https://bsc-dataseed.bnbchain.org'),
    BSC_RPC_URL_FALLBACK: httpUrl('https://bsc-dataseed1.defibit.io'),
    DATABASE_URL: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .refine((v) => URL.canParse(v) && /^postgres(ql)?:$/.test(new URL(v).protocol), {
          message: 'must be a postgres:// URL',
        })
        .optional(),
    ),
    HOUSE_WALLET_PRIVATE_KEY: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{64}$/, { message: 'must be 0x followed by 64 hex characters' })
        .optional(),
    ),
    EXECUTION_MODE: z.preprocess(
      blankToUndefined,
      z.enum(['simulate', 'live'], { message: 'must be "simulate" or "live"' }).default('simulate'),
    ),
    HOUSE_MAX_PER_TX_USD: usd(25),
    SANDBOX_MAX_PER_PLAN_USD: usd(5),
    DAILY_SPEND_CAP_USD: usd(50),
    MIN_BUY_USD: usd(2),
    MAX_PRINCIPAL_USD: usd(1000),
    JUDGE_CODES: z.preprocess(
      blankToUndefined,
      z
        .string()
        .default('')
        .transform((v) =>
          v
            .split(',')
            .map((code) => code.trim())
            .filter(Boolean),
        )
        .refine((codes) => new Set(codes).size === codes.length, {
          message: 'must not contain duplicates',
        }),
    ),
    TELEGRAM_BOT_TOKEN: optionalText,
    TELEGRAM_OPS_CHAT_ID: optionalText,
    // Telemetry label for api_calls.region. Unset stays unset rather than guessing a region.
    REGION_TAG: z.preprocess(
      blankToUndefined,
      z.enum(['kr-dev', 'fra', 'icn'], { message: 'must be kr-dev, fra or icn' }).optional(),
    ),
    NEXT_PUBLIC_APP_URL: httpUrl('http://localhost:3000'),
  })
  .superRefine((env, ctx) => {
    const fail = (key: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [key], message });
    if (env.MIN_BUY_USD > env.HOUSE_MAX_PER_TX_USD) {
      fail('MIN_BUY_USD', 'must not exceed HOUSE_MAX_PER_TX_USD (no buy could ever run)');
    }
    if (env.MIN_BUY_USD > env.SANDBOX_MAX_PER_PLAN_USD) {
      fail('MIN_BUY_USD', 'must not exceed SANDBOX_MAX_PER_PLAN_USD (no sandbox buy could run)');
    }
    if (env.HOUSE_MAX_PER_TX_USD > env.DAILY_SPEND_CAP_USD) {
      fail('HOUSE_MAX_PER_TX_USD', 'must not exceed DAILY_SPEND_CAP_USD');
    }
    if (env.SANDBOX_MAX_PER_PLAN_USD > env.DAILY_SPEND_CAP_USD) {
      fail('SANDBOX_MAX_PER_PLAN_USD', 'must not exceed DAILY_SPEND_CAP_USD');
    }
    if (env.EXECUTION_MODE === 'live') {
      // Live mode signs and spends: it needs credentials, the house key, and the spend ledger
      // (the daily cap is computed from spend_ledger in Postgres).
      const required = [
        'BINANCE_WEB3_API_KEY',
        'BINANCE_WEB3_API_SECRET',
        'HOUSE_WALLET_PRIVATE_KEY',
        'DATABASE_URL',
      ] as const;
      for (const key of required) {
        if (env[key] === undefined) fail(key, 'is required when EXECUTION_MODE=live');
      }
    }
  });

export type EnvInput = Record<string, string | undefined>;

export interface Caps {
  readonly houseMaxPerTxUsd: number;
  readonly sandboxMaxPerPlanUsd: number;
  readonly dailySpendCapUsd: number;
  readonly minBuyUsd: number;
  readonly maxPrincipalUsd: number;
}

export interface Config {
  readonly binance: {
    readonly baseUrl: string;
    readonly apiKey: string | undefined;
    readonly apiSecret: string | undefined;
  };
  readonly bsc: { readonly rpcUrl: string; readonly rpcUrlFallback: string };
  readonly databaseUrl: string | undefined;
  readonly houseWalletPrivateKey: `0x${string}` | undefined;
  readonly executionMode: 'simulate' | 'live';
  readonly caps: Caps;
  readonly judgeCodes: readonly string[];
  readonly telegram: {
    readonly botToken: string | undefined;
    readonly opsChatId: string | undefined;
  };
  readonly regionTag: 'kr-dev' | 'fra' | 'icn' | undefined;
  readonly appUrl: string;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Validates an env record. Messages name the variable, never its value. */
export function parseConfig(input: EnvInput): Config {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(env)'} ${issue.message}`),
    );
  }
  const env = result.data;
  return deepFreeze({
    binance: {
      baseUrl: env.BINANCE_WEB3_BASE_URL.replace(/\/+$/, ''),
      apiKey: env.BINANCE_WEB3_API_KEY,
      apiSecret: env.BINANCE_WEB3_API_SECRET,
    },
    bsc: { rpcUrl: env.BSC_RPC_URL, rpcUrlFallback: env.BSC_RPC_URL_FALLBACK },
    databaseUrl: env.DATABASE_URL,
    houseWalletPrivateKey: env.HOUSE_WALLET_PRIVATE_KEY as `0x${string}` | undefined,
    executionMode: env.EXECUTION_MODE,
    caps: {
      houseMaxPerTxUsd: env.HOUSE_MAX_PER_TX_USD,
      sandboxMaxPerPlanUsd: env.SANDBOX_MAX_PER_PLAN_USD,
      dailySpendCapUsd: env.DAILY_SPEND_CAP_USD,
      minBuyUsd: env.MIN_BUY_USD,
      maxPrincipalUsd: env.MAX_PRINCIPAL_USD,
    },
    judgeCodes: env.JUDGE_CODES,
    telegram: { botToken: env.TELEGRAM_BOT_TOKEN, opsChatId: env.TELEGRAM_OPS_CHAT_ID },
    regionTag: env.REGION_TAG,
    appUrl: env.NEXT_PUBLIC_APP_URL,
  });
}

/** Directory holding pnpm-workspace.yaml, searched upward from `from`. */
export function findWorkspaceRoot(from: string = process.cwd()): string | undefined {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadOptions {
  /** Path of a .env file, or false to skip. Default: `<workspace root>/.env` when it exists. */
  envFile?: string | false;
  /** Defaults to process.env. Real environment variables win over the file, like dotenv. */
  env?: EnvInput;
}

export function loadConfig(options: LoadOptions = {}): Config {
  const envFile =
    options.envFile === false
      ? undefined
      : (options.envFile ?? path.join(findWorkspaceRoot() ?? process.cwd(), '.env'));
  const fromFile = envFile && existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  return parseConfig({ ...fromFile, ...(options.env ?? process.env) });
}

/** A loggable view: secrets become booleans, the database URL loses its credentials. */
export function describeConfig(config: Config): Record<string, unknown> {
  const db = config.databaseUrl ? new URL(config.databaseUrl) : undefined;
  return {
    executionMode: config.executionMode,
    regionTag: config.regionTag ?? 'unset',
    caps: config.caps,
    binance: {
      baseUrl: config.binance.baseUrl,
      apiKey: config.binance.apiKey !== undefined,
      apiSecret: config.binance.apiSecret !== undefined,
    },
    bsc: config.bsc,
    database: db ? `${db.protocol}//${db.host}${db.pathname}` : 'unset',
    houseWalletKey: config.houseWalletPrivateKey !== undefined,
    judgeCodes: config.judgeCodes.length,
    telegram: config.telegram.botToken !== undefined && config.telegram.opsChatId !== undefined,
    appUrl: config.appUrl,
  };
}
