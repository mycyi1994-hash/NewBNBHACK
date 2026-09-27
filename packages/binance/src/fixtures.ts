/**
 * Saves real responses as `fixtures/<module>/<endpoint>-<yyyymmdd>-<n>.json` (SPEC §3.1 item 4).
 * Listed secrets and our own wallet addresses are redacted before anything touches the disk;
 * request headers (API key, signature) are never written.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonLossless, stringifyJsonLossless } from './json.js';
import type { ApiModule } from './modules.js';
import { redactValues } from './telemetry.js';

export interface FixtureEntry {
  module: ApiModule;
  endpoint: string;
  recordedAt: Date;
  /** Values the caller also wants redacted (the client passes its key and secret). */
  redact?: readonly string[];
  request: { method: string; requestPath: string; body: string };
  response: { httpStatus: number; headers: Headers; bodyText: string };
}

/** Returns the fixture path relative to the parent of the fixtures directory. */
export type FixtureRecorder = (entry: FixtureEntry) => Promise<string>;

export interface FixtureRecorderOptions {
  /** Absolute path of the `fixtures/` directory. */
  rootDir: string;
  /** Exact values to redact: API key/secret, house wallet and user addresses. */
  redact?: readonly string[];
}

const KEPT_RESPONSE_HEADERS = [
  'content-type',
  'date',
  'retry-after',
  'x-oc-ratelimit-limit',
  'x-oc-ratelimit-remaining',
  'x-oc-used-weight',
  'x-amzn-waf-action',
  'x-request-id',
  'x-oc-request-id',
  'x-amzn-requestid',
  'x-amz-cf-id',
];

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function jsonOrText(text: string): unknown {
  if (text === '') return null;
  try {
    return parseJsonLossless(text);
  } catch {
    return text;
  }
}

export function createFixtureRecorder(options: FixtureRecorderOptions): FixtureRecorder {
  return async (entry) => {
    const redact = [...(options.redact ?? []), ...(entry.redact ?? [])];
    if (!/^[A-Za-z0-9_-]+$/.test(entry.endpoint)) {
      throw new Error(`fixture endpoint name must be a plain identifier: ${entry.endpoint}`);
    }
    const dir = path.join(options.rootDir, entry.module);
    await mkdir(dir, { recursive: true });
    const headers: Record<string, string> = {};
    for (const name of KEPT_RESPONSE_HEADERS) {
      const value = entry.response.headers.get(name);
      if (value !== null) headers[name] = redactValues(value, redact);
    }
    const document = stringifyJsonLossless(
      {
        recordedAt: entry.recordedAt.toISOString(),
        module: entry.module,
        endpoint: entry.endpoint,
        request: {
          method: entry.request.method,
          path: redactValues(entry.request.requestPath, redact),
          body: jsonOrText(redactValues(entry.request.body, redact)),
        },
        response: {
          httpStatus: entry.response.httpStatus,
          headers,
          body: jsonOrText(redactValues(entry.response.bodyText, redact)),
        },
      },
      2,
    );

    const prefix = `${entry.endpoint}-${yyyymmdd(entry.recordedAt)}-`;
    const taken = (await readdir(dir))
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .map((name) => Number(name.slice(prefix.length, -'.json'.length)))
      .filter(Number.isInteger);
    let n = taken.length ? Math.max(...taken) + 1 : 1;
    for (;;) {
      const file = path.join(dir, `${prefix}${n}.json`);
      try {
        await writeFile(file, `${document}\n`, { flag: 'wx' });
        return path.relative(path.dirname(options.rootDir), file).split(path.sep).join('/');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        n += 1;
      }
    }
  };
}
