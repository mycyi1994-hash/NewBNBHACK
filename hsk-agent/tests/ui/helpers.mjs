// Shared pieces for the UI smoke tests: one browser, a fresh page per check that records page errors, and the
// navigation the app offers at each width (sidebar on a desktop, tab bar on a phone).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const BASE = process.env.MOA_UI_BASE ?? 'http://127.0.0.1:4202';
export const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
/** A vault on HSK Chain mainnet made by Moa's factory (see contracts/MAINNET.md). */
export const MAINNET_VAULT = '0x6A355aE335f06971C337c900783C2e016410b33C';

let browser;
export async function launch() { browser ??= await chromium.launch(); return browser; }
export async function close() { await browser?.close(); browser = undefined; }

/** A page in English with a known Moa level, opened at `query`. `errors` collects uncaught page errors. */
export async function open(size, query = '', storage = {}) {
  const ctx = await (await launch()).newContext({ viewport: SIZES[size] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/');
  await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('moa.lang', 'en'); localStorage.setItem('moa.level', 'some'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  await page.goto(BASE + '/' + query);
  return { page, errors, done: () => ctx.close() };
}

const NAV = { trade: 'Trade', agents: 'Agent market', build: 'Make an agent', mine: 'My agents' };
/** Go to a screen the way a person would: the sidebar on a desktop, the tab bar on a phone (no build tab there). */
export async function go(page, screen) {
  const label = NAV[screen];
  const link = page.locator('.nav-item:visible, .tab:visible').filter({ hasText: label }).first();
  if (await link.count()) { await link.click(); return; }
  if (screen === 'build') {
    await go(page, 'mine');
    await page.locator('.slot.add .btn-text').first().click();
    return;
  }
  throw new Error(`no way to ${screen} at this width`);
}

/** The page is no wider than the window. */
export const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
