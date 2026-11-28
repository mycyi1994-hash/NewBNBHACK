// Moving to a new vault (src/MoveVault.tsx): the card with three steps wherever the vault is shown, the step that is
// waiting taken from what /api/vault reports, and the line about money still in the old vault. The server under test
// is a demo, so /api/vault is answered here with the states a moving wallet goes through (the real walk, on a fork of
// mainnet, is contracts/scripts/upgrade-fork-test.mjs).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, go, noOverflow, open } from './helpers.mjs';

after(close);

const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OLD = '0x6A355aE335f06971C337c900783C2e016410b33C', NEW = '0x1F68000000000000000000000000000000Ec8600';
const USDT = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029';
const WBTC = { symbol: 'WBTC', address: '0x6119ca49a79f5825c8b345f8d7ac36b272565b14', decimals: 8, amount: '0.00033712', costUsdt: '20', valueUsdt: '19.95' };
const net = { chainId: 177, explorer: 'https://hsk.blockscout.com', usdt: USDT, agent: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', tokens: [{ symbol: 'WBTC', address: WBTC.address, decimals: 8 }] };
const session = { 'moa.session.v1': JSON.stringify({ address: ME, token: 'ui-test', expiresAt: Date.now() + 3_600_000 }) };
const vault = (over) => ({ configured: true, service: true, signedIn: true, owner: ME, net, holdings: [], walletUsdt: '0', stopLossBps: 0, paused: false, creatorFees: true, upgrade: { available: false }, moved: false, ...over });
const oldVault = { vault: OLD, version: 2, usdtBalance: '9', holdings: [], totalUsdt: '9' };
const newVault = { vault: NEW, version: 3, usdtBalance: '0', maxTradeUsdt: '50', maxDailyUsdt: '100', remainingTodayUsdt: '100', maxSlippageBps: 150, stopLossBps: 1500, session: { agent: net.agent, until: Math.floor(Date.now() / 1000) + 30 * 86_400, maxTradeUsdt: '50', assets: ['HSK', 'ETH', 'BTC'], ours: true } };
const STATES = {
  make: vault({ vault: OLD, version: 2, usdtBalance: '9', maxSlippageBps: 150, upgrade: { available: true, to: 3 } }),
  makeWithCoin: vault({ vault: OLD, version: 2, usdtBalance: '9', holdings: [WBTC], maxSlippageBps: 150, upgrade: { available: true, to: 3 } }),
  takeOut: vault({ ...newVault, moved: true, old: oldVault }),
  putIn: vault({ ...newVault, moved: true, walletUsdt: '9' }),
  left: vault({ ...newVault, usdtBalance: '9', moved: true, old: { ...oldVault, usdtBalance: '5', totalUsdt: '5' } }),
  plain: vault({ ...newVault, usdtBalance: '9' }),
};

/** A logged-in page whose /api/vault answers with `state()`; My agents is open. */
async function at(size, state, storage = {}) {
  const o = await open(size, '', { ...session, ...storage });
  await o.page.route('**/api/vault', (r) => r.fulfill({ json: state() }));
  await o.page.route('**/api/auto', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { agents: [] } }) : r.continue()));
  await o.page.reload();
  await o.page.waitForSelector('.acct-btn', { timeout: 30_000 });
  // helpers' go() finds a screen by its English name; in Korean, My agents is found by its place (4th in the sidebar, 3rd tab)
  if (storage['moa.lang'] === 'ko') await o.page.locator(size === 'phone' ? '.tab:visible' : '.nav-item:visible').nth(size === 'phone' ? 2 : 3).click();
  else await go(o.page, 'mine');
  await o.page.waitForSelector('.vault-card', { timeout: 30_000 });
  return o;
}
const steps = (card) => card.locator('.pf-steps li').evaluateAll((xs) => xs.map((x) => x.className));

describe('moving to a new vault', () => {
  test('an old vault with something newer to move to shows one card: why, three steps, the first one waiting', async () => {
    const { page, errors, done } = await at('desktop', () => STATES.make);
    const card = page.locator('.vault-card .move');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('.vault-card .move').count(), 1, 'one card');
    assert.equal(await card.locator('.move-title b').innerText(), 'Move to a new vault');
    assert.match(await card.locator('.move-title small').innerText(), /^Safer/);
    assert.deepEqual(await steps(card), ['on', '', '']);
    assert.match(await card.locator('.pf-steps li').first().innerText(), /No signature, no fee/);
    assert.equal((await card.locator('.move-go').innerText()).trim(), 'Make my new vault');
    assert.equal(await card.locator('.move-note').count(), 0, 'nothing about coins when the vault holds only USDT');
    // the same card in the account menu
    await page.locator('.acct-btn').click();
    await page.locator('.acct-pop .move').waitFor({ timeout: 10_000 });
    assert.deepEqual(await steps(page.locator('.acct-pop .move')), ['on', '', '']);
    assert.deepEqual(errors, []);
    await done();
  });

  test('step 1 is one press and no wallet: the card moves on to taking the money out', async () => {
    let state = STATES.make, asked = 0;
    const { page, errors, done } = await at('desktop', () => state);
    await page.route('**/api/vault/upgrade', (r) => { asked++; state = STATES.takeOut; return r.fulfill({ json: { ok: true, vault: NEW, made: true, from: OLD, paused: 0 } }); });
    const card = page.locator('.vault-card .move');
    await card.locator('.move-go').click({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll('.vault-card .move .pf-steps li.done').length === 1, null, { timeout: 15_000 });
    assert.equal(asked, 1);
    assert.deepEqual(await steps(card), ['done', 'on', '']);
    assert.equal((await card.locator('.move-go').innerText()).trim(), 'Take out $9.00');
    assert.match(await card.locator('.fund-note').last().innerText(), /\$50 per trade · \$100 per day · stop-loss 15% · agent permission for 30 days/, 'how the new vault starts, in one line');
    assert.deepEqual(errors, []);
    await done();
  });

  test('coming back with the old vault emptied is step 3, with the wallet\'s USDT offered', async () => {
    const { page, errors, done } = await at('desktop', () => STATES.putIn);
    const card = page.locator('.vault-card .move');
    await card.waitFor({ timeout: 15_000 });
    assert.deepEqual(await steps(card), ['done', 'done', 'on']);
    assert.equal(await card.locator('input').inputValue(), '9');
    assert.equal((await card.locator('.move-go').innerText()).trim(), 'Put in $9.00');
    await card.locator('input').fill('10');
    assert.ok(await card.locator('.move-go').isDisabled(), 'more than the wallet holds cannot be sent');
    // "Not now" puts the offer away in this browser; nothing else changes
    await card.locator('.move-act .btn-text').click();
    await page.waitForFunction(() => !document.querySelector('.vault-card .move'), null, { timeout: 5_000 });
    await page.reload();
    await page.waitForSelector('.acct-btn', { timeout: 30_000 });
    await go(page, 'mine');
    await page.waitForSelector('.vault-card', { timeout: 30_000 });
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.vault-card .move').count(), 0, 'and it stays away after a reload');
    assert.deepEqual(errors, []);
    await done();
  });

  test('a coin in the old vault: one line says to sell it to USDT first, and only USDT moves', async () => {
    const { page, errors, done } = await at('desktop', () => STATES.makeWithCoin);
    const noteText = await page.locator('.vault-card .move .move-note').innerText({ timeout: 15_000 });
    assert.match(noteText, /You hold BTC\. Sell it to USDT first/);
    assert.match(noteText, /Only USDT moves/);
    assert.match(await page.locator('.vault-card .move .pf-steps li').nth(1).innerText(), /2 wallet confirmations/);
    assert.deepEqual(errors, []);
    await done();
  });

  test('after the move, money still in the old vault is one small line; an ordinary vault shows nothing', async () => {
    const a = await at('desktop', () => STATES.left);
    const line = a.page.locator('.vault-card .move-left');
    await line.waitFor({ timeout: 15_000 });
    assert.match(await line.innerText(), /\$5\.00 is still in your old vault/);
    assert.equal((await line.locator('.link').innerText()).trim(), 'Take it out');
    assert.equal(await a.page.locator('.vault-card .move').count(), 0, 'not the three steps');
    assert.deepEqual(a.errors, []);
    await a.done();
    const b = await at('desktop', () => STATES.plain);
    await b.page.waitForTimeout(800);
    assert.equal(await b.page.locator('.move, .move-left').count(), 0);
    assert.deepEqual(b.errors, []);
    await b.done();
  });

  test('the creator-fee picker shows only when the server says its vaults can pay one', async () => {
    const made = { 'moa.made.v1.guest': JSON.stringify([{ id: 'm1', name: 'ETH trend', market: 'ETHUSDT-PERPETUAL', buy: [{ a: { k: 'price' }, op: 'above', b: { k: 'sma', n: 200 } }], sell: [{ a: { k: 'price' }, op: 'below', b: { k: 'sma', n: 200 } }], createdAt: 1 }]) };
    for (const [terms, picker] of [[null, 0], [{ platformFeeBps: 0, creatorFees: true }, 1]]) {
      const { page, errors, done } = await open('desktop', '', made);
      if (terms) { await page.route('**/api/terms', (r) => r.fulfill({ json: terms })); await page.reload(); }
      await go(page, 'build');
      await page.locator('.bd-mine-list .bd-mine-act .btn').nth(2).click({ timeout: 30_000 });
      await page.waitForSelector('.modal .sh-sheet', { timeout: 10_000 });
      await page.waitForTimeout(500);
      assert.equal(await page.locator('.modal .sh-fees').count(), picker, terms ? 'a version-3 server: the picker is there' : 'the demo server makes no vaults: no picker');
      assert.deepEqual(errors, []);
      await done();
    }
  });

  test('on a phone, in Korean: the card fits, and says it in plain words', async () => {
    const { page, errors, done } = await at('phone', () => STATES.takeOut, { 'moa.lang': 'ko' });
    const card = page.locator('.vault-card .move');
    await card.waitFor({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    const text = await card.innerText();
    assert.match(text, /새 금고로 옮기기/);
    assert.match(text, /옛 금고에서 전부 꺼내기/);
    assert.match(text, /권한 기한 30일/);
    assert.doesNotMatch(text, /v3|버전|마이그레이션|세션|migration|session/i, 'no jargon');
    assert.ok(await noOverflow(page), 'no horizontal overflow');
    await page.locator('.acct-btn').click();
    await page.locator('.acct-pop .move').waitFor({ timeout: 10_000 });
    assert.ok(await noOverflow(page), 'no horizontal overflow with the account menu open');
    assert.deepEqual(errors, []);
    await done();
  });
});
