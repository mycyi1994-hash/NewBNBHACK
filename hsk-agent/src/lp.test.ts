import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, parseAbi } from 'viem';
import { amountsOf, binsOf, defaultPlan, liquidityOf, mintCall, priceAt, rawOf, tickAt, withPlan, USDT, FEE, type LpPlan } from './lp.ts';
import { poolDepth, type PoolState } from './depth.ts';

const WBTC = '0x6119ca49a79f5825c8b345f8d7ac36b272565b14';
const TICK = 64049;   // the WBTC/USDT pool on 27 Nov 2026

test('steps sit on the pool spacing, the one holding the price is left empty, USDT under and the coin over', () => {
  const plan: LpPlan = { ...defaultPlan('BTC'), usdt: 500, coin: 0.002, step: 60, perSide: 10 };
  const bins = binsOf(plan, TICK);
  assert.equal(bins.length, 20);
  for (const b of bins) { assert.equal(b.lower % 60, 0); assert.equal(b.upper - b.lower, 60); }
  const under = bins.filter((b) => b.side === 'usdt'), over = bins.filter((b) => b.side === 'coin');
  assert.ok(under.every((b) => b.upper <= TICK) && over.every((b) => b.lower > TICK));
  assert.equal(under[under.length - 1].upper, 64020);   // the step 64020–64080 holds the price and stays empty
  assert.equal(over[0].lower, 64080);
  // lowest price first, contiguous on each side
  for (let i = 1; i < 10; i++) assert.equal(under[i].lower, under[i - 1].upper);
  assert.ok(Math.abs(under.reduce((s, b) => s + b.amount, 0) - 500) < 1e-9);
  assert.ok(Math.abs(over.reduce((s, b) => s + b.amount, 0) - 0.002) < 1e-12);
});

test('shapes: spot is even, curve is heaviest next to the price, bid-ask at the far ends, custom follows the weights', () => {
  const at = (plan: Partial<LpPlan>) => binsOf({ ...defaultPlan('BTC'), usdt: 100, ...plan }, TICK).filter((b) => b.side === 'usdt');
  const spot = at({ shape: 'spot' });
  assert.ok(spot.every((b) => Math.abs(b.amount - 10) < 1e-9));
  const curve = at({ shape: 'curve' });
  assert.ok(curve[9].amount > curve[5].amount && curve[5].amount > curve[0].amount, 'nearest the price most');
  const ba = at({ shape: 'bidask' });
  assert.ok(ba[0].amount > ba[5].amount && ba[5].amount > ba[9].amount, 'furthest from the price most');
  const weights = Array(20).fill(0); weights[9] = 3; weights[8] = 1;   // the two USDT steps nearest the price
  const custom = at({ shape: 'custom', weights });
  assert.equal(custom[9].amount, 75); assert.equal(custom[8].amount, 25);
  assert.ok(custom.slice(0, 8).every((b) => b.amount === 0));
});

test('a wider step: multiples of the spacing, rounded', () => {
  const bins = binsOf({ ...defaultPlan('BTC'), usdt: 10, step: 130 }, TICK);
  assert.ok(bins.every((b) => b.upper - b.lower === 120 && b.lower % 120 === 0));
});

test('prices and ticks: WBTC has 8 decimals against USDT 6', () => {
  const p = priceAt(TICK, 8);
  assert.ok(p > 60000 && p < 61000, String(p));
  assert.equal(tickAt(p, 8), TICK);
  assert.equal(rawOf(1.5, 6), 1_500_000n);
  assert.equal(rawOf(0.002, 8), 200_000n);
  assert.equal(rawOf(0, 6), 0n);
});

test('the multicall: one mint per funded step, exact amounts, 99% minimums, the right side of the pair', () => {
  const plan: LpPlan = { ...defaultPlan('BTC'), usdt: 100, coin: 0.001, shape: 'spot', perSide: 2 };
  const bins = binsOf(plan, TICK);
  const m = mintCall(WBTC, bins, 8, '0x9E5fE1A82C358e0BcC71bcbEC86084616891214c', 1_800_000_000);
  assert.equal(m.count, 4);
  assert.equal(m.usdtRaw, 100_000_000n);
  assert.equal(m.coinRaw, 100_000n);
  // amounts that do not split evenly still add up to exactly what was asked
  const odd = mintCall(WBTC, binsOf({ ...defaultPlan('BTC'), usdt: 200, coin: 0.002, shape: 'curve' }, TICK), 8, '0x9E5fE1A82C358e0BcC71bcbEC86084616891214c', 1);
  assert.equal(odd.usdtRaw, 200_000_000n);
  assert.equal(odd.coinRaw, 200_000n);
  const abi = parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)', 'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)']);
  const outer = decodeFunctionData({ abi, data: m.data });
  assert.equal(outer.functionName, 'multicall');
  const mints = (outer.args[0] as `0x${string}`[]).map((d) => (decodeFunctionData({ abi, data: d }).args[0]) as { token0: string; token1: string; fee: number; tickLower: number; tickUpper: number; amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint });
  for (const x of mints) {
    assert.equal(x.token0.toLowerCase(), WBTC); assert.equal(x.token1.toLowerCase(), USDT); assert.equal(x.fee, FEE);
    assert.ok((x.amount0Desired === 0n) !== (x.amount1Desired === 0n), 'one token per step');
    assert.equal(x.amount0Min, (x.amount0Desired * 99n) / 100n); assert.equal(x.amount1Min, (x.amount1Desired * 99n) / 100n);
  }
  assert.ok(mints.filter((x) => x.amount1Desired > 0n).every((x) => x.tickUpper <= TICK));
  // an empty plan sends nothing
  assert.equal(mintCall(WBTC, binsOf(defaultPlan('BTC'), TICK), 8, '0x9E5fE1A82C358e0BcC71bcbEC86084616891214c', 1).count, 0);
});

test('a position holds what was put in, and adding the plan to the pool deepens it where the steps are', () => {
  const b = binsOf({ ...defaultPlan('BTC'), usdt: 1000, shape: 'spot', perSide: 1 }, TICK)[0];
  const L = BigInt(Math.floor(liquidityOf(b, rawOf(b.amount, 6))));
  const [a0, a1] = amountsOf(b.lower, b.upper, L, Math.pow(1.0001, TICK / 2));
  assert.equal(a0, 0n);
  assert.ok(Math.abs(Number(a1) - 1000e6) < 1000, String(a1));   // the USDT, while the price is above the step
  // a flat pool like the real one, with one step of 1,000 USDT just under the price
  const pool: PoolState = { sqrtPrice: Math.pow(1.0001, TICK / 2), tick: TICK, liquidity: 1823343427, ticks: [] };
  const plan = binsOf({ ...defaultPlan('BTC'), usdt: 1000, shape: 'spot', perSide: 3 }, TICK);
  const before = poolDepth(pool).bands.find((x) => x.pct === -2)!.usdt, after = poolDepth(withPlan(pool, plan, 8)).bands.find((x) => x.pct === -2)!.usdt;
  assert.ok(after > before + 500, `${before} -> ${after}`);
  assert.equal(poolDepth(withPlan(pool, plan, 8)).bands.find((x) => x.pct === 1)!.usdt, poolDepth(pool).bands.find((x) => x.pct === 1)!.usdt, 'nothing above the price');
});
