// Headless-browser fallback for scripts/fetch-docs.sh.
//
// The docs host answers some non-browser clients with an AWS WAF JavaScript challenge
// (HTTP 202, `x-amzn-waf-action: challenge`, empty body). Chromium runs the challenge script,
// receives the token cookie, and the next navigation returns the file with HTTP 200.
//
// Usage: node scripts/fetch-docs-browser.mjs <url> <outfile>
// Env (tooling only): HTTPS_PROXY is passed to Chromium when set; CHROMIUM_PATH overrides the
// browser binary (default: the Playwright-managed Chromium).
// Behind a TLS-intercepting proxy, its CA must be in Chromium's NSS store (~/.pki/nssdb).
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/fetch-docs-browser.mjs <url> <outfile>');
  process.exit(2);
}

const proxy = process.env.HTTPS_PROXY;
const browser = await chromium.launch({
  ...(proxy ? { proxy: { server: proxy } } : {}),
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

try {
  const page = await browser.newPage();
  const started = Date.now();
  let response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  const firstStatus = response?.status();
  for (let attempt = 0; attempt < 5 && response?.status() !== 200; attempt++) {
    await page.waitForTimeout(2_000);
    response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  }
  if (!response || response.status() !== 200) {
    throw new Error(`still HTTP ${response?.status() ?? 'no response'} after challenge retries`);
  }
  const body = await response.text();
  await writeFile(out, body);
  console.log(
    `browser ${url}: first HTTP ${firstStatus}, final HTTP 200, ${body.length} chars, ${Date.now() - started} ms`,
  );
} finally {
  await browser.close();
}
