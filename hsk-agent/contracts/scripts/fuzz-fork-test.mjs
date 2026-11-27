// Randomized (property) test of MoaVault version 3 on a local fork of HSK Chain mainnet: hundreds of random owner
// settings, agent trades, creator approvals, budgets, stranger calls and jumps in time, each checked against a
// model of what the vault must allow and an exact account of where every unit of USDT went.
// Invariants checked after every step:
//   I1 a buy goes through exactly when the model allows it: amount ≤ per-trade limit, the day's spending stays under
//      the daily limit, it fits the agent's budget when budgets are on, the vault holds the USDT, nothing paused or
//      halted, and minOut is at or above the floor from the pool's 10-minute average (a pool moving faster than the
//      slippage ceiling may refuse it with PriceMoving, counted apart; nothing else may refuse it)
//   I2 a buy takes exactly amountIn USDT from the vault and pays the agent's approved creator exactly
//      floor(amountIn × min(asked, approved) / 10,000), at most 1%, and nobody else anything
//   I3 a sell is never held up by the limits or budgets; the creator gets exactly floor(gross × rate / 10,000)
//   I4 the day's spending and every agent's budget on-chain equal the model's
//   I5 the holding's recorded cost rises by what went into the pool (amountIn − fee), never by the fee
//   I6 the agent key and strangers end every step holding exactly what they held before (no USDT, no coins)
//   I7 owner-only calls from a stranger or the agent key always revert NotOwner; approvals over 1% revert FeeTooHigh
//   I8 after the pool has been still for over 10 minutes, the average-price quote equals the spot quote within 2 bps
//      (checks the vault's own tick-to-price math against the pool's price)
// Usage: node --experimental-strip-types scripts/fuzz-fork-test.mjs   (FUZZ_RUNS=300, FUZZ_SEED=1, FORK_PORT=8560)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { agentIdOf, TOKENS, USDT } from '../../server/executor.ts';

const PORT = process.env.FORK_PORT || '8560';
const RUNS = Number(process.env.FUZZ_RUNS || 300);
let seed = Number(process.env.FUZZ_SEED || 1) >>> 0;
const RPC = `http://127.0.0.1:${PORT}`;
const ROUTER = '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3';
const POOLS = { HSK: '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc', ETH: '0xb92b79ed6b370d5cfee2e14b1d0983c258304c16', BTC: '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a' };
const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  c1: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  c2: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  stranger: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
};
const art = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const F = art('../out/MoaVaultFactory.json'), abi = art('../out/MoaVault.json').abi;
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const chain = { id: 177, name: 'HSK fork', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const NO_LIMIT = 2n ** 256n - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';

// xorshift32: the same seed gives the same run
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const usd = (dollars) => BigInt(Math.round(dollars * 1e6));

let pass = 0, fail = 0;
const counts = {};
const tally = (k) => (counts[k] = (counts[k] ?? 0) + 1);
const failures = [];
const check = (name, cond, detail = '') => { if (cond) pass++; else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); } };

const node = spawn('npx', ['hardhat', 'node', '--port', PORT], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
let nodeLog = '';
node.stdout.on('data', (d) => (nodeLog += d));
node.stderr.on('data', (d) => (nodeLog += d));
const stop = () => { try { if (process.platform === 'win32') node.kill('SIGTERM'); else process.kill(-node.pid, 'SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);

const reason = (e) => /(NotOwner|NotAgent|IsPaused|Halted|MarketDisabled|TradeTooLarge|DailyCapExceeded|OverBudget|SlippageTooLoose|PriceMoving|FeeTooHigh|BadCreator|BadLimits|Too little received|STF|transfer failed)/.exec(String(e?.message ?? e))?.[1] ?? String(e?.message ?? e).slice(0, 120);

try {
  for (let i = 0; i < 120 && !/Started HTTP/.test(nodeLog); i++) await new Promise((r) => setTimeout(r, 500));
  if (!/Started HTTP/.test(nodeLog)) throw new Error('fork node did not start:\n' + nodeLog.slice(-2000));
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const test = createTestClient({ chain, mode: 'hardhat', transport: http(RPC) });
  const acc = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]));
  const W = Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, createWalletClient({ account: a, chain, transport: http(RPC) })]));
  const mined = (hash) => pub.waitForTransactionReceipt({ hash });
  const assets = ['HSK', 'ETH', 'BTC'];
  const factory = (await mined(await W.owner.deployContract({ abi: F.abi, bytecode: F.bytecode, args: [acc.agent.address, USDT, ROUTER, 50_000_000n, 100_000_000n, 150, 1500, assets.map((a) => TOKENS[a].address), assets.map((a) => POOLS[a]), ZERO] }))).contractAddress;
  await mined(await W.owner.writeContract({ address: factory, abi: F.abi, functionName: 'createVault', args: [acc.owner.address] }));
  const vault = await pub.readContract({ address: factory, abi: F.abi, functionName: 'vaultOf', args: [acc.owner.address] });
  // a long session with no per-buy cap of its own, so the model's limits are the vault's (sessions: fork-test.mjs)
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setSession', args: [acc.agent.address, BigInt(Number((await pub.getBlock()).timestamp) + 360 * 86_400), NO_LIMIT, assets.map((a) => TOKENS[a].address)] }));
  await test.impersonateAccount({ address: POOLS.HSK });
  await test.setBalance({ address: POOLS.HSK, value: 10n ** 21n });
  const poolW = createWalletClient({ account: POOLS.HSK, chain, transport: http(RPC) });
  await mined(await poolW.sendTransaction({ to: USDT, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [vault, 3_000_000_000n] }) }));
  console.log('fork block', await pub.getBlockNumber(), 'vault', vault, 'runs', RUNS, 'seed', process.env.FUZZ_SEED || 1);

  const read = (fn, args = []) => pub.readContract({ address: vault, abi, functionName: fn, args });
  const bal = (token, who) => pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] });
  const watched = [acc.agent.address, acc.stranger.address];
  const snapshot = async () => Object.fromEntries(await Promise.all([USDT, ...assets.map((a) => TOKENS[a].address)].flatMap((t) => watched.map(async (w) => [`${t}|${w}`, await bal(t, w)]))));
  const ids = ['', 'agent-a', 'agent-b', 'agent-c'];
  const creators = [acc.c1.address, acc.c2.address];

  // the model: what the owner set, and what the vault has spent
  const m = { maxTrade: 50_000_000n, maxDaily: 100_000_000n, slip: 150, budgetsOn: false, budget: {}, creatorOf: {}, spent: {} };
  const dayNow = async () => (await pub.getBlock()).timestamp / 86_400n;
  const ownerTx = async (fn, args) => mined(await W.owner.writeContract({ address: vault, abi, functionName: fn, args }));

  for (let step = 0; step < RUNS; step++) {
    const before = await snapshot();
    const r = rnd();
    if (r < 0.06) {
      // owner: new limits (sometimes none at all)
      const none = rnd() < 0.15;
      const trade = none ? NO_LIMIT : usd(between(1, 60));
      const daily = none ? NO_LIMIT : trade + usd(between(0, 150));
      const slip = between(30, 300);
      await ownerTx('setLimits', [trade, daily, slip]);
      Object.assign(m, { maxTrade: trade, maxDaily: daily, slip });
      tally('setLimits');
    } else if (r < 0.11) {
      const id = pick(ids), amount = usd(between(0, 80));
      await ownerTx('setBudget', [agentIdOf(id), amount]);
      m.budget[id] = amount;
      if (rnd() < 0.5) { m.budgetsOn = rnd() < 0.5; await ownerTx('setBudgetsOn', [m.budgetsOn]); }
      check('I4 the budget the owner set reads back', (await read('budgetLeft', [agentIdOf(id)])) === amount);
      tally('setBudget');
    } else if (r < 0.16) {
      const id = pick(ids.slice(1)), who = pick(creators), bps = between(0, 150);
      let got = 'ok';
      try { await pub.simulateContract({ address: vault, abi, functionName: 'setCreatorFee', args: [agentIdOf(id), who, bps], account: acc.owner }); await ownerTx('setCreatorFee', [agentIdOf(id), who, bps]); } catch (e) { got = reason(e); }
      if (bps > 100) check('I7 an approval over 1% is refused', got === 'FeeTooHigh', `${bps} bps: ${got}`);
      else { check('I7 an approval up to 1% goes through', got === 'ok', got); m.creatorOf[id] = bps ? { who, bps } : undefined; }
      tally('setCreatorFee');
    } else if (r < 0.20) {
      // a stranger or the agent key tries an owner-only call
      const who = pick([acc.stranger, acc.agent]);
      const [fn, args] = pick([['setLimits', [NO_LIMIT, NO_LIMIT, 1000]], ['setBudget', [agentIdOf('agent-a'), NO_LIMIT]], ['setBudgetsOn', [false]], ['setCreatorFee', [agentIdOf('agent-a'), who.address, 100]], ['withdraw', [USDT, 1n]], ['setAgent', [who.address]], ['setStopLoss', [0]], ['setPaused', [false]]]);
      let got = 'went through';
      try { await pub.simulateContract({ address: vault, abi, functionName: fn, args, account: who }); } catch (e) { got = reason(e); }
      check(`I7 ${fn} from a non-owner is refused`, got === 'NotOwner', got);
      tally('strangerCall');
    } else if (r < 0.24) {
      // time passes: minutes to a day and a half
      await test.increaseTime({ seconds: pick([30, 300, 700, 3_600, 86_400, 130_000]) });
      await test.mine({ blocks: 1 });
      // never stop within two minutes of midnight UTC, so the model and the next block agree on the day
      const ts = (await pub.getBlock()).timestamp;
      if (ts % 86_400n > 86_280n) { await test.increaseTime({ seconds: 240 }); await test.mine({ blocks: 1 }); }
      tally('time');
    } else if (r < 0.28) {
      // I8: once the pool has been still for more than the averaging window, average and spot agree
      await test.increaseTime({ seconds: 700 });
      await test.mine({ blocks: 1 });
      const asset = pick(assets), isBuy = rnd() < 0.5;
      const amount = isBuy ? usd(between(1, 500)) : (await bal(TOKENS[asset].address, vault)) || 10n ** BigInt(TOKENS[asset].decimals - 3);
      const [spot, twap] = await Promise.all([read('quote', [TOKENS[asset].address, isBuy, amount]), read('quoteTwap', [TOKENS[asset].address, isBuy, amount])]);
      const gap = spot > twap ? spot - twap : twap - spot;
      check('I8 the 10-minute average quote equals the spot quote within 2 bps (or one unit) in a still pool', spot > 0n && (gap * 10_000n <= spot * 2n || gap <= 1n), `${asset} ${isBuy ? 'buy' : 'sell'} spot ${spot} twap ${twap}`);
      tally('twapMath');
    } else {
      // the agent trades: a buy or a sell, for a random agent, asking a random fee, sometimes with too low a minOut
      const asset = pick(assets), token = TOKENS[asset].address, feeAsk = between(0, 150);
      const held = await bal(token, vault);
      const isBuy = held === 0n || rnd() < 0.7;
      // Most buys are steered to where they can go through (an agent with budget left, a day with room), so the
      // paying path is exercised often; the rest go anywhere and probe the refusals.
      const steer = isBuy && rnd() < 0.8;
      const withRoom = ids.filter((x) => !m.budgetsOn || (m.budget[x] ?? 0n) >= 1_000_000n);
      const id = steer && withRoom.length ? pick(withRoom) : pick(ids);
      if (steer && m.maxDaily - (m.spent[await dayNow()] ?? 0n) < 1_000_000n) {
        // the day's limit is used up: wait for the next UTC day (five minutes past midnight)
        const ts = (await pub.getBlock()).timestamp;
        await test.increaseTime({ seconds: Number(86_400n - (ts % 86_400n) + 300n) });
        await test.mine({ blocks: 1 });
        tally('time');
      }
      const vaultUsdt = await bal(USDT, vault);
      const approved = m.creatorOf[id];
      const rate = approved && id ? Math.min(feeAsk, approved.bps) : 0;
      const cap = m.maxTrade === NO_LIMIT ? 70 : Math.min(70, Number(m.maxTrade / 1_000_000n) + 8);
      // Biased toward buys the vault can carry out (three in four aim inside every limit), so most steps exercise the
      // paying path; the rest probe the edges.
      const room = [m.maxTrade, m.maxDaily - (m.spent[await dayNow()] ?? 0n), m.budgetsOn ? (m.budget[id] ?? 0n) : NO_LIMIT, await bal(USDT, vault)].reduce((a, b) => (a < b ? a : b));
      const inside = room >= 1_000_000n && rnd() < 0.75;
      const amountIn = isBuy ? (inside ? 1_000_000n + BigInt(Math.floor(rnd() * Number((room > 70_000_000n ? 70_000_000n : room) - 1_000_000n))) : usd(between(1, cap) + rnd())) : (held * BigInt(between(20, 100))) / 100n;
      // dust: the pool rounds its 0.3% fee up to a whole unit, so a sale of a few units cannot meet any fair floor
      if (!isBuy && amountIn < 10n ** BigInt(Math.max(0, TOKENS[asset].decimals - 4))) continue;
      if (amountIn === 0n) continue;
      const fee = isBuy ? (amountIn * BigInt(rate)) / 10_000n : 0n;
      const floor = await read('minOutFloor', [token, isBuy, amountIn - fee]);
      const low = !steer && rnd() < 0.15;
      // 10 bps over the floor, as the server asks: the average moves a little with every second until the next block
      const minOut = low ? (floor * 97n) / 100n : (floor * 10_010n) / 10_000n;
      const day = await dayNow();
      const spent = m.spent[day] ?? 0n;
      const budget = m.budget[id] ?? 0n;
      const allowed = isBuy
        ? amountIn <= m.maxTrade && spent + amountIn <= m.maxDaily && (!m.budgetsOn || amountIn <= budget) && amountIn <= vaultUsdt && !low
        : amountIn <= held && !low;
      const cBefore = Object.fromEntries(await Promise.all(creators.map(async (c) => [c, await bal(USDT, c)])));
      const [tBefore, uBefore, costBefore] = await Promise.all([bal(token, vault), bal(USDT, vault), read('costUsdt', [token])]);
      let got = 'ok';
      try {
        const { request } = await pub.simulateContract({ address: vault, abi, functionName: id ? 'tradeFor' : 'trade', args: id ? [token, isBuy, amountIn, minOut, 'fuzz', agentIdOf(id), feeAsk] : [token, isBuy, amountIn, minOut, 'fuzz'], account: acc.agent });
        const rc = await mined(await W.agent.writeContract(request));
        if (rc.status !== 'success') got = 'reverted';
      } catch (e) { got = reason(e); }
      // The pool moving faster than the slippage ceiling may refuse a trade the limits allow; that is the protection
      // working, counted apart and bounded below.
      const priceRefusal = !low && (got === 'PriceMoving' || got === 'Too little received');
      if (priceRefusal) { tally('refused: price moving'); }
      else if (allowed) check('I1 an allowed trade goes through', got === 'ok', `${isBuy ? 'buy' : 'sell'} ${asset} ${amountIn} for '${id}': ${got}`);
      else {
        const want = low ? ['SlippageTooLoose'] : isBuy ? ['TradeTooLarge', 'DailyCapExceeded', 'OverBudget', 'STF', 'transfer failed'] : ['STF', 'transfer failed'];
        check('I1 a trade the model refuses is refused, for the right reason', got !== 'ok' && want.includes(got), `${isBuy ? 'buy' : 'sell'} ${asset} ${amountIn} for '${id}': ${got}`);
      }
      if (got === 'ok') {
        const [tAfter, uAfter, costAfter] = await Promise.all([bal(token, vault), bal(USDT, vault), read('costUsdt', [token])]);
        const cAfter = Object.fromEntries(await Promise.all(creators.map(async (c) => [c, await bal(USDT, c)])));
        const paid = Object.fromEntries(creators.map((c) => [c, cAfter[c] - cBefore[c]]));
        const payee = rate > 0 ? approved.who : null;
        if (isBuy) {
          check('I2 a buy takes exactly amountIn USDT from the vault', uBefore - uAfter === amountIn, `${uBefore - uAfter} vs ${amountIn}`);
          check('I2 the approved creator gets exactly the fee, at most 1%', (payee ? paid[payee] === fee : true) && fee * 100n <= amountIn, `${fee}`);
          check('I5 the cost rises by what went into the pool', costAfter - costBefore === amountIn - fee);
          check('I1 at least minOut arrived', tAfter - tBefore >= minOut);
          m.spent[day] = spent + amountIn;
          if (m.budgetsOn) m.budget[id] = budget - amountIn;
          tally(`buy${rate ? ' with fee' : ''}`);
        } else {
          const net = uAfter - uBefore, cut = payee ? paid[payee] : 0n;
          check('I3 a sell takes exactly amountIn of the coin', tBefore - tAfter === amountIn);
          check('I3 the creator gets exactly floor(gross × rate / 10,000)', cut === ((net + cut) * BigInt(rate)) / 10_000n, `${cut} of ${net + cut} at ${rate}`);
          check('I1 at least minOut arrived, before the fee', net + cut >= minOut);
          tally(`sell${rate ? ' with fee' : ''}`);
        }
        for (const c of creators) if (c !== payee) check('I2 nobody else is paid', paid[c] === 0n);
        check('I4 the day\'s spending on-chain equals the model', (await read('spentOnDay', [day])) === (m.spent[day] ?? 0n));
        if (m.budgetsOn && isBuy) check('I4 the agent\'s budget on-chain equals the model', (await read('budgetLeft', [agentIdOf(id)])) === m.budget[id]);
      } else if (!priceRefusal) tally(`refused: ${got}`);
    }
    const after = await snapshot();
    check('I6 the agent key and strangers hold exactly what they held', Object.keys(before).every((k) => before[k] === after[k]));
  }
  console.log('\nactions:', JSON.stringify(counts));
  const trades = Object.entries(counts).filter(([k]) => /^(buy|sell|refused)/.test(k)).reduce((n, [, v]) => n + v, 0);
  const bought = (counts.buy ?? 0) + (counts['buy with fee'] ?? 0);
  check('at least 30% of all steps are buys the vault carried out', bought * 10 >= RUNS * 3, `${bought} of ${RUNS}`);
  check('price refusals stay rare: under 10% of the trades tried', (counts['refused: price moving'] ?? 0) * 10 < trades, `${counts['refused: price moving'] ?? 0} of ${trades}`);
} catch (e) {
  fail++;
  console.error('ERROR', e);
} finally {
  console.log(`\n${pass} checks passed, ${fail} failed`);
  stop();
  process.exit(fail ? 1 : 0);
}
