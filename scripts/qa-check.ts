/// <reference lib="dom" />
/**
 * pnpm qa:check [--url http://localhost:3000] [--pages /,/earn,…] [--chromium path] — the M3-02
 * pass over every page in Chromium, next to ui:check's layout and language checks:
 * - accessibility: axe-core (WCAG 2.1 A and AA, and best practices) at 375 px and 1440 px. A
 *   serious or critical violation fails; moderate and minor ones are listed.
 * - keyboard: the first Tab reaches the skip link, and Enter moves focus to <main>.
 * - motion: a looping animation stops with the motion toggle (WCAG 2.2.2), and with the system's
 *   reduced-motion setting nothing keeps moving.
 * - performance: Lighthouse's phone preset (375 px, 4× slower CPU, 150 ms and 1.6 Mbps network) on
 *   a cold cache — LCP, CLS, total blocking time and the JavaScript transferred. A "poor" Core Web
 *   Vital (LCP > 4 s, CLS > 0.25) or a TBT over 600 ms fails.
 * It measures the server it is pointed at: a local `next start` gives a baseline, not the CDN.
 * --only a11y,keyboard,motion,perf runs a subset.
 */
import { parseArgs } from 'node:util';
import axe from 'axe-core';
import { chromium, type Browser, type Page } from 'playwright-core';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    chromium: { type: 'string' },
    only: { type: 'string', default: 'a11y,keyboard,motion,perf' },
    pages: {
      type: 'string',
      default: '/,/earn,/invest,/activity,/skill,/risk,/dx,/plans/H-SAFE,/plans/H-YIELD',
    },
  },
});
const base = values.url.replace(/\/+$/, '');
const pages = values.pages.split(',');
const problems: string[] = [];
const notes: string[] = [];

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  targets: string[];
}

async function audit(page: Page): Promise<Violation[]> {
  await page.evaluate(axe.source);
  return page.evaluate(async () => {
    const { axe: run } = window as unknown as { axe: typeof import('axe-core') };
    const result = await run.run(document, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
    });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
  });
}

async function accessibility(browser: Browser) {
  for (const width of [375, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    for (const route of pages) {
      await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
      const violations = await audit(page);
      const where = `a11y ${String(width).padStart(4)}px ${route}`;
      console.log(`${where.padEnd(32)} ${violations.length} violations`);
      for (const v of violations) {
        const line = `${where}: ${v.impact ?? 'unknown'} ${v.id} — ${v.help} (${v.targets.join(', ')})`;
        if (v.impact === 'serious' || v.impact === 'critical') problems.push(line);
        else notes.push(line);
      }
    }
    await context.close();
  }
}

async function keyboard(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  for (const route of pages) {
    await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement?.className ?? '');
    await page.keyboard.press('Enter');
    const landed = await page.evaluate(() => document.activeElement?.id ?? '');
    const line = `keyboard ${route}: first Tab → .${first || '(nothing)'}, Enter → #${landed || '(nothing)'}`;
    console.log(line);
    if (!first.split(' ').includes('skip-link') || landed !== 'main') problems.push(line);
  }
  await context.close();
}

/** Animations still running after the page settles: looping ones are the WCAG 2.2.2 concern. */
const running = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => ({
        name: a instanceof CSSAnimation ? a.animationName : a.id || a.constructor.name,
        looping: a.effect?.getComputedTiming().iterations === Infinity,
      })),
  );

async function motion(browser: Browser) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion,
    });
    const page = await context.newPage();
    for (const route of pages) {
      await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const moving = await running(page);
      const loops = moving.filter((a) => a.looping);
      if (reducedMotion === 'reduce') {
        const line = `motion reduced ${route}: ${moving.length} running`;
        console.log(line);
        if (moving.length > 0) problems.push(`${line} (${moving.map((a) => a.name).join(', ')})`);
        continue;
      }
      if (loops.length === 0) {
        console.log(`motion ${route}: no looping animation`);
        continue;
      }
      await page.locator('.motion-toggle').first().click();
      await page.waitForTimeout(300);
      const left = (await running(page)).filter((a) => a.looping);
      const line = `motion ${route}: ${loops.length} looping → ${left.length} after the pause toggle`;
      console.log(line);
      if (left.length > 0) problems.push(`${line} (${left.map((a) => a.name).join(', ')})`);
    }
    await context.close();
  }
}

interface Vitals {
  lcp: number;
  cls: number;
  tbt: number;
  scriptBytes: number;
  documentBytes: number;
}

async function pageSpeed(browser: Browser) {
  for (const route of pages) {
    // A cold cache per page: what a judge's first visit to that page costs.
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    // No named helpers in here: tsx wraps them in `__name(…)`, which the page does not have.
    await context.addInitScript(() => {
      const qa = { lcp: 0, cls: 0, tasks: [] as { start: number; duration: number }[] };
      (window as unknown as { __qa: typeof qa }).__qa = qa;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) qa.lcp = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) qa.cls += shift.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          qa.tasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const vitals: Vitals = await page.evaluate(() => {
      const qa = (
        window as unknown as {
          __qa: { lcp: number; cls: number; tasks: { start: number; duration: number }[] };
        }
      ).__qa;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const navigation = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined;
      return {
        lcp: qa.lcp,
        cls: qa.cls,
        tbt: qa.tasks
          .filter((task) => task.start >= fcp)
          .reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
        scriptBytes: resources
          .filter((r) => r.initiatorType === 'script')
          .reduce((sum, r) => sum + r.transferSize, 0),
        documentBytes: navigation?.transferSize ?? 0,
      };
    });
    const line =
      `perf 375px ${route.padEnd(16)} LCP ${(vitals.lcp / 1000).toFixed(2)} s · ` +
      `CLS ${vitals.cls.toFixed(3)} · TBT ${Math.round(vitals.tbt)} ms · ` +
      `JS ${(vitals.scriptBytes / 1024).toFixed(0)} KB · HTML ${(vitals.documentBytes / 1024).toFixed(0)} KB`;
    console.log(line);
    if (vitals.lcp === 0 || vitals.lcp > 4000 || vitals.cls > 0.25 || vitals.tbt > 600) {
      problems.push(line);
    }
    await context.close();
  }
}

const browser = await chromium.launch(values.chromium ? { executablePath: values.chromium } : {});
try {
  const only = new Set(values.only.split(','));
  if (only.has('a11y')) await accessibility(browser);
  if (only.has('keyboard')) await keyboard(browser);
  if (only.has('motion')) await motion(browser);
  if (only.has('perf')) await pageSpeed(browser);
} finally {
  await browser.close();
}
for (const note of notes) console.log(`qa:check note — ${note}`);
for (const problem of problems) console.log(`qa:check — ${problem}`);
console.log(`qa:check — ${problems.length} problems, ${notes.length} notes`);
if (problems.length > 0) process.exitCode = 1;
