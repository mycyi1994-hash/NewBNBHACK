/// <reference lib="dom" />
/**
 * pnpm e2e --database <postgres url> [--chromium <path>] [--port 3100] — Judge Mode end to end in
 * Chromium, in simulate mode (GOALS G6-2). The built web app (`next start`) runs on a scratch
 * database, and a worker loop runs the web's jobs over the agent tests' world: fixture-shaped
 * Binance answers and an in-memory chain, so nothing reaches a network and nothing is signed.
 * A judge enters a code, picks the test stock, dry-runs a $5 buy, presses "Buy now" (the server
 * answers that it only simulates), opens the plan and stops it. Then "Buy with interest": the risk
 * disclosure must be agreed to before it turns on, the $5 deposit's dry run shows what its
 * simulation found, and a deposit whose simulation fails is shown failing. All of it at a
 * phone's 375 px and at 1280 px, with no sideways scroll at any step (dialogs open included).
 * The database name must contain "e2e"; it is created and migrated when missing. Build the web
 * first: pnpm --filter @yieldvest/web build. --shots <dir> keeps a screenshot of every step (and
 * of the one that failed). Then the read-only views of DECISIONS D-31 on the same stock: the
 * pre-flight check, the issuer comparison, the Earn calculator and the MCP block on /skill.
 * Exit: 0 pass · 1 fail · 2 usage.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processJobs } from '@yieldvest/agent';
import {
  createDb,
  getPlan,
  insertTapeSamples,
  migrateDb,
  readWorkerStatus,
  writeWorkerStatus,
  type Db,
} from '@yieldvest/db';
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
/** Turns "Buy with interest" on through its risk disclosure (agreeing at once). */
async function turnOnYield(page: Page) {
  await page.getByRole('button', { name: 'Buy with interest' }).click();
  await page.getByRole('checkbox', { name: 'I understand' }).check();
  await page.getByRole('button', { name: 'Agree and turn on' }).click();
}

/** Creates a yield plan from the panel and dry-runs its deposit; waits for `outcome` on screen. */
async function depositDryRun(run: Run, outcome: string, where: string): Promise<string> {
  const { page, check } = run;
  const planId = await planCreatedBy(run, () =>
    page.getByRole('button', { name: 'Continue' }).click(),
  );
  const deposit = page.getByRole('dialog').getByRole('button', {
    name: 'Put it in the interest account',
  });
  await deposit.waitFor({ timeout: STEP_MS });
  await check(`${where} dialog`);
  await deposit.click();
  await page.getByRole('dialog').getByText(outcome).waitFor({ timeout: STEP_MS });
  await check(`${where} done`);
  return planId;
}

/**
 * "Buy with interest" turns on only after the risk disclosure is agreed to; the deposit's dry run
 * says what its simulation found — the exact approval passing, the deposit checked again after it
 * — and a deposit whose simulation fails says so.
 */
async function yieldFlow(run: Run, venus: ReturnType<typeof withVenus>) {
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

  const planId = await depositDryRun(
    run,
    'The deposit is dry-run again right after it, before anything is signed',
    'deposit',
  );
  log(
    `deposit of plan ${planId}: the exact approval passes on-chain, the deposit is checked after it`,
  );

  // A deposit whose simulation fails (a paused market): the judge is told, nothing is said to pass.
  venus.mintFailure = 'execution reverted: mint is paused';
  try {
    await page.goto(`${base}/invest`, { waitUntil: 'networkidle' });
    await turnOnYield(page);
    const failed = await depositDryRun(
      run,
      'The dry-run failed: execution reverted: mint is paused',
      'failed deposit',
    );
    log(`deposit of plan ${failed}: its failing dry run is shown as a failure`);
    return [planId, failed];
  } finally {
    venus.mintFailure = undefined;
  }
}

/** About $225.10 a token: what a $1 quote receives, in base units. */
const TOKENS_PER_USD = 4_442_430_800_471_653n;

/**
 * What the read-only views of DECISIONS D-31 read, written as the worker writes it — a tape run of
 * the test stock now and a listed Venus rate — and removed afterwards, so the Judge Mode flows of
 * the next width see the state they always saw.
 */
async function withFeatureData<T>(
  db: Db,
  database: string,
  instrumentId: string,
  run: () => Promise<T>,
): Promise<T> {
  const now = new Date().toISOString();
  const before = await readWorkerStatus(db, 'venus');
  await insertTapeSamples(
    db,
    [5, 50, 500].map((sizeUsd) => ({
      sampledAt: now,
      slotAt: now,
      instrumentId,
      session: 'regular',
      openState: true,
      marketStatus: null,
      reasonCode: 'TRADING',
      reasonMsg: null,
      nextOpenTime: null,
      tokenPrice: '225.175',
      referencePrice: '225.1',
      stockPrice: '225',
      priceUpdatedAt: now,
      sizeUsd,
      expectedOut: (TOKENS_PER_USD * BigInt(sizeUsd)).toString(),
      priceImpactPct: '0.05',
      vendor: 'e2e',
      executionMode: 'SWAP',
      route: null,
      errorCode: null,
      errorMsg: null,
      latencyMs: 100,
    })),
  );
  await writeWorkerStatus(db, 'venus', {
    ...(before?.value ?? {}),
    apyDisplay: '3.16%',
    verifiedAt: now,
  });
  const sql = postgres(database, { max: 1, onnotice: () => {} });
  try {
    return await run();
  } finally {
    await sql`delete from tape_samples where instrument_id = ${instrumentId}`;
    if (before) await writeWorkerStatus(db, 'venus', before.value);
    else await sql`delete from worker_status where key = 'venus'`;
    await sql.end();
  }
}

/**
 * The read-only views (DECISIONS D-31): /check runs the agent's engine on a plan that does not
 * exist and lists the rules it read; /compare shows the token's quotes side by side; the Earn
 * calculator answers as the amount changes and refuses what is not an amount; /skill names the
 * MCP endpoint. The verdict depends on the clock (the US session), so any of the engine's answers
 * passes, as long as it is one of them and its rules are listed.
 */
async function featureFlow(run: Run, ticker: string) {
  const { page, base, log, check } = run;
  await page.goto(`${base}/check?ticker=${ticker}&usd=5`, { waitUntil: 'networkidle' });
  const verdict = page.locator('.check-verdict').first();
  await verdict.waitFor({ timeout: STEP_MS });
  const head = (await verdict.locator('.block-title .pill').innerText()).trim();
  if (!/^Would (buy about|wait|skip|stop)/.test(head)) {
    throw new Error(`/check answers "${head}", not one of the engine's verdicts`);
  }
  const rules = await verdict.locator('tbody tr').count();
  if (rules !== 4) throw new Error(`/check lists ${rules} rules for the token, not 4`);
  await check('pre-flight check');
  log(`pre-flight: "${head}", with the token's four rules and the shared three`);

  await page.goto(`${base}/compare?ticker=${ticker}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'bStocks or Ondo?' }).first().waitFor();
  const sizes = await page.locator('.compare-side tbody tr').count();
  if (sizes !== 3) throw new Error(`/compare shows ${sizes} quote sizes, not 3`);
  await check('issuer comparison');
  log("compare: the token's $5, $50 and $500 quotes with shares and price per share");

  await page.goto(`${base}/earn`, { waitUntil: 'networkidle' });
  const deposit = page.getByRole('textbox', { name: 'If I put in (USDT)' });
  await deposit.fill('1000');
  await page.getByText('31.60 USDT', { exact: true }).waitFor({ timeout: STEP_MS });
  await check('interest calculator');
  await deposit.fill('abc');
  await page.getByText('Enter an amount above 0, with up to two decimals.').waitFor();
  log('earn: $1,000 at the listed 3.16 % projects 31.60 USDT a year; "abc" is refused');

  await page.goto(`${base}/skill`, { waitUntil: 'networkidle' });
  await page.getByText(`claude mcp add --transport http yieldvest ${base}/api/mcp`).waitFor();
  await check('mcp block');
  log('skill: the read-only MCP endpoint and its tools are named');
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
  const venus = withVenus(world);
  // A code per browser run: each is a judge of its own, within the per-code plan limit.
  const codes = [`e2e-${randomUUID()}`, `e2e-${randomUUID()}`];
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
      JUDGE_CODES: codes.join(','),
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
    for (const [index, width] of [375, 1280].entries()) {
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
          // An amount and its unit stay on one line (a long ledger label once split "5.00 USD" / "T").
          const split = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>('.ledger dd'))
              .filter((dd) => /^\$?[\d,.]+ USDT$/.test(dd.textContent?.trim() ?? ''))
              .filter((dd) => {
                const range = document.createRange();
                range.selectNodeContents(dd);
                const tops = Array.from(range.getClientRects(), (r) => Math.round(r.top));
                return new Set(tops).size > 1;
              })
              .map((dd) => dd.textContent?.trim() ?? ''),
          );
          if (split.length > 0)
            problems.push(`${at} ${where}: amount split over lines: ${split.join(', ')}`);
          // --shots: what the judge saw at each step, for the demo and the UX review.
          if (flags.values.shots) {
            shot += 1;
            const name = `${width}-${String(shot).padStart(2, '0')}-${where.replace(/\W+/g, '-')}.png`;
            mkdirSync(flags.values.shots, { recursive: true });
            await page.screenshot({ path: path.join(flags.values.shots, name) });
          }
        },
      };
      const safe = await judgeFlow(run, codes[index] ?? '', ticker);
      const deposits = await yieldFlow(run, venus);
      await withFeatureData(db, database, instrumentId, () => featureFlow(run, ticker));
      // What the pages said, from the database: the first plan is stopped; the yield plans still
      // wait for their first run, with no principal (a dry run deposits nothing).
      const stopped = await getPlan(db, safe);
      if (stopped?.status !== 'stopped')
        problems.push(`${at} plan ${safe} is ${stopped?.status ?? 'missing'}, not stopped`);
      for (const id of deposits) {
        const waiting = await getPlan(db, id);
        if (waiting?.pausedReason !== 'awaiting_run' || Number(waiting.principalUsd) !== 0)
          problems.push(`${at} plan ${id} is ${waiting?.pausedReason ?? 'missing'}`);
      }
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
    log('      and the pre-flight check, issuer comparison, calculator and MCP block');
    log('      0 page or console errors, 0 sideways scrolls');
  }
}
