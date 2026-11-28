// Every screen loads with no page error and no sideways scroll, on a desktop and a phone; then the key flows.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, go, MAINNET_VAULT, noOverflow, open } from './helpers.mjs';

after(close);

const SCREENS = [
  { name: 'trade', ready: '.chart-card' },
  { name: 'agents', ready: '.market-page' },
  { name: 'build', ready: '.build-page' },
  { name: 'mine', ready: '.mine-page' },
];

for (const size of ['desktop', 'phone']) {
  describe(`screens at ${size} width`, () => {
    for (const s of SCREENS) {
      test(`${s.name} loads cleanly`, async () => {
        const { page, errors, done } = await open(size);
        await page.waitForSelector('.app', { timeout: 30_000 });
        if (s.name !== 'trade') await go(page, s.name);
        await page.waitForSelector(s.ready, { timeout: 30_000 });
        await page.waitForTimeout(1500);
        assert.deepEqual(errors, [], 'no page errors');
        assert.ok(await noOverflow(page), 'no horizontal overflow');
        await done();
      });
    }
    for (const [name, query, ready] of [['vault list', '?vault', '.vv-page'], ['one vault', `?vault=${MAINNET_VAULT}`, '.vv-top'], ['fees and risks', '?trust', '.trust-page']]) {
      test(`${name} page loads cleanly`, async () => {
        const { page, errors, done } = await open(size, query);
        await page.waitForSelector(ready, { timeout: 30_000 });
        await page.waitForTimeout(1500);
        assert.deepEqual(errors, []);
        assert.ok(await noOverflow(page));
        await done();
      });
    }
  });
}

describe('key flows', () => {
  test('the ready agent on My agents opens the hire sheet', async () => {
    const { page, errors, done } = await open('desktop');
    await go(page, 'mine');
    await page.locator('.slot.ready .btn-primary').click({ timeout: 60_000 });
    await page.waitForSelector('.modal #hire-budget', { timeout: 10_000 });
    assert.ok(await page.locator('.modal .btn-primary.hire').isVisible(), 'the confirm button is there');
    assert.deepEqual(errors, []);
    await done();
  });

  test('the builder walks from the coin to the next step', async () => {
    const { page, errors, done } = await open('desktop');
    await go(page, 'build');
    await page.waitForSelector('.bd-steps li.now', { timeout: 30_000 });
    const first = await page.locator('.bd-steps li.now').innerText();
    await page.locator('.bd-nav .btn-primary').click({ timeout: 30_000 });
    await page.waitForTimeout(800);
    assert.notEqual(await page.locator('.bd-steps li.now').innerText(), first, 'the current step moved on');
    assert.equal(await page.locator('.bd-steps li.done').count(), 1);
    assert.deepEqual(errors, []);
    await done();
  });

  test('the LP studio opens with a preset strategy', async () => {
    const { page, errors, done } = await open('desktop');
    await page.waitForSelector('.chart-card', { timeout: 30_000 });
    await page.locator('.segmented.venue button').nth(1).click();
    await page.locator('.tk-lp-tile').first().click({ timeout: 60_000 });
    await page.waitForSelector('.lps', { timeout: 30_000 });
    assert.deepEqual(errors, []);
    await done();
  });

  test('on HSKSwap the chart keeps about 45% of the trade panel at 1440x900', async () => {
    const { page, done } = await open('desktop');
    await page.waitForSelector('.chart-card', { timeout: 30_000 });
    await page.locator('.segmented.venue button').nth(1).click();
    await page.waitForSelector('.pr', { timeout: 60_000 });
    await page.waitForTimeout(1000);
    const share = await page.evaluate(() => document.querySelector('.chart-main').getBoundingClientRect().height / document.querySelector('.trade-main').getBoundingClientRect().height);
    assert.ok(share >= 0.44, `chart share ${share.toFixed(2)}`);
    await done();
  });

  test('the market tabs switch', async () => {
    const { page, errors, done } = await open('desktop');
    await go(page, 'agents');
    const tabs = page.locator('.subnav button');
    assert.equal(await tabs.count(), 3);
    for (let i = 0; i < 3; i++) {
      await tabs.nth(i).click();
      await page.waitForTimeout(500);
      assert.match((await tabs.nth(i).getAttribute('class')) ?? '', /\bon\b/);
    }
    assert.deepEqual(errors, []);
    await done();
  });

  test('the vault view reads a mainnet vault without logging in', async () => {
    const { page, errors, done } = await open('desktop', `?vault=${MAINNET_VAULT}`);
    await page.waitForSelector('.vv-rules', { timeout: 60_000 });
    assert.match(await page.locator('.vv-id').innerText(), /0x6A35/);
    await page.waitForSelector('.vv-events, .vv-empty', { timeout: 60_000 });
    assert.deepEqual(errors, []);
    await done();
  });

  test('offline, "how is bitcoin?" gets a market answer, not a request for a goal', async () => {
    const { page, done } = await open('desktop');
    await page.waitForSelector('.moa-col textarea', { timeout: 30_000 });
    await page.waitForTimeout(3000);
    await page.fill('.moa-col textarea', 'how is bitcoin?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.note-offline', { timeout: 30_000 });
    const last = page.locator('.note').last();
    assert.ok(await last.locator('.sky-card, table').count() > 0 || /bitcoin/i.test(await last.innerText()), 'answers about bitcoin');
    await done();
  });
});

describe('agent list', () => {
  test('the list under the chart opens with the default basket, and lab agents are not in it', async () => {
    const { page, errors, done } = await open('desktop');
    // The open tiers (default, ahead, calmer) are plain blocks; the classics and the lab are folded <details>.
    const rows = page.locator('.tk-agents div.tk-tier .ar-row');
    await rows.first().waitFor({ timeout: 120_000 });
    assert.match(await rows.first().innerText(), /Steady Basket/);
    const all = await rows.allInnerTexts();
    assert.ok(!all.some((x) => /1h|4h|Tempo/.test(x)), 'no lab agent in the picks');
    assert.deepEqual(errors, []);
    await done();
  });
});
