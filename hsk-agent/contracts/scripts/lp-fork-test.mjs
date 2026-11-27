// Liquidity in blocks, end to end on a local fork of HSK Chain mainnet, through HSKSwap's real position manager and
// WBTC/USDT pool: approve exact amounts, mint a 20-step plan in one transaction, read the positions back, push the
// price into the USDT steps with a swap and see fees appear, collect them, then take everything out.
// No real funds are used. Usage: node --experimental-strip-types scripts/lp-fork-test.mjs   (from hsk-agent/contracts)
import { spawn } from 'node:child_process';
import { createPublicClient, createTestClient, createWalletClient, http, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NPM, USDT, approveCall, binsOf, collectCall, defaultPlan, mintCall, positionsOf, removeCall } from '../../src/lp.ts';

const RPC = 'http://127.0.0.1:8546';
const ROUTER = '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3';
const WBTC = '0x6119ca49a79f5825c8b345f8d7ac36b272565b14';
const POOL = { BTC: '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a', HSK: '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc' };
// Hardhat's well-known local test keys (public, never funded on any real chain)
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CAROL_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const chain = { id: 177, name: 'HSK fork', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)']);
const slot0 = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)']);
const router = parseAbi(['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)']);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const node = spawn('npx', ['hardhat', 'node', '--port', '8546'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
let nodeLog = '';
node.stdout.on('data', (d) => (nodeLog += d));
node.stderr.on('data', (d) => (nodeLog += d));
const stop = () => { try { if (process.platform === 'win32') node.kill('SIGTERM'); else process.kill(-node.pid, 'SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);

try {
  for (let i = 0; i < 120 && !/Started HTTP/.test(nodeLog); i++) await new Promise((r) => setTimeout(r, 500));
  if (!/Started HTTP/.test(nodeLog)) throw new Error('fork node did not start:\n' + nodeLog.slice(-2000));
  const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 180_000 }) });
  const test = createTestClient({ chain, mode: 'hardhat', transport: http(RPC, { timeout: 180_000 }) });
  await test.mine({ blocks: 1 });
  const owner = privateKeyToAccount(OWNER_KEY), carol = privateKeyToAccount(CAROL_KEY);
  const ownerW = createWalletClient({ account: owner, chain, transport: http(RPC, { timeout: 180_000 }) }), carolW = createWalletClient({ account: carol, chain, transport: http(RPC, { timeout: 180_000 }) });
  // gas is set, not estimated: estimating on a fork reads every new storage slot from mainnet twice
  const send = async (w, to, data) => { const h = await w.sendTransaction({ to, data, gas: 12_000_000n }); const r = await pub.waitForTransactionReceipt({ hash: h }); return r; };
  const bal = (t, who) => pub.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [who] });
  // The same reading function the app uses, through this chain.
  const call = async (to, data, from) => (await pub.call({ to, data, account: from })).data ?? '0x';

  // fund: 300 USDT and 0.003 WBTC to the owner, 0.02 WBTC to carol (taken from the pools' balances; fork only)
  for (const [from, token, to, amount] of [[POOL.HSK, USDT, owner.address, 300_000_000n], [POOL.BTC, WBTC, owner.address, 300_000n], [POOL.BTC, WBTC, carol.address, 2_000_000n]]) {
    await test.impersonateAccount({ address: from });
    await test.setBalance({ address: from, value: 10n ** 21n });
    await send(createWalletClient({ account: from, chain, transport: http(RPC, { timeout: 180_000 }) }), token, encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [to, amount] }));
  }
  check('owner holds 300 USDT and 0.003 WBTC', (await bal(USDT, owner.address)) === 300_000_000n && (await bal(WBTC, owner.address)) === 300_000n);

  const [sqrtX96, tick] = await pub.readContract({ address: POOL.BTC, abi: slot0, functionName: 'slot0' });
  const sqrt = () => pub.readContract({ address: POOL.BTC, abi: slot0, functionName: 'slot0' }).then(([s]) => Number(s) / 2 ** 96);
  const plan = { ...defaultPlan('BTC'), usdt: 200, coin: 0.002, shape: 'curve', step: 60, perSide: 10 };
  const bins = binsOf(plan, tick);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const m = mintCall(WBTC, bins, 8, owner.address, deadline);
  check('the plan is 20 steps, 200 USDT under and 0.002 WBTC over the price', m.count === 20 && m.usdtRaw === 200_000_000n && m.coinRaw === 200_000n, `tick ${tick}`);

  // without approval the position manager refuses
  let refused = false;
  try { await pub.call({ to: NPM, data: m.data, account: owner.address }); } catch { refused = true; }
  check('without approval the mint is refused', refused);

  await send(ownerW, USDT, approveCall(m.usdtRaw));
  await send(ownerW, WBTC, approveCall(m.coinRaw));
  check('approvals are exactly the plan', (await pub.readContract({ address: USDT, abi: erc20, functionName: 'allowance', args: [owner.address, NPM] })) === 200_000_000n
    && (await pub.readContract({ address: WBTC, abi: erc20, functionName: 'allowance', args: [owner.address, NPM] })) === 200_000n);
  const r = await send(ownerW, NPM, m.data);
  check('one transaction mints all 20 steps', r.status === 'success', `gas ${r.gasUsed}`);
  const usdtLeft = await bal(USDT, owner.address), wbtcLeft = await bal(WBTC, owner.address);
  check('the wallet paid what the plan said, no more', 300_000_000n - usdtLeft <= 200_000_000n && 300_000_000n - usdtLeft >= 199_000_000n && 300_000n - wbtcLeft <= 200_000n && 300_000n - wbtcLeft >= 198_000n,
    `${Number(300_000_000n - usdtLeft) / 1e6} USDT, ${Number(300_000n - wbtcLeft) / 1e8} WBTC`);
  check('no allowance left over', (await pub.readContract({ address: USDT, abi: erc20, functionName: 'allowance', args: [owner.address, NPM] })) <= 1_000_000n);

  let ps = await positionsOf(call, owner.address, WBTC, Number(sqrtX96) / 2 ** 96);
  check('20 positions read back, on the planned ticks', ps.length === 20 && ps.every((p, i) => p.lower === bins[i].lower && p.upper === bins[i].upper));
  const held1 = ps.reduce((s, p) => s + p.raw1, 0n), held0 = ps.reduce((s, p) => s + p.raw0, 0n);
  check('they hold the USDT under the price and the WBTC over it', held1 > 199_000_000n && held0 > 198_000n && ps.filter((p) => p.upper <= tick).every((p) => p.raw0 === 0n),
    `${Number(held1) / 1e6} USDT, ${Number(held0) / 1e8} WBTC`);
  check('no fees yet', ps.every((p) => p.fee0 === 0n && p.fee1 === 0n));

  // someone sells 0.02 WBTC: the price comes down into the USDT steps, which buy WBTC and earn the fee
  await send(carolW, WBTC, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [ROUTER, 2_000_000n] }));
  await send(carolW, ROUTER, encodeFunctionData({ abi: router, functionName: 'exactInputSingle', args: [{ tokenIn: WBTC, tokenOut: USDT, fee: 3000, recipient: carol.address, amountIn: 2_000_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }));
  const [, tickAfter] = await pub.readContract({ address: POOL.BTC, abi: slot0, functionName: 'slot0' });
  ps = await positionsOf(call, owner.address, WBTC, await sqrt());
  const crossed = ps.filter((p) => p.lower > tickAfter && p.upper <= tick);   // wholly passed; the step the price is now in holds both
  check('the sale moved the price down through some USDT steps', tickAfter < bins[9].lower, `tick ${tick} -> ${tickAfter}`);
  check('the steps it crossed now hold WBTC instead of USDT', crossed.length > 0 && crossed.every((p) => p.raw0 > 0n && p.raw1 === 0n), `${crossed.length} steps`);
  const fee0 = ps.reduce((s, p) => s + p.fee0, 0n);
  check('those steps earned fees in WBTC', fee0 > 0n, `${Number(fee0) / 1e8} WBTC`);

  const before0 = await bal(WBTC, owner.address);
  await send(ownerW, NPM, collectCall(ps.filter((p) => p.fee0 > 0n || p.fee1 > 0n), owner.address));
  check('collect pays the fees to the wallet', (await bal(WBTC, owner.address)) - before0 === fee0);

  ps = await positionsOf(call, owner.address, WBTC, await sqrt());
  // someone else cannot take them out, not even to their own wallet
  let carolRefused = false;
  try { await pub.call({ to: NPM, data: removeCall(ps, carol.address, deadline), account: carol.address }); } catch { carolRefused = true; }
  check('a stranger cannot take the positions out', carolRefused);
  const value0 = ps.reduce((s, p) => s + p.raw0, 0n), value1 = ps.reduce((s, p) => s + p.raw1, 0n);
  const w0 = await bal(WBTC, owner.address), w1 = await bal(USDT, owner.address);
  await send(ownerW, NPM, removeCall(ps, owner.address, deadline));
  const got0 = (await bal(WBTC, owner.address)) - w0, got1 = (await bal(USDT, owner.address)) - w1;
  check('removing pays back what the positions held', got0 >= (value0 * 99n) / 100n && got1 >= (value1 * 99n) / 100n, `${Number(got0) / 1e8} WBTC, ${Number(got1) / 1e6} USDT`);
  ps = await positionsOf(call, owner.address, WBTC, await sqrt());
  check('nothing is left in the pool', ps.length === 0);

} catch (e) {
  fail++;
  console.error('ERROR', e);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  stop();
  process.exit(fail ? 1 : 0);
}
