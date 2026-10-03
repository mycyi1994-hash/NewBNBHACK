import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  databaseLabel,
  databaseUrlProblem,
  inviteCodesProblem,
  MAX_CODES,
  migrationGap,
  newInviteCodes,
  newSessionSecret,
  redact,
  secretsPayload,
  splitCodes,
  workerTarget,
} from './cf-activate-rules.js';

const NEON =
  'postgresql://owner:s3cret-pw@ep-quiet-fog-a1b2c3.eu-central-1.aws.neon.tech/yieldvest?sslmode=require&channel_binding=require';

describe('databaseUrlProblem', () => {
  it('accepts a Neon connection string as Neon gives it', () => {
    expect(databaseUrlProblem(NEON)).toBeUndefined();
    expect(databaseUrlProblem(NEON.replace('postgresql:', 'postgres:'))).toBeUndefined();
    expect(
      databaseUrlProblem(NEON.replace('sslmode=require', 'sslmode=verify-full')),
    ).toBeUndefined();
  });

  it('refuses what a Worker cannot use, and never quotes the URL (it holds a password)', () => {
    const cases: [string, RegExp][] = [
      ['not a url', /not a URL/],
      ['mysql://u:p@db.example.com/app?sslmode=require', /postgres:\/\//],
      [
        'postgres://u:s3cret-pw@localhost:5432/app?sslmode=require',
        /not reachable from Cloudflare/,
      ],
      ['postgres://u:s3cret-pw@127.0.0.1:55432/app?sslmode=require', /not reachable/],
      ['postgres://u:s3cret-pw@10.0.0.7/app?sslmode=require', /not reachable/],
      ['postgres://u:s3cret-pw@db.internal/app?sslmode=require', /not reachable/],
      ['postgres://u:s3cret-pw@db.example.com/?sslmode=require', /names no database/],
      ['postgres://u:s3cret-pw@db.example.com/app', /sslmode=require/],
      ['postgres://u:s3cret-pw@db.example.com/app?sslmode=prefer', /must be encrypted/],
      ['postgres://u:s3cret-pw@db.example.com/app?sslmode=disable', /must be encrypted/],
    ];
    for (const [url, reason] of cases) {
      const problem = databaseUrlProblem(url);
      expect(problem, url).toMatch(reason);
      expect(problem).not.toContain('s3cret-pw');
    }
  });

  it('takes the password out of a driver message, raw or percent-encoded', () => {
    const url = 'postgres://owner:p%40ss%2Fw0rd@db.example.com/app?sslmode=require';
    expect(redact('auth failed for p@ss/w0rd and p%40ss%2Fw0rd', url)).toBe(
      'auth failed for *** and ***',
    );
    expect(redact('no password here', 'postgres://owner@db.example.com/app')).toBe(
      'no password here',
    );
    expect(redact('kept', 'not a url')).toBe('kept');
  });

  it('names the database by host and name only', () => {
    expect(databaseLabel(NEON)).toBe('ep-quiet-fog-a1b2c3.eu-central-1.aws.neon.tech/yieldvest');
  });
});

describe('migrationGap', () => {
  const journal = ['0000_init', '0001_plans', '0010_wallet_index'];

  it('lists what the database still lacks, oldest first', () => {
    expect(migrationGap(['0000_init'], journal)).toEqual({
      pending: ['0001_plans', '0010_wallet_index'],
      unknown: [],
    });
    expect(migrationGap(journal, journal)).toEqual({ pending: [], unknown: [] });
    expect(migrationGap([], journal).pending).toEqual(journal);
  });

  it('reports rows this checkout does not know (the database is ahead of it)', () => {
    expect(migrationGap([...journal, 'unknown@1790000000000'], journal).unknown).toEqual([
      'unknown@1790000000000',
    ]);
  });
});

describe('invite codes', () => {
  it('splits a --codes list the way the config reads JUDGE_CODES', () => {
    expect(splitCodes(' ALPHA-1234 , BRAVO-5678,,')).toEqual(['ALPHA-1234', 'BRAVO-5678']);
  });

  it('refuses codes the web or the submission form would trip on, without quoting them', () => {
    expect(inviteCodesProblem([])).toMatch(/no invite code/);
    expect(inviteCodesProblem(['short'])).toMatch(/invite code 1 must be 6–64/);
    expect(inviteCodesProblem(['GOOD-CODE-1', 'has space'])).toMatch(/invite code 2/);
    expect(inviteCodesProblem(['GOOD-CODE-1', 'GOOD-CODE-1'])).toMatch(/listed twice/);
    expect(
      inviteCodesProblem(Array.from({ length: MAX_CODES + 1 }, (_, i) => `CODE-${i}-xx`)),
    ).toMatch(/at most 20/);
    expect(inviteCodesProblem(['GOOD-CODE-1', 'judge_2026'])).toBeUndefined();
    expect(inviteCodesProblem(['has space'])).not.toContain('has space');
  });

  it('makes distinct, unambiguous codes that pass its own check', () => {
    const codes = newInviteCodes(5, randomBytes);
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
    for (const code of codes)
      expect(code).toMatch(/^YV-[2-9A-HJKMNP-TV-Z]{4}(-[2-9A-HJKMNP-TV-Z]{4}){2}$/);
    expect(inviteCodesProblem(codes)).toBeUndefined();
  });

  it('draws letters by rejection: a byte of 240 or more is skipped, never folded in', () => {
    // Folded in with % 30, the bytes 240–255 would favour the alphabet's first 16 letters.
    const bytes = Uint8Array.from([
      250,
      255,
      240,
      241,
      ...Array.from({ length: 12 }, (_, i) => i + 4),
    ]);
    expect(newInviteCodes(1, () => bytes)).toEqual(['YV-6789-ABCD-EFGH']);
  });
});

describe('secrets', () => {
  it('makes a 64-character session secret from 32 random bytes', () => {
    const secret = newSessionSecret(randomBytes);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(newSessionSecret(randomBytes)).not.toBe(secret);
  });

  it('writes exactly the three secrets, JUDGE_CODES as the config reads it', () => {
    expect(
      JSON.parse(
        secretsPayload({
          databaseUrl: NEON,
          sessionSecret: 'f'.repeat(64),
          inviteCodes: ['YV-AAAA-BBBB-CCCC', 'YV-DDDD-EEEE-FFFF'],
        }),
      ),
    ).toEqual({
      DATABASE_URL: NEON,
      SESSION_SECRET: 'f'.repeat(64),
      JUDGE_CODES: 'YV-AAAA-BBBB-CCCC,YV-DDDD-EEEE-FFFF',
    });
  });
});

describe('workerTarget', () => {
  it('reads the repository’s wrangler.jsonc: the yieldvest Worker and its https URL', () => {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'apps/web/wrangler.jsonc',
    );
    expect(workerTarget(readFileSync(file, 'utf8'))).toEqual({
      name: 'yieldvest',
      url: 'https://yieldvest.gana003.workers.dev',
    });
  });

  it('keeps // inside strings and drops comments and trailing commas', () => {
    const jsonc = `// a comment
      { "name": "yieldvest", /* block */ "vars": { "NEXT_PUBLIC_APP_URL": "https://example.workers.dev/", }, }`;
    expect(workerTarget(jsonc)).toEqual({ name: 'yieldvest', url: 'https://example.workers.dev' });
  });

  it('refuses any other Worker, a missing or plain-http URL, and a file it cannot read', () => {
    expect(workerTarget('{"name":"other","vars":{"NEXT_PUBLIC_APP_URL":"https://x.dev"}}')).toEqual(
      {
        problem: 'wrangler.jsonc names the Worker other; this command writes only to yieldvest',
      },
    );
    expect(workerTarget('{"name":"yieldvest"}')).toHaveProperty('problem');
    expect(
      workerTarget('{"name":"yieldvest","vars":{"NEXT_PUBLIC_APP_URL":"http://x.dev"}}'),
    ).toHaveProperty('problem');
    expect(workerTarget('{ not json')).toEqual({
      problem: 'apps/web/wrangler.jsonc could not be read',
    });
  });
});
