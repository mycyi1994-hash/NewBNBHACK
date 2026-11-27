// The auto runner's state on My agents and the vault view; orders and vault changes asked in the chat with the AI
// off (this test server has no model key). Mocked responses here are test data only.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, go, MAINNET_VAULT, open } from './helpers.mjs';

after(close);
const NOW = Date.now(), MIN = 60_000;
const agent = (id, rule, base, kind) => ({ id, createdAt: NOW - 86_400_000, source: { type: 'market', agentId: `${rule}-${base}USDT`, kind, rule, base }, asset: base, perBuyUsd: 1, budgetUsd: 3, mode: 'auto', paused: false, fired: [], fills: [], log: [] });
const VAULT_JSON = { configured: true, service: true, signedIn: true, vault: MAINNET_VAULT, usdtBalance: '9', holdings: [], maxSlippageBps: 150, stopLossBps: 0, paused: false, net: { chainId: 177, explorer: 'https://hsk.blockscout.com', usdt: '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029', tokens: [] } };

async function ask(page, text) {
  await page.waitForSelector('.moa-col textarea', { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.fill('.moa-col textarea', text);
  await page.keyboard.press('Enter');
}

describe('auto runner status', () => {
  test('this demo server says plainly that the runner is off (vault view)', async () => {
    const { page, errors, done } = await open('desktop', `?vault=${MAINNET_VAULT}`);
    await page.waitForSelector('.rnr', { timeout: 60_000 });
    assert.match(await page.locator('.rnr').innerText(), /Off on this server/);
    assert.deepEqual(errors, []);
    await done();
  });

  test('My agents shows the last and next check and each agent’s last decision, errors in words', async () => {
    const { page, errors, done } = await open('desktop', '', { 'moa.hired.v1': JSON.stringify([agent('a', 'rsi2', 'BTC', 'position'), agent('b', 'psar', 'HSK', 'position')]) });
    await page.route('**/api/auto/status*', (r) => r.fulfill({ json: { now: Date.now(), runner: { on: true, every: 300_000, startedAt: NOW - 3_600_000, passes: 3, lastPassAt: NOW - 2 * MIN, nextAt: NOW + 3 * MIN, error: null }, owner: { lastLookAt: NOW - 2 * MIN, error: null },
      agents: [{ id: 'a', paused: false, check: { at: NOW - 2 * MIN, k: 'idle', signal: { kind: 'position', live: false } } }, { id: 'b', paused: false, check: { at: NOW - 2 * MIN, k: 'order', signal: { kind: 'position', live: true }, side: 'buy', amount: 1, ok: false, error: 'DailyCapExceeded(2000000, 1000000)' } }] } }));
    await go(page, 'mine');
    await page.waitForSelector('.rnr-agents', { timeout: 30_000 });
    const text = await page.locator('.rnr').innerText();
    assert.match(text, /Running/);
    assert.match(text, /last check 2 min ago/);
    assert.match(text, /next in 3 min/);
    assert.match(text, /Signal off · nothing to do/);
    assert.match(text, /over the vault’s daily limit/, 'the revert is said in words');
    assert.deepEqual(errors, []);
    await done();
  });
});

describe('chat without the AI', () => {
  test('a buy request becomes an order card; without a login it is a demo and says what it needs', async () => {
    const { page, errors, done } = await open('desktop');
    await ask(page, 'buy $1 of BTC');
    await page.waitForSelector('.proposal.demo', { timeout: 30_000 });
    assert.match(await page.locator('.proposal.demo').innerText(), /Buy \$1 of BTC/);
    assert.match(await page.locator('.note').last().innerText(), /log/i);
    assert.equal(await page.locator('.proposal.demo button').count(), 0, 'a demo card has no button');
    assert.deepEqual(errors, []);
    await done();
  });

  test('"set the daily limit to $30" and "lock the vault" become cards for the owner’s wallet to sign', async () => {
    const { page, errors, done } = await open('desktop');
    await page.route('**/api/vault', (r) => r.fulfill({ json: VAULT_JSON }));
    await page.reload();
    await ask(page, 'set the daily limit to $30');
    await page.waitForSelector('.vcx', { timeout: 30_000 });
    const card = await page.locator('.vcx').last().innerText();
    assert.match(card, /no limit\s*→\s*\$30/i);
    assert.match(card, /Sign with my wallet/);
    await ask(page, 'lock the vault');
    await page.waitForFunction(() => document.querySelectorAll('.vcx').length === 2, null, { timeout: 30_000 });
    assert.match(await page.locator('.vcx').last().innerText(), /Open\s*→\s*Locked by the owner/);
    assert.deepEqual(errors, []);
    await done();
  });
});
