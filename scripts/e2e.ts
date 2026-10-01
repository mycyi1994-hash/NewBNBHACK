/**
 * pnpm e2e --database <postgres url> [--chromium <path>] [--port 3100] — Judge Mode end to end in
 * Chromium, in simulate mode (GOALS G6-2). The built web app (`next start`) runs on a scratch
 * database, and a worker loop runs the web's jobs over the agent tests' world: fixture-shaped
 * Binance answers and an in-memory chain, so nothing reaches a network and nothing is signed.
 * A judge enters a code, picks the test stock, dry-runs a $5 buy, presses "Buy now" (the server
 * answers that it only simulates), opens the plan and stops it.
 * The database name must contain "e2e"; it is created and migrated when missing. Build the web
 * first: pnpm --filter @yieldvest/web build. Exit: 0 pass · 1 fail · 2 usage.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processJobs } from '@yieldvest/agent';
import { createDb, getPlan, migrateDb } from '@yieldvest/db';
import postgres from 'postgres';
import { chromium, type Page } from 'playwright-core';
import { cleanup } from '../apps/agent/test/harness.js';
import { createWorld, testInstrument } from '../apps/agent/test/world.js';
import { parseFlags } from './args.js';

const usage =
  'usage: pnpm e2e --database <postgres url, name containing e2e> [--chromium <path>] [--port 3100]';
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web');
const NEXT = path.join(WEB, 'node_modules/next/dist/bin/next');
/** Mon 28 Sep 2026, 10:00 New York: the worker's world trades in the regular session. */
const WORLD_START = '2026-09-28T14:00:00.000Z';
const STEP_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates the scratch database when it is missing, through the server's `postgres` database. */
async function ensureDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const found = await sql`select 1 from pg_database where datname = ${name}`;
    if (found.length === 0) await sql.unsafe(`create database ${name}`);
  } finally {
    await sql.end();
  }
}

async function waitForWeb(base: string, exited: () => string | null): Promise<void> {
  const until = Date.now() + STEP_MS;
  while (Date.now() < until) {
    const gone = exited();
    if (gone !== null) throw new Error(`the web process exited (${gone})`);
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`${base}/api/health did not answer within ${STEP_MS / 1000} s`);
}

async function judgeFlow(
  page: Page,
  base: string,
  code: string,
  ticker: string,
  log: (step: string) => void,
) {
  await page.goto(`${base}/invest`, { waitUntil: 'networkidle' });
  await page.getByRole('textbox', { name: 'Enter your judge code' }).fill(code);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Dry-run it' }).waitFor({ timeout: STEP_MS });
  log('code accepted, the sandbox limit is shown');

  await page.getByRole('button', { name: ticker }).first().click();
  const created = page.waitForResponse(
    (r) => r.url() === `${base}/api/plans` && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Dry-run it' }).click();
  const answer = await created;
  if (answer.status() !== 201) {
    throw new Error(`POST /api/plans answered ${answer.status()}: ${await answer.text()}`);
  }
  const { plan } = (await answer.json()) as { plan: { id: string } };
  log(`plan ${plan.id} created for ${ticker}`);

  const dialog = page.getByRole('dialog');
  await dialog.getByText('the exact approval passes').waitFor({ timeout: STEP_MS });
  log('dry run on chain: the exact approval passes, the buy is checked again before signing');

  await dialog.getByRole('button', { name: 'Buy now' }).click();
  await dialog.getByText('The server is in simulation mode').waitFor({ timeout: STEP_MS });
  log('buy now: the worker ran the cycle, the server says it only simulates');

  await page.goto(`${base}/plans/${plan.id}`, { waitUntil: 'networkidle' });
  await page.getByText('Stopped · Judge trial').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Stop this plan' }).click();
  await page.getByText('Stop this plan?').waitFor();
  await page.getByRole('button', { name: 'Stop this plan' }).click();
  // The worker stops it; the page refreshes to the plan's new state (no stop button any more).
  await page.getByText('Stopped · Judge trial').waitFor({ timeout: STEP_MS });
  log('plan page: stop asked, confirmed, and the plan reads "Stopped"');
  return plan.id;
}

const flags = parseFlags(process.argv.slice(2), {
  values: ['database', 'chromium', 'port'],
  required: ['database'],
});
const database = flags.ok ? flags.values.database : '';
const port = flags.ok ? Number(flags.values.port ?? '3100') : 0;
const problem = !flags.ok
  ? flags.error
  : !URL.canParse(database) || !/^postgres(ql)?:$/.test(new URL(database).protocol)
    ? 'the database must be a postgres:// URL'
    : !/^[a-z0-9_]*e2e[a-z0-9_]*$/i.test(new URL(database).pathname.slice(1))
      ? 'the database name must contain "e2e" (the run writes plans, codes and an instrument)'
      : !Number.isInteger(port) || port < 1024 || port > 65_535
        ? 'the port must be an integer in [1024, 65535]'
        : !existsSync(path.join(WEB, '.next/BUILD_ID'))
          ? 'no web build: run pnpm --filter @yieldvest/web build first'
          : null;

if (!flags.ok || problem !== null) {
  console.log(`${problem}\n${usage}`);
  process.exitCode = 2;
} else {
  const started = Date.now();
  const log = (step: string) =>
    console.log(`e2e — ${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s  ${step}`);
  await ensureDatabase(database);
  const { db, close } = createDb(database);
  await migrateDb(db);
  const { ticker, instrumentId } = await testInstrument(db);
  const world = await createWorld(db, WORLD_START);
  const code = `e2e-${randomUUID()}`;
  const base = `http://127.0.0.1:${port}`;
  log(`database migrated; test stock ${ticker}; web on ${base}`);

  // Only what the web needs: no key, no RPC it could reach, simulate mode.
  const web = spawn(process.execPath, [NEXT, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: WEB,
    env: {
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      HOME: homedir(),
      PATH: path.dirname(process.execPath),
      DATABASE_URL: database,
      EXECUTION_MODE: 'simulate',
      JUDGE_CODES: code,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      NEXT_PUBLIC_APP_URL: base,
      BSC_RPC_URL: 'http://127.0.0.1:9',
      BSC_RPC_URL_FALLBACK: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const webLog: string[] = [];
  web.stdout.on('data', (chunk: Buffer) => webLog.push(chunk.toString()));
  web.stderr.on('data', (chunk: Buffer) => webLog.push(chunk.toString()));
  let exit: string | null = null;
  web.on('exit', (code, signal) => {
    exit = `code ${code ?? '-'}, signal ${signal ?? '-'}`;
  });

  // The worker: the web's jobs, one at a time, as main.ts polls them between ticks.
  let working = true;
  const jobErrors: string[] = [];
  const worker = (async () => {
    while (working) {
      const done = await processJobs(world.deps('simulate'), world.deps('simulate'));
      jobErrors.push(...done.errors);
      await sleep(300);
    }
  })();

  const browser = await chromium.launch(
    flags.values.chromium ? { executablePath: flags.values.chromium } : {},
  );
  const problems: string[] = [];
  let planId: string | undefined;
  try {
    await waitForWeb(base, () => exit);
    log('web answers /api/health');
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => problems.push(`page error at ${page.url()}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error')
        problems.push(`console error at ${page.url()}: ${message.text()}`);
    });
    planId = await judgeFlow(page, base, code, ticker, log);
    // What the page said, from the database: the plan is stopped, and nothing was bought.
    const row = await getPlan(db, planId);
    if (row?.status !== 'stopped')
      problems.push(`plan ${planId} is ${row?.status ?? 'missing'}, not stopped`);
    problems.push(...jobErrors.map((e) => `worker: ${e}`));
  } catch (error) {
    problems.push(
      error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error),
    );
  } finally {
    working = false;
    await worker.catch((error: unknown) => problems.push(`worker: ${String(error)}`));
    await browser.close();
    web.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => web.once('exit', resolve)), sleep(5_000)]);
    if (exit === null) web.kill('SIGKILL');
    await cleanup(db, planId === undefined ? [] : [planId], [instrumentId]);
    await close();
  }
  for (const p of problems) console.log(`e2e — FAIL: ${p}`);
  if (problems.length > 0) {
    console.log(
      `e2e — web log (last lines):\n${webLog.join('').split('\n').slice(-20).join('\n')}`,
    );
    process.exitCode = 1;
  } else {
    log('PASS: Judge Mode end to end in simulate mode, 0 page or console errors');
  }
}
