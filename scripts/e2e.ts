/// <reference lib="dom" />
/**
 * pnpm e2e --database <postgres url> [--chromium <path>] [--port 3100] — Judge Mode end to end in
 * Chromium, in simulate mode (GOALS G6-2). The built web app (`next start`) runs on a scratch
 * database, and a worker loop runs the web's jobs over the agent tests' world: fixture-shaped
 * Binance answers and an in-memory chain, so nothing reaches a network and nothing is signed.
 * A judge enters a code, picks the test stock, dry-runs a $5 buy, presses "Buy now" (the server
 * answers that it only simulates), opens the plan and stops it. Then "Buy with interest": the risk
 * disclosure must be agreed to before it turns on, and the $5 deposit is dry-run. All of it at a
 * phone's 375 px and at 1280 px, with no sideways scroll at any step (dialogs open included).
 * The database name must contain "e2e"; it is created and migrated when missing. Build the web
 * first: pnpm --filter @yieldvest/web build. --shots <dir> keeps a screenshot of every step (and
 * of the one that failed). Exit: 0 pass · 1 fail · 2 usage.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processJobs } from '@yieldvest/agent';
import { createDb, getPlan, migrateDb } from '@yieldvest/db';
import postgres from 'postgres';
import { chromium, type Browser, type Page } from 'playwright-core';
import { cleanup } from '../apps/agent/test/harness.js';
import { createWorld, testInstrument, withVenus } from '../apps/agent/test/world.js';
import { parseFlags } from './args.js';

const usage =
  'usage: pnpm e2e --database <postgres url, name containing e2e> [--chromium <path>] [--port 3100] [--shots <dir>]';
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web');
const NEXT = path.join(WEB, 'node_modules/next/dist/bin/next');
/** Mon 28 Sep 2026, 10:00 New York: the worker's world trades in the regular session. */
const WORLD_START = '2026-09-28T14:00:00.000Z';
const STEP_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One browser run: its page, the plans it created, its log and its layout check. */
interface Run {
  page: Page;
  base: string;
  planIds: string[];
  log: (step: string) => void;
  /** Records a sideways scroll at this step (TASKS M2-01: 375 px, no horizontal scroll). */
  check: (where: string) => Promise<void>;
}

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

/** The POST /api/plans the next click sends: the plan it created, kept for the cleanup. */
async function planCreatedBy(run: Run, click: () => Promise<void>): Promise<string> {
  const created = run.page.waitForResponse(
    (r) => r.url() === `${run.base}/api/plans` && r.request().method() === 'POST',
  );
  await click();
  const answer = await created;
  if (answer.status() !== 201) {
    throw new Error(`POST /api/plans answered ${answer.status()}: ${await answer.text()}`);
  }
  const { plan } = (await answer.json()) as { plan: { id: string } };
  run.planIds.push(plan.id);
  return plan.id;
}

async function judgeFlow(run: Run, code: string, ticker: string) {
  const { page, base, log, check } = run;
  await page.goto(`${base}/invest`, { waitUntil: 'networkidle' });
  await check('invest, no code yet');
  await page.getByRole('textbox', { name: 'Enter your judge code' }).fill(code);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Dry-run it' }).waitFor({ timeout: STEP_MS });
  log('code accepted, the sandbox limit is shown');

  await page.getByRole('button', { name: ticker }).first().click();
  const planId = await planCreatedBy(run, () =>
    page.getByRole('button', { name: 'Dry-run it' }).click(),
  );
  log(`plan ${planId} created for ${ticker}`);

  const dialog = page.getByRole('dialog');
  await dialog.getByText('the exact approval passes').waitFor({ timeout: STEP_MS });
  await check('dry-run dialog');
  log('dry run on chain: the exact approval passes, the buy is checked again before signing');

  await dialog.getByRole('button', { name: 'Buy now' }).click();
  await dialog.getByText('The server is in simulation mode').waitFor({ timeout: STEP_MS });
  await check('done dialog');
  // A dry run starts nothing: the dialog must not promise seven days of buying.
  if ((await dialog.getByText('keeps running for 7 days').count()) > 0) {
    throw new Error('the done dialog says the plan keeps running after a dry run');
  }
  log('buy now: the worker ran the cycle, the server says it only simulates');

  await page.goto(`${base}/plans/${planId}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Stop this plan' }).click();
  await page.getByText('Stop this plan?').waitFor();
  await check('plan page, stop asked');
  await page.getByRole('button', { name: 'Stop this plan' }).click();
  // The worker stops it; the page refreshes to the plan's new state (no stop button any more),
  // which a phone shows too (the summary's status line is hidden under 1100 px).
  await page.getByText('Stopped by its owner').first().waitFor({ timeout: STEP_MS });
  await check('plan page, stopped');
  log('plan page: stop asked, confirmed, and the plan reads "Stopped by its owner"');
  return planId;
}

/** "Buy with interest" turns on only after the risk disclosure is agreed to; the deposit is dry-run. */
async function yieldFlow(run: Run) {
  const { page, base, log, check } = run;
  await page.goto(`${base}/invest`, { waitUntil: 'networkidle' });
  const yieldMode = page.getByRole('button', { name: 'Buy with interest' });
  const agree = page.getByRole('button', { name: 'Agree and turn on' });
  await yieldMode.click();
  await check('risk disclosure');
  if (!(await agree.isDisabled())) {
    throw new Error('yield mode could be turned on before "I understand" was checked');
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).first().click();
  if ((await yieldMode.getAttribute('aria-pressed')) !== 'false') {
    throw new Error('closing the risk disclosure turned yield mode on');
  }
  await yieldMode.click();
  await page.getByRole('checkbox', { name: 'I understand' }).check();
  await agree.click();
  if ((await yieldMode.getAttribute('aria-pressed')) !== 'true') {
    throw new Error('yield mode stayed off after "Agree and turn on"');
  }
  log('yield mode: stays off until "I understand" is checked, on after "Agree and turn on"');
  await check('yield plan panel');

  const planId = await planCreatedBy(run, () =>
    page.getByRole('button', { name: 'Continue' }).click(),
  );
  const deposit = page.getByRole('dialog').getByRole('button', {
    name: 'Put it in the interest account',
  });
  await deposit.waitFor({ timeout: STEP_MS });
  await check('deposit dialog');
  await deposit.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('The server is in simulation mode').waitFor({ timeout: STEP_MS });
  await check('deposit done');
  log(`deposit of plan ${planId}: exact approval and Venus deposit dry-run, nothing signed`);
  return planId;
}

const flags = parseFlags(process.argv.slice(2), {
  values: ['database', 'chromium', 'port', 'shots'],
  required: ['database'],
});
const database = flags.ok ? flags.values.database : '';
const port = flags.ok ? Number(flags.values.port ?? '3100') : 0;
const problem = !flags.ok
  ? flags.error
  : !URL.canParse(database) || !/^postgres(ql)?:$/.test(new URL(database).protocol)
    ? 'the database must be a postgres:// URL'
    : !/^[a-z0-9_]*e2e[a-z0-9_]*$/.test(new URL(database).pathname.slice(1))
      ? 'the database name must be lower case and contain "e2e" (the run writes plans, codes and an instrument)'
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
  withVenus(world);
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

  let browser: Browser | undefined;
  const problems: string[] = [];
  const planIds: string[] = [];
  let current: Page | undefined;
  try {
    // Inside the try: a browser that will not start still stops the web process (finally).
    browser = await chromium.launch(
      flags.values.chromium ? { executablePath: flags.values.chromium } : {},
    );
    await waitForWeb(base, () => exit);
    log('web answers /api/health');
    // A phone first, then a desktop: each a judge of its own (a fresh session cookie).
    for (const width of [375, 1280]) {
      let shot = 0;
      // Reduced motion: every step is checked and pictured at rest, not halfway through a fade.
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      current = page;
      const at = `${width}px`;
      page.on('pageerror', (error) =>
        problems.push(`${at} page error at ${page.url()}: ${error.message}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error')
          problems.push(`${at} console error at ${page.url()}: ${message.text()}`);
      });
      const run: Run = {
        page,
        base,
        planIds,
        log: (step) => log(`${at.padStart(6)}  ${step}`),
        check: async (where) => {
          const { scroll, client } = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
          }));
          if (scroll > client) problems.push(`${at} ${where}: scrollWidth ${scroll} > ${client}`);
          // --shots: what the judge saw at each step, for the demo and the UX review.
          if (flags.values.shots) {
            shot += 1;
            const name = `${width}-${String(shot).padStart(2, '0')}-${where.replace(/\W+/g, '-')}.png`;
            mkdirSync(flags.values.shots, { recursive: true });
            await page.screenshot({ path: path.join(flags.values.shots, name) });
          }
        },
      };
      const safe = await judgeFlow(run, code, ticker);
      const interest = await yieldFlow(run);
      // What the pages said, from the database: the first plan is stopped; the second still
      // waits for its first run, with no principal (a dry run deposits nothing).
      const [stopped, waiting] = [await getPlan(db, safe), await getPlan(db, interest)];
      if (stopped?.status !== 'stopped')
        problems.push(`${at} plan ${safe} is ${stopped?.status ?? 'missing'}, not stopped`);
      if (waiting?.pausedReason !== 'awaiting_run' || Number(waiting.principalUsd) !== 0)
        problems.push(`${at} plan ${interest} is ${waiting?.pausedReason ?? 'missing'}`);
      await context.close();
    }
    problems.push(...jobErrors.map((e) => `worker: ${e}`));
  } catch (error) {
    problems.push(
      error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error),
    );
    // Where it stopped, for whoever reads the failure (--shots).
    if (current && flags.values.shots) {
      mkdirSync(flags.values.shots, { recursive: true });
      const failure = path.join(flags.values.shots, 'e2e-failure.png');
      await current.screenshot({ path: failure, fullPage: true }).catch(() => undefined);
      problems.push(`stopped at ${current.url()}; screenshot ${failure}`);
    }
  } finally {
    working = false;
    await worker.catch((error: unknown) => problems.push(`worker: ${String(error)}`));
    await browser?.close();
    web.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => web.once('exit', resolve)), sleep(5_000)]);
    if (exit === null) web.kill('SIGKILL');
    await cleanup(db, planIds, [instrumentId]);
    await close();
  }
  for (const p of problems) console.log(`e2e — FAIL: ${p}`);
  if (problems.length > 0) {
    console.log(
      `e2e — web log (last lines):\n${webLog.join('').split('\n').slice(-20).join('\n')}`,
    );
    process.exitCode = 1;
  } else {
    log('PASS: Judge Mode end to end in simulate mode, at 375 and 1280 px');
    log('      0 page or console errors, 0 sideways scrolls');
  }
}
