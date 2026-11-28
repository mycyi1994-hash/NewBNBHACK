// The list under the chart is the one list: Moa AI first, then the tiers. One line and the badges under it agree,
// a badge is the difference of the two amounts on screen, names are whole on a desktop and a phone, and nothing is
// marked "recommended".
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, go, open } from './helpers.mjs';

after(close);

const digits = (s) => Number(s.replace(/[^\d]/g, ''));
/** Every open list under the chart: its rows (amount, badge text and classes) and its holding row's amount. */
const readLists = (page) => page.evaluate(() => [...document.querySelectorAll('.tk-agents div.tk-tier .tk-list')].map((ol) => ({
  hold: ol.querySelector('.pf-holdrow-v')?.textContent ?? '',
  rows: [...ol.querySelectorAll('.ar-row')].map((li) => ({
    name: li.querySelector('.ar-main b')?.textContent ?? '',
    amount: li.querySelector('.ar-num')?.firstChild?.textContent ?? '',
    badge: li.querySelector('.pf-vs')?.textContent ?? '',
    cls: li.querySelector('.pf-vs')?.className ?? '',
  })),
})));

/** A Moa AI feed that is deciding and holds a quarter, for the coin asked about. */
async function aiOn(page) {
  await page.route('**/api/ai/decisions**', (route) => {
    const asset = new URL(route.request().url()).searchParams.get('asset');
    const d = { at: Date.now() - 3_600_000, candle: Math.floor(Date.now() / 1000) - 18_000, asset, model: 'test', target: 0.25, proposed: 0.25, prev: null, reason: 'Test reason.', reasonKo: '테스트 이유.', signals: [], price: 100, hash: `0x${'0'.repeat(64)}` };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ asset, state: 'on', every: 14_400_000, model: 'test', decisions: [d], paper: null, count: 1 }) });
  });
}

describe('the list under the chart', () => {
  for (const [lang, stake] of [['en', 1000], ['ko', 100]]) {
    test(`${lang}: a badge is the difference of the two amounts on screen, and the line agrees with the badges, for every period`, async () => {
      const { page, errors, done } = await open('desktop', '', { 'moa.lang': lang });
      await page.locator('.tk-agents div.tk-tier .ar-row').first().waitFor({ timeout: 120_000 });
      for (let p = 0; p < 3; p++) {
        await page.locator('.tdock-head .pf-switch button').nth(p).click();
        await page.waitForTimeout(300);
        const lists = await readLists(page);
        assert.ok(lists.length >= 1 && lists[0].rows.length >= 1, 'the list is there');
        let seen = 0, ahead = 0;
        for (const l of lists) {
          const hold = digits(l.hold);
          for (const r of l.rows) {
            if (!r.badge) continue;   // no result for this period
            seen++;
            const mine = digits(r.amount);
            if (/\bahead\b/.test(r.cls)) ahead++;
            if (/\beven\b/.test(r.cls)) continue;
            assert.equal(digits(r.badge), Math.abs(mine - hold), `${r.name}: ${r.amount} against ${l.hold} reads "${r.badge}"`);
            assert.equal(/\bahead\b/.test(r.cls), mine > hold, `${r.name}: ahead only when its amount is the larger`);
            // Green is for an agent whose amount on screen is above what was put in; ahead of holding at or under it is grey.
            assert.equal(/\bdown\b/.test(r.cls), mine > hold && mine <= stake, `${r.name}: grey when ahead but not above what was put in`);
          }
        }
        // The line over the list: present while no agent earned "ahead", and in step with the badges under it.
        const line = page.locator('.tk-agents .tk-none[data-kind]');
        const kind = await line.count() ? await line.getAttribute('data-kind') : null;   // no line once an agent earns "ahead"
        if (kind === 'none') assert.equal(ahead, 0, 'the line says none did better: no ahead badge under it');
        if (kind === 'lost' || kind === 'won' || kind === 'better') assert.ok(ahead * 2 > seen, 'the line says most did better: most badges are ahead');
        // "Lost less" sits over grey badges, "made more" over green ones.
        const grey = lists.flatMap((l) => l.rows).filter((r) => /\bdown\b/.test(r.cls)).length;
        if (kind === 'lost') assert.ok(grey * 3 >= ahead * 2, 'the line says most lost less: most ahead badges are grey');
        if (kind === 'won') assert.ok(grey * 3 <= ahead, 'the line says most made more: most ahead badges are green');
        if (kind === 'some') assert.ok(ahead > 0 && ahead * 2 <= seen);
        if (kind === 'nodata') assert.equal(seen, 0);
      }
      assert.deepEqual(errors, []);
      await done();
    });
  }

  test('one list: no "by horizon" tab, no "recommended" mark, and the detail view still opens from a row', async () => {
    const { page, errors, done } = await open('desktop');
    await page.locator('.tk-agents div.tk-tier .ar-row').first().waitFor({ timeout: 120_000 });
    const tabs = await page.locator('.tdock-tabs [role=tab]').allInnerTexts();
    assert.ok(!tabs.some((x) => /horizon|기간별/i.test(x)), `tabs: ${tabs.join(' | ')}`);
    assert.equal(await page.locator('.hzb, .hzr, .badge.pick').count(), 0);
    // The classics and the lab are in the same list, folded.
    assert.ok(await page.locator('.tk-agents details.tk-tier').count() >= 1, 'folded tiers are part of the list');
    for (const d of await page.locator('.tk-agents details.tk-tier > summary').all()) await d.click();
    assert.doesNotMatch(await page.locator('.tk-agents').innerText(), /\bPick\b|Recommended|추천$/m);
    await page.locator('.tk-tier .ar-open:not([disabled])').first().click();
    await page.waitForSelector('.bt.v2', { timeout: 30_000 });
    assert.deepEqual(errors, []);
    await done();
  });

  for (const size of ['desktop', 'phone']) {
    for (const lang of ['en', 'ko']) {
      test(`${size}, ${lang}: every agent name is whole and no rule line is cut`, async () => {
        const { page, errors, done } = await open(size, '', { 'moa.lang': lang });
        await aiOn(page);
        await page.reload();
        await page.locator('.tk-agents div.tk-tier .ar-row').first().waitFor({ timeout: 120_000 });
        await page.locator('.tk-ai .ar-row').waitFor({ timeout: 30_000 });
        const cut = await page.evaluate(() => [...document.querySelectorAll('.tk-agents div.tk-tier .ar-main b, .tk-agents div.tk-tier .ar-main small, .tk-ai .ar-main b, .tk-ai .ar-main small')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1).map((el) => el.textContent));
        assert.deepEqual(cut, [], 'nothing is cut');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll');
        assert.deepEqual(errors, []);
        await done();
      });
    }
  }

  test('Moa AI is the first row: what it is, the share it holds, no past results, and Hire opens the sheet', async () => {
    const { page, errors, done } = await open('desktop');
    await aiOn(page);
    await page.reload();
    const ai = page.locator('.tk-agents .tk-ai .ar-row');
    await ai.waitFor({ timeout: 60_000 });
    await page.locator('.tk-agents div.tk-tier .ar-row').first().waitFor({ timeout: 120_000 });
    // Above Moa's default.
    const [aiY, firstY] = await Promise.all([ai.boundingBox(), page.locator('.tk-agents div.tk-tier .ar-row').first().boundingBox()]);
    assert.ok(aiY.y < firstY.y, 'above the default');
    const text = await ai.innerText();
    assert.match(text, /Moa AI/);
    assert.match(text, /every 4 hours/);
    assert.match(text, /no past results/);
    assert.match(text, /25%/);
    assert.equal(await ai.locator('.pf-vs.ahead, .pf-vs.behind').count(), 0, 'no result against holding: it has none');
    await ai.locator('.tk-hire').click();
    await page.waitForSelector('.modal #hire-budget', { timeout: 10_000 });
    assert.deepEqual(errors, []);
    await done();
  });

  test('without an AI key the row says so and cannot be hired', async () => {
    const { page, errors, done } = await open('desktop');
    const ai = page.locator('.tk-agents .tk-ai .ar-row');
    await ai.waitFor({ timeout: 60_000 });
    await page.locator('.tk-agents .tk-ai .ar-skel').waitFor({ state: 'detached', timeout: 30_000 });   // the feed has arrived
    assert.ok(await ai.locator('.tk-hire').isDisabled());
    assert.doesNotMatch(await ai.locator('.ar-num').innerText(), /%/, 'no share: it is not deciding');
    assert.doesNotMatch(await ai.innerText(), /every 4 hours/, 'it does not claim to be deciding');
    assert.deepEqual(errors, []);
    await done();
  });
});

describe('other screens', () => {
  test('My agents shows one invitation to add an agent, not two', async () => {
    const { page, errors, done } = await open('desktop');
    await go(page, 'mine');
    await page.waitForSelector('.mine-page .slot.add', { timeout: 30_000 });
    assert.equal(await page.locator('.slot.add').count(), 1);
    assert.deepEqual(errors, []);
    await done();
  });

  test('fees and risks names the risk of the AI agent and does not call the pick a backtest result', async () => {
    const { page, errors, done } = await open('desktop', '?trust');
    await page.waitForSelector('.trust-page .tr-card.risk', { timeout: 30_000 });
    assert.match(await page.locator('.tr-card.risk').innerText(), /Moa AI .*an AI can be wrong.*no past results.*budget.*vault/s);
    assert.doesNotMatch(await page.locator('.trust-page').innerText(), /applied to past data/);
    assert.deepEqual(errors, []);
    await done();
  });

  test('in Korean the vault is 금고 on the trust page and in the sidebar', async () => {
    const { page, errors, done } = await open('desktop', '?trust', { 'moa.lang': 'ko' });
    await page.waitForSelector('.trust-page .tr-card.risk', { timeout: 30_000 });
    const text = await page.locator('.app').innerText();
    assert.match(text, /금고/);
    assert.doesNotMatch(text, /볼트/);
    assert.deepEqual(errors, []);
    await done();
  });
});
