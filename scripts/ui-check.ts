/// <reference lib="dom" />
/**
 * pnpm ui:check [--url http://localhost:3000] [--out dir] — opens every page in Chromium at 375 px
 * (phone) and 1440 px (desktop) in Korean and English, and fails on a horizontal scroll (TASKS
 * M2-01: 375 px, no sideways scroll), a page error or a non-2xx page. Screenshots go to --out.
 * Chromium comes from PLAYWRIGHT_BROWSERS_PATH or --chromium.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    out: { type: 'string' },
    chromium: { type: 'string' },
    pages: { type: 'string', default: '/,/judge,/skill,/risk,/dx,/plans/H-SAFE,/plans/H-YIELD' },
  },
});
const base = values.url.replace(/\/+$/, '');
const pages = values.pages.split(',');
if (values.out) mkdirSync(values.out, { recursive: true });

const browser = await chromium.launch(values.chromium ? { executablePath: values.chromium } : {});
const problems: string[] = [];
try {
  for (const lang of ['ko', 'en'] as const) {
    for (const width of [375, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        locale: lang === 'ko' ? 'ko-KR' : 'en-US',
        timezoneId: lang === 'ko' ? 'Asia/Seoul' : 'America/New_York',
      });
      await context.addCookies([{ name: 'yieldvest_lang', value: lang, url: base }]);
      const page = await context.newPage();
      page.on('pageerror', (error) =>
        problems.push(`${lang} ${width}px ${page.url()}: ${error.message}`),
      );
      // Console errors include Content-Security-Policy violations (M3-05).
      page.on('console', (message) => {
        if (message.type() === 'error') {
          problems.push(`${lang} ${width}px ${page.url()}: ${message.text()}`);
        }
      });
      for (const route of pages) {
        const response = await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
        const status = response?.status() ?? 0;
        const { scroll, client } = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        const line = `${lang} ${String(width).padStart(4)}px ${route.padEnd(16)} HTTP ${status} scrollWidth ${scroll} / ${client}`;
        console.log(line);
        if (status < 200 || status >= 300) problems.push(`${line}: not 2xx`);
        if (scroll > client) problems.push(`${line}: horizontal scroll`);
        if (values.out) {
          const name = `${lang}-${width}${route === '/' ? '-home' : route.replaceAll('/', '-')}.png`;
          await page.screenshot({ path: path.join(values.out, name), fullPage: true });
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
for (const problem of problems) console.log(`ui:check — ${problem}`);
console.log(`ui:check — ${problems.length} problems`);
if (problems.length > 0) process.exitCode = 1;
