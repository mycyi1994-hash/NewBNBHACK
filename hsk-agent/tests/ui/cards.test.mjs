// The v2 cards, lists and detail view (src/Perf.tsx): the agent's own money as the hero with just holding under it,
// three marks against holding, one page-level period, lists grouped by tier with holding as a row and no ranks,
// and a detail view whose extra numbers stay closed under "More".
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, go, open } from './helpers.mjs';

after(close);

describe('cards and lists', () => {
  test('a market card leads with money and holding, carries three marks, and the period switch drives every card', async () => {
    const { page, errors, done } = await open('desktop');
    await go(page, 'agents');
    await page.locator('.subnav button').nth(1).click();
    const card = page.locator('.mc:not(.mp-skel)').first();
    await card.waitFor({ timeout: 90_000 });
    assert.match(await card.locator('.pf-hero > b').innerText(), /^\$[\d,]+/, 'the hero is money');
    assert.match(await card.locator('.pf-hold').innerText(), /^Just holding \$[\d,]+/);
    assert.equal(await card.locator('.pf-mark').count(), 3);
    const label = async () => card.locator('.pf-hero small').innerText();
    const before = await label();
    await page.locator('.pf-switch button').first().click();
    assert.notEqual(await label(), before, 'the card follows the period switch');
    assert.match(await page.locator('.pf-switch button').first().getAttribute('aria-pressed'), /true/);
    assert.deepEqual(errors, []);
    await done();
  });

  test('the at-a-glance tab groups agents by tier, ends each list with just holding, and shows no ranks', async () => {
    const { page, errors, done } = await open('desktop');
    await go(page, 'agents');
    await page.locator('.subnav button').first().click();
    await page.locator('.tp-list .ar-row').first().waitFor({ timeout: 90_000 });
    const lists = page.locator('.mp-sec .tp-list');
    const n = await lists.count();
    assert.ok(n >= 1);
    for (let i = 0; i < n; i++) assert.equal(await lists.nth(i).locator('.pf-holdrow').count(), 1, 'one holding row per list');
    assert.equal(await page.locator('.tp-n, .lg-n, .rank-n').count(), 0, 'no rank numbers');
    assert.doesNotMatch(await page.locator('.mp-head h1').innerText(), /top/i, 'the title does not claim "top"');
    assert.deepEqual(errors, []);
    await done();
  });

  test('the detail view: three period cells, extra numbers closed under "More"', async () => {
    const { page, errors, done } = await open('desktop');
    await page.waitForSelector('.chart-card', { timeout: 30_000 });
    const row = page.locator('.tk-agents .tk-tier .ar-open:not([disabled])').first();
    await row.waitFor({ timeout: 90_000 });
    await row.click();
    await page.waitForSelector('.bt.v2', { timeout: 30_000 });
    assert.equal(await page.locator('.dt-cell').count(), 3);
    assert.equal(await page.locator('.dt-more').getAttribute('open'), null, '"More" starts closed');
    assert.equal(await page.locator('.dt-bar').count(), 2, 'agent and holding as two bars');
    assert.deepEqual(errors, []);
    await done();
  });
});
