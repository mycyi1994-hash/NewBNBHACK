/**
 * pnpm cf:activate [--codes <A,B,…>] — puts the live site, the Cloudflare Worker `yieldvest`
 * (DECISIONS D-36), on the production database in one command (RUNBOOK §6.3).
 *
 * Asks for the production DATABASE_URL with the echo off and checks it before anything is
 * written: a public host, an encrypted connection, reachable from this machine, and every
 * migration of this checkout applied — pending ones are applied after a typed `y` (the worker
 * applies the same on its next boot). Makes SESSION_SECRET (32 random bytes) and three invite
 * codes, unless --codes gives them. After a second typed `y` it writes the three secrets to the
 * Worker in one `wrangler secret bulk` request over stdin — never in argv, a file or the output —
 * waits for the new version, runs `pnpm smoke` on the Worker's URL and prints the invite codes.
 * Needs an interactive terminal and a wrangler login (`npx wrangler login`, or
 * CLOUDFLARE_API_TOKEN). Exit: 0 done · 1 failed or refused · 2 usage.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { appliedMigrations, createDb, migrateDb, migrationJournal } from '@yieldvest/db';
import { parseFlags } from './args.js';
import {
  databaseLabel,
  databaseUrlProblem,
  inviteCodesProblem,
  migrationGap,
  newInviteCodes,
  newSessionSecret,
  redact,
  secretsPayload,
  splitCodes,
  workerTarget,
} from './cf-activate-rules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'apps/web');
const INVITES = 3;
/** A new Worker version reaches every location within seconds; give it a minute. */
const ROLLOUT_TRIES = 12;
const ROLLOUT_WAIT_MS = 5_000;

const flags = parseFlags(process.argv.slice(2), { values: ['codes'] });

/** Ctrl-C at a question stops the command; nothing after that question has happened. */
function stopOnInterrupt(rl: { on(event: 'SIGINT', listener: () => void): unknown }): void {
  rl.on('SIGINT', () => {
    process.stdout.write('\nstopped.\n');
    process.exit(130);
  });
}

/** One line typed with the echo off: the terminal shows nothing of it. */
async function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Uint8Array, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  stopOnInterrupt(rl);
  try {
    process.stdout.write(question);
    muted = true;
    return (await rl.question('')).trim();
  } finally {
    muted = false;
    rl.close();
    process.stdout.write('\n');
  }
}

async function askYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  stopOnInterrupt(rl);
  try {
    const answer = await rl.question(`${question} Type y to go on, anything else to stop: `);
    return answer.trim() === 'y';
  } finally {
    rl.close();
  }
}

/** Runs a command with the given stdin; its own output passes through. Resolves to its exit code. */
function run(command: string, args: string[], cwd: string, input?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** True once the Worker answers with a database configured (the new version is live). */
async function rolledOut(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < ROLLOUT_TRIES; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/judge/smoke`, { cache: 'no-store' });
      const body = (await response.json()) as {
        checks?: { database?: { detail?: { reason?: unknown } } };
      };
      if (body.checks?.database?.detail?.reason !== 'no DATABASE_URL') return true;
    } catch {
      // Not answering yet: the next attempt.
    }
    await new Promise((resolve) => setTimeout(resolve, ROLLOUT_WAIT_MS));
  }
  return false;
}

/**
 * The innermost cause on one line, without the URL's password: drizzle wraps the driver's error
 * ("getaddrinfo ENOTFOUND …", "password authentication failed …") in its own "Failed query".
 */
function reasonOf(error: unknown, databaseUrl: string): string {
  let inner = error;
  while (inner instanceof Error && inner.cause !== undefined) inner = inner.cause;
  const message = inner instanceof Error ? inner.message : String(inner);
  return redact(message, databaseUrl).split('\n')[0] ?? '';
}

/** The database check: reachable, and every migration of this checkout applied (or applied now). */
async function checkDatabase(databaseUrl: string): Promise<boolean> {
  const label = databaseLabel(databaseUrl);
  const { db, close } = createDb(databaseUrl);
  try {
    let applied: string[];
    try {
      applied = await appliedMigrations(db);
    } catch (error) {
      console.log(
        `refused: ${label} could not be used from this machine (${reasonOf(error, databaseUrl)})`,
      );
      return false;
    }
    const gap = migrationGap(
      applied,
      migrationJournal().map((m) => m.tag),
    );
    if (gap.unknown.length > 0) {
      console.log(
        `refused: ${label} has ${gap.unknown.length} migration(s) this checkout does not know — ` +
          'git pull the default branch and run this again',
      );
      return false;
    }
    if (gap.pending.length === 0) {
      console.log(`database ${label}: reachable, all ${applied.length} migrations applied`);
      return true;
    }
    console.log(
      applied.length === 0
        ? `database ${label} has no Yieldvest tables yet. Check that it is the database the worker writes.`
        : `database ${label} lacks ${gap.pending.length} migration(s) the site reads: ${gap.pending.join(', ')}.`,
    );
    console.log('The worker applies the same migrations on its next boot (RUNBOOK §6).');
    if (!(await askYes(`Apply ${gap.pending.length} migration(s) to ${label} now?`))) return false;
    try {
      await migrateDb(db);
    } catch (error) {
      console.log(`failed: the migrations stopped (${reasonOf(error, databaseUrl)})`);
      return false;
    }
    console.log(`applied: ${gap.pending.join(', ')}`);
    return true;
  } finally {
    await close();
  }
}

async function main(): Promise<number> {
  if (!flags.ok) {
    console.log(`${flags.error}\nusage: pnpm cf:activate [--codes <A,B,…>]`);
    return 2;
  }
  const target = workerTarget(readFileSync(path.join(WEB, 'wrangler.jsonc'), 'utf8'));
  if ('problem' in target) {
    console.log(`refused: ${target.problem}`);
    return 1;
  }
  if (!process.stdin.isTTY) {
    console.log(
      'refused: this needs an interactive terminal (the database URL is typed with the echo off)',
    );
    return 1;
  }
  const inviteCodes =
    flags.values.codes === undefined
      ? newInviteCodes(INVITES, randomBytes)
      : splitCodes(flags.values.codes);
  const codesProblem = inviteCodesProblem(inviteCodes);
  if (codesProblem) {
    console.log(`refused: ${codesProblem}`);
    return 1;
  }

  console.log(`Worker ${target.name} at ${target.url}`);
  const databaseUrl = await askHidden(
    'Production DATABASE_URL (the Neon connection string the worker uses; nothing is shown): ',
  );
  const urlProblem = databaseUrlProblem(databaseUrl);
  if (urlProblem) {
    console.log(`refused: ${urlProblem}. Nothing was changed.`);
    return 1;
  }
  if (!(await checkDatabase(databaseUrl))) {
    console.log('stopped: the Worker was not changed.');
    return 1;
  }

  console.log(
    [
      `The Worker ${target.name} gets three secrets, which replace any it has:`,
      `  DATABASE_URL    ${databaseLabel(databaseUrl)}`,
      '  SESSION_SECRET  64 new random characters (invite sessions sign in again)',
      `  JUDGE_CODES     ${inviteCodes.length} invite code(s); any other code stops working`,
    ].join('\n'),
  );
  if (!(await askYes('Write them now?'))) {
    console.log('stopped: the Worker was not changed.');
    return 1;
  }
  const payload = secretsPayload({
    databaseUrl,
    sessionSecret: newSessionSecret(randomBytes),
    inviteCodes,
  });
  const written = await run(
    'pnpm',
    ['exec', 'wrangler', 'secret', 'bulk', '--name', target.name],
    WEB,
    payload,
  );
  if (written !== 0) {
    console.log(
      `failed: wrangler exited ${written}, so the secrets may not be set (log in with npx wrangler login)`,
    );
    return 1;
  }

  // wrangler exits 0 even when it read nothing from stdin: the Worker's own answer is the proof.
  console.log('Waiting for the new version to answer…');
  if (!(await rolledOut(target.url))) {
    console.log(
      'failed: the Worker still answers without a database. Check the secret names with ' +
        '`npx wrangler secret list` in apps/web, then run this again.',
    );
    return 1;
  }
  const smoke = await run('pnpm', ['smoke', '--url', target.url], ROOT);
  console.log(
    [
      '',
      `Invite codes (put one in the submission form): ${inviteCodes.join('  ')}`,
      `Next: set the repository variable YIELDVEST_APP_URL to ${target.url} (Settings → Secrets and variables → Actions) for the 30-minute monitor,`,
      `then pnpm ui:check --url ${target.url} and pnpm qa:check --url ${target.url}.`,
    ].join('\n'),
  );
  return smoke === 0 ? 0 : 1;
}

process.exitCode = await main().catch((error: unknown) => {
  console.log(`failed: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`);
  return 1;
});
