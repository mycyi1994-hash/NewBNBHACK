import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinsToLeave, moveStage, startTerms, stepOf, takeOutList } from './move.ts';
import type { OldVault, VaultInfo } from './parts.tsx';

const USDT = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029';
const WBTC = { symbol: 'WBTC', address: '0x6119ca49a79f5825c8b345f8d7ac36b272565b14', decimals: 8, amount: '0.00033712', valueUsdt: '19.9' };
const old = (over: Partial<OldVault> = {}): OldVault => ({ vault: '0xold', version: 2, usdtBalance: '80', holdings: [], totalUsdt: '80', ...over });
const vault = (over: Partial<VaultInfo> = {}): VaultInfo => ({ configured: true, vault: '0xnew', version: 3, usdtBalance: '0', holdings: [], walletUsdt: '0', upgrade: { available: false }, moved: false, ...over });

test('the step that is waiting is read from the chain alone: old vault, new vault and wallet balances', () => {
  // an old vault and something newer to move to: make the new vault
  assert.equal(moveStage(vault({ vault: '0xold', version: 2, usdtBalance: '80', upgrade: { available: true, to: 3 } })), 'make');
  // the new vault exists and is empty, the old one still holds something: take it out (also after a closed tab)
  assert.equal(moveStage(vault({ moved: true, old: old() })), 'takeOut');
  assert.equal(moveStage(vault({ moved: true, old: old({ usdtBalance: '0', holdings: [WBTC], totalUsdt: '19.9' }) })), 'takeOut', 'half taken out is still step 2');
  // the old one is empty, the money is in the wallet, the new vault is empty: put it in
  assert.equal(moveStage(vault({ moved: true, walletUsdt: '80' })), 'putIn');
  // the money is in: nothing to show
  assert.equal(moveStage(vault({ moved: true, usdtBalance: '80', walletUsdt: '3' })), null);
  assert.deepEqual([stepOf('make'), stepOf('takeOut'), stepOf('putIn'), stepOf('left'), stepOf(null)], [1, 2, 3, null, null]);
});

test('after the move, money still in the old vault is a line of its own, not the three steps', () => {
  assert.equal(moveStage(vault({ moved: true, usdtBalance: '80', old: old({ usdtBalance: '5', totalUsdt: '5' }) })), 'left');
  assert.equal(moveStage(vault({ moved: true, holdings: [WBTC], old: old() })), 'left', 'a new vault that holds a coin is not empty');
});

test('a wallet that never had an old vault, a demo, or no answer yet sees nothing', () => {
  assert.equal(moveStage(vault({ walletUsdt: '500' })), null, 'an empty first vault and a full wallet is the ordinary deposit, not a move');
  assert.equal(moveStage(vault({ usdtBalance: '20' })), null);
  assert.equal(moveStage({ configured: false, upgrade: { available: true } }), null);
  assert.equal(moveStage(null), null);
  assert.equal(moveStage(vault({ upgrade: undefined, moved: undefined })), null, 'an older server that says nothing about moving');
});

test('taking out is one withdrawal per token the old vault holds, USDT first, in the exact amounts', () => {
  assert.deepEqual(takeOutList(old({ holdings: [WBTC] }), USDT), [
    { symbol: 'USDT', address: USDT, decimals: 6, amount: '80' },
    { symbol: 'WBTC', address: WBTC.address, decimals: 8, amount: '0.00033712' },
  ]);
  assert.deepEqual(takeOutList(old({ usdtBalance: '0', holdings: [WBTC] }), USDT).map((x) => x.symbol), ['WBTC']);
  assert.deepEqual(takeOutList(old({ usdtBalance: '9.000001' }), USDT), [{ symbol: 'USDT', address: USDT, decimals: 6, amount: '9.000001' }]);
  assert.deepEqual(takeOutList(old({ usdtBalance: '0' }), USDT), []);
});

test('the coins that will not move: in the active vault before the new one is made, in the old vault after', () => {
  const before = vault({ vault: '0xold', version: 2, usdtBalance: '80', holdings: [WBTC], upgrade: { available: true, to: 3 } });
  assert.deepEqual(coinsToLeave(before, 'make'), ['WBTC']);
  const after = vault({ moved: true, old: old({ holdings: [WBTC] }) });
  assert.deepEqual(coinsToLeave(after, 'takeOut'), ['WBTC']);
  assert.deepEqual(coinsToLeave(vault({ moved: true, old: old() }), 'takeOut'), []);
});

test('how a new vault starts is read from the vault: limits, stop-loss, days of agent permission', () => {
  const now = 1_800_000_000_000;
  const v = vault({ maxTradeUsdt: '50', maxDailyUsdt: '100', stopLossBps: 1500, session: { agent: '0xa', until: now / 1000 + 30 * 86_400 - 120, assets: ['BTC'], ours: true } });
  assert.deepEqual(startTerms(v, now), { perTrade: '50', perDay: '100', stopPct: 15, days: 30 });
  assert.deepEqual(startTerms(vault({ session: { agent: '0xa', until: now / 1000 - 5, assets: [], ours: true } }), now), { perTrade: undefined, perDay: undefined, stopPct: undefined, days: undefined }, 'an ended permission and no stop-loss are not claimed');
});
