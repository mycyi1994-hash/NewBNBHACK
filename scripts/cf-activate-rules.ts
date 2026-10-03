/**
 * The decisions of `pnpm cf:activate` (DECISIONS D-36, RUNBOOK §6.3) as pure functions, so every
 * refusal is a unit test (cf-activate-rules.test.ts); cf-activate.ts does the I/O. It puts the
 * Worker `yieldvest` on the production database with its three secrets, written in one
 * `wrangler secret bulk` request over stdin: never in argv, a file or the output.
 */

/** The only Worker this command writes to (D-36). */
export const WORKER = 'yieldvest';

/** Hosts a Worker cannot reach: the database must be on the public internet. */
const PRIVATE_HOST =
  /^(localhost|.+\.localhost|.+\.local|.+\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

/** sslmode values under which postgres.js always encrypts the connection. */
const ENCRYPTED = new Set(['require', 'verify-ca', 'verify-full']);

/** Why the Worker cannot use `databaseUrl`, or undefined. Never quotes the URL: it holds a password. */
export function databaseUrlProblem(databaseUrl: string): string | undefined {
  if (!URL.canParse(databaseUrl)) return 'that is not a URL';
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return `the URL must start with postgres:// or postgresql://, not ${url.protocol}//`;
  }
  if (url.hostname === '') return 'the URL names no host';
  if (PRIVATE_HOST.test(url.hostname)) {
    return `${url.hostname} is not reachable from Cloudflare: use the production database's public host`;
  }
  if (url.pathname.length <= 1) return 'the URL names no database (…/<name> after the host)';
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode === null || !ENCRYPTED.has(sslmode)) {
    return 'the connection must be encrypted: end the URL with ?sslmode=require (Neon’s connection string has it)';
  }
  return undefined;
}

/** The database as messages name it: host and database, never the user or password. */
export function databaseLabel(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}${url.pathname}`;
}

/** `text` (a driver's error message) with the URL's password replaced, however it is spelled. */
export function redact(text: string, databaseUrl: string): string {
  if (!URL.canParse(databaseUrl)) return text;
  const raw = new URL(databaseUrl).password;
  if (raw === '') return text;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape: only the raw spelling can appear.
  }
  return [raw, decoded].reduce((out, secret) => out.split(secret).join('***'), text);
}

/** What the migration check found: tags the database lacks, and rows this checkout does not know. */
export function migrationGap(
  applied: readonly string[],
  journal: readonly string[],
): { pending: string[]; unknown: string[] } {
  const done = new Set(applied);
  return {
    pending: journal.filter((tag) => !done.has(tag)),
    unknown: applied.filter((tag) => tag.startsWith('unknown@')),
  };
}

const CODE = /^[A-Za-z0-9_-]{6,64}$/;
export const MAX_CODES = 20;

/** Invite codes as `--codes A,B,C` gives them: trimmed, empty entries dropped. */
export function splitCodes(list: string): string[] {
  return list
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code !== '');
}

/** Why these invite codes cannot be JUDGE_CODES, or undefined. Never quotes a code. */
export function inviteCodesProblem(codes: readonly string[]): string | undefined {
  if (codes.length === 0) return 'no invite code given';
  if (codes.length > MAX_CODES) return `at most ${MAX_CODES} invite codes, not ${codes.length}`;
  const bad = codes.findIndex((code) => !CODE.test(code));
  if (bad >= 0) {
    return `invite code ${bad + 1} must be 6–64 letters, digits, - or _`;
  }
  if (new Set(codes).size !== codes.length) return 'an invite code is listed twice';
  return undefined;
}

/** No 0/O, 1/I/L or U: a code read aloud or copied by hand stays the same code. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * `count` new invite codes as YV-XXXX-XXXX-XXXX: 12 characters from a 30-letter alphabet (about
 * 59 bits), drawn by rejection so every letter is equally likely. `random(n)` returns n random
 * bytes (crypto.randomBytes).
 */
export function newInviteCodes(count: number, random: (n: number) => Uint8Array): string[] {
  const limit = 256 - (256 % ALPHABET.length);
  const codes: string[] = [];
  while (codes.length < count) {
    let letters = '';
    while (letters.length < 12) {
      for (const byte of random(16)) {
        if (byte < limit && letters.length < 12) letters += ALPHABET[byte % ALPHABET.length];
      }
    }
    const code = `YV-${letters.slice(0, 4)}-${letters.slice(4, 8)}-${letters.slice(8)}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** SESSION_SECRET: 32 random bytes as 64 hex characters (the config wants 32 or more). */
export function newSessionSecret(random: (n: number) => Uint8Array): string {
  return Buffer.from(random(32)).toString('hex');
}

/** The JSON `wrangler secret bulk` reads from stdin: exactly the three secrets, nothing else. */
export function secretsPayload(secrets: {
  databaseUrl: string;
  sessionSecret: string;
  inviteCodes: readonly string[];
}): string {
  return JSON.stringify({
    DATABASE_URL: secrets.databaseUrl,
    SESSION_SECRET: secrets.sessionSecret,
    JUDGE_CODES: secrets.inviteCodes.join(','),
  });
}

/** wrangler.jsonc without its comments, keeping `//` inside strings (the URLs). */
function stripJsonComments(jsonc: string): string {
  return jsonc
    .replace(
      /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (_match, text?: string) => text ?? '',
    )
    .replace(/,(\s*[}\]])/g, '$1');
}

/** The Worker and its public URL from apps/web/wrangler.jsonc, or why they cannot be used. */
export function workerTarget(jsonc: string): { name: string; url: string } | { problem: string } {
  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(jsonc));
  } catch {
    return { problem: 'apps/web/wrangler.jsonc could not be read' };
  }
  const { name, vars } = (config ?? {}) as { name?: unknown; vars?: Record<string, unknown> };
  if (name !== WORKER) {
    return {
      problem: `wrangler.jsonc names the Worker ${String(name)}; this command writes only to ${WORKER}`,
    };
  }
  const url = vars?.NEXT_PUBLIC_APP_URL;
  if (typeof url !== 'string' || !URL.canParse(url) || new URL(url).protocol !== 'https:') {
    return { problem: 'wrangler.jsonc has no https NEXT_PUBLIC_APP_URL for the Worker' };
  }
  return { name, url: url.replace(/\/+$/, '') };
}
