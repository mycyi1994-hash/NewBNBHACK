// Liquidity on HSKSwap in blocks. A plan splits a USDT amount over price steps under the price (each step is a
// Uniswap V3 position that holds only USDT and buys the coin as the price comes down into it) and a coin amount over
// steps above (each holds only the coin and sells it for USDT as the price goes up). The step containing the price is
// left empty, so every position starts with one token only. The shape says how the amounts are spread.
// All positions go through HSKSwap's own position manager in one transaction, from the user's wallet.
import { encodeFunctionData, parseAbi, decodeFunctionResult, type Hex } from 'viem';
import type { Asset } from './intent.ts';
import type { PoolState } from './depth.ts';

/** HSKSwap's NonfungiblePositionManager: its factory() is the factory of HSKSwap's router (read 27 Nov 2026). */
export const NPM = '0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5';
export const USDT = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029';
export const FEE = 3000;
export const SPACING = 60;
const MAX128 = 2n ** 128n - 1n;

export type Shape = 'spot' | 'curve' | 'bidask' | 'custom';
export interface LpPlan {
  asset: Asset;
  /** USDT spread over the steps under the price, and the coin over the steps above it (whole units). */
  usdt: number; coin: number;
  shape: Shape;
  /** One step's width in ticks (a multiple of 60, the pool's tick spacing; 60 ticks is about 0.6%). */
  step: number;
  /** Steps on each side of the price. */
  perSide: number;
  /** Shape 'custom': a weight 0–10 per step, lowest price first, `2 × perSide` long. */
  weights?: number[];
}
export const defaultPlan = (asset: Asset): LpPlan => ({ asset, usdt: 0, coin: 0, shape: 'curve', step: 60, perSide: 10 });

export interface Bin { lower: number; upper: number; side: 'usdt' | 'coin'; /** distance from the price, 1 = next to it */ d: number; weight: number; amount: number }

/** The weight of a step `d` away from the price (1 = nearest) for a shape. */
export function shapeWeight(shape: Exclude<Shape, 'custom'>, d: number, n: number): number {
  if (shape === 'spot') return 1;
  if (shape === 'curve') return Math.exp(-((d - 1) ** 2) / (2 * Math.max(1, n / 2.5) ** 2));
  return d / n;   // bid-ask: heaviest at the far ends
}

/** The steps of a plan around a tick, lowest price first, with the amount each one gets. */
export function binsOf(plan: LpPlan, tick: number): Bin[] {
  const B = Math.max(SPACING, Math.round(plan.step / SPACING) * SPACING), n = plan.perSide;
  const base = Math.floor(tick / B) * B;   // lower edge of the step the price is in (left empty)
  const out: Bin[] = [];
  for (let d = n; d >= 1; d--) out.push({ lower: base - d * B, upper: base - (d - 1) * B, side: 'usdt', d, weight: 0, amount: 0 });
  for (let d = 1; d <= n; d++) out.push({ lower: base + d * B, upper: base + (d + 1) * B, side: 'coin', d, weight: 0, amount: 0 });
  out.forEach((b, i) => { b.weight = plan.shape === 'custom' ? Math.max(0, plan.weights?.[i] ?? 0) : shapeWeight(plan.shape, b.d, n); });
  for (const side of ['usdt', 'coin'] as const) {
    const total = side === 'usdt' ? plan.usdt : plan.coin, mine = out.filter((b) => b.side === side), w = mine.reduce((s, b) => s + b.weight, 0);
    for (const b of mine) b.amount = total > 0 && w > 0 ? (total * b.weight) / w : 0;
  }
  return out;
}

/** The price (USDT per coin) at a tick, for a coin with `decimals` against USDT's 6. */
export const priceAt = (tick: number, decimals: number) => Math.pow(1.0001, tick) * 10 ** (decimals - 6);
/** The tick nearest a price. */
export const tickAt = (price: number, decimals: number) => Math.round(Math.log(price / 10 ** (decimals - 6)) / Math.log(1.0001));

/** Liquidity of a one-sided position: USDT (token1) under the price, the coin (token0) above it. Raw token units. */
export function liquidityOf(b: Bin, raw: bigint): number {
  const sa = Math.pow(1.0001, b.lower / 2), sb = Math.pow(1.0001, b.upper / 2), x = Number(raw);
  return b.side === 'usdt' ? x / (sb - sa) : (x * sa * sb) / (sb - sa);
}

/** The pool with the plan's positions added, to measure what they change. */
export function withPlan(pool: PoolState, bins: Bin[], decimals: number): PoolState {
  const ticks = new Map<number, number>();
  for (const t of pool.ticks) ticks.set(t.tick, (ticks.get(t.tick) ?? 0) + t.net);
  for (const b of bins) {
    if (!(b.amount > 0)) continue;
    const L = liquidityOf(b, rawOf(b.amount, b.side === 'usdt' ? 6 : decimals));
    ticks.set(b.lower, (ticks.get(b.lower) ?? 0) + L);
    ticks.set(b.upper, (ticks.get(b.upper) ?? 0) - L);
  }
  return { ...pool, ticks: [...ticks].map(([tick, net]) => ({ tick, net })) };
}

export const rawOf = (amount: number, decimals: number): bigint => {
  if (!(amount > 0)) return 0n;
  const [w, f = ''] = amount.toFixed(Math.min(decimals, 12)).split('.');
  return BigInt(w + f.padEnd(decimals, '0').slice(0, decimals));
};

/* ---------- transactions ---------- */

const NPM_ABI = parseAbi([
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)', 'function balanceOf(address owner) view returns (uint256)']);

/** One mint per step that gets something; all of them in one multicall. Minimums are 99% (an empty step is skipped). */
export function mintCall(coinToken: string, bins: Bin[], decimals: number, recipient: string, deadline: number): { data: Hex; count: number; usdtRaw: bigint; coinRaw: bigint } {
  const calls: Hex[] = [];
  let usdtRaw = 0n, coinRaw = 0n;
  // Each step rounds down to whole token units; what that leaves over goes to the side's largest step, so the wallet
  // is asked for exactly the amount the plan shows.
  const raws = bins.map((b) => rawOf(b.amount, b.side === 'usdt' ? 6 : decimals));
  for (const side of ['usdt', 'coin'] as const) {
    const idx = bins.map((b, i) => (b.side === side ? i : -1)).filter((i) => i >= 0);
    const want = rawOf(idx.reduce((t, i) => t + bins[i].amount, 0), side === 'usdt' ? 6 : decimals), got = idx.reduce((t, i) => t + raws[i], 0n);
    const top = idx.reduce((m, i) => (m < 0 || raws[i] > raws[m] ? i : m), -1);
    if (top >= 0 && raws[top] > 0n && want > got) raws[top] += want - got;
  }
  for (const [k, b] of bins.entries()) {
    const raw = raws[k];
    if (raw <= 0n) continue;
    const a0 = b.side === 'coin' ? raw : 0n, a1 = b.side === 'usdt' ? raw : 0n;
    if (b.side === 'usdt') usdtRaw += raw; else coinRaw += raw;
    calls.push(encodeFunctionData({ abi: NPM_ABI, functionName: 'mint', args: [{
      token0: coinToken as Hex, token1: USDT as Hex, fee: FEE, tickLower: b.lower, tickUpper: b.upper,
      amount0Desired: a0, amount1Desired: a1, amount0Min: (a0 * 99n) / 100n, amount1Min: (a1 * 99n) / 100n,
      recipient: recipient as Hex, deadline: BigInt(deadline),
    }] }));
  }
  return { data: encodeFunctionData({ abi: NPM_ABI, functionName: 'multicall', args: [calls] }), count: calls.length, usdtRaw, coinRaw };
}

export const approveCall = (amount: bigint): Hex => encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [NPM as Hex, amount] });

/** Take positions out: all their liquidity and everything owed, back to the owner's wallet. Minimums are 97% of what they hold now. */
export function removeCall(ps: Position[], owner: string, deadline: number): Hex {
  const calls: Hex[] = [];
  for (const p of ps) {
    if (p.liquidity > 0n) calls.push(encodeFunctionData({ abi: NPM_ABI, functionName: 'decreaseLiquidity', args: [{ tokenId: p.id, liquidity: p.liquidity, amount0Min: (p.raw0 * 97n) / 100n, amount1Min: (p.raw1 * 97n) / 100n, deadline: BigInt(deadline) }] }));
    calls.push(encodeFunctionData({ abi: NPM_ABI, functionName: 'collect', args: [{ tokenId: p.id, recipient: owner as Hex, amount0Max: MAX128, amount1Max: MAX128 }] }));
  }
  return encodeFunctionData({ abi: NPM_ABI, functionName: 'multicall', args: [calls] });
}
/** Only the fees earned, positions stay. */
export const collectCall = (ps: Position[], owner: string): Hex =>
  encodeFunctionData({ abi: NPM_ABI, functionName: 'multicall', args: [ps.map((p) => encodeFunctionData({ abi: NPM_ABI, functionName: 'collect', args: [{ tokenId: p.id, recipient: owner as Hex, amount0Max: MAX128, amount1Max: MAX128 }] }))] });

/* ---------- reading back ---------- */

/** An eth_call: through the user's wallet when there is one (so a test chain answers as the wallet sees it). */
export type Call = (to: string, data: Hex, from?: string) => Promise<Hex>;

export interface Position { id: bigint; lower: number; upper: number; liquidity: bigint; raw0: bigint; raw1: bigint; fee0: bigint; fee1: bigint }

/** The token amounts a position holds at a price (sqrt price as a float). */
export function amountsOf(lower: number, upper: number, liquidity: bigint, sqrtPrice: number): [bigint, bigint] {
  const L = Number(liquidity), sa = Math.pow(1.0001, lower / 2), sb = Math.pow(1.0001, upper / 2), s = Math.min(Math.max(sqrtPrice, sa), sb);
  const a0 = s < sb ? L * (sb - s) / (s * sb) : 0, a1 = s > sa ? L * (s - sa) : 0;
  return [BigInt(Math.floor(a0)), BigInt(Math.floor(a1))];
}

export async function balanceOf(call: Call, token: string, who: string): Promise<bigint> {
  const r = await call(token, encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [who as Hex] }));
  return decodeFunctionResult({ abi: ERC20, functionName: 'balanceOf', data: r }) as bigint;
}
export async function allowanceOf(call: Call, token: string, who: string): Promise<bigint> {
  const r = await call(token, encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [who as Hex, NPM as Hex] }));
  return decodeFunctionResult({ abi: ERC20, functionName: 'allowance', data: r }) as bigint;
}

/** The owner's positions in this coin's 0.3% pool, with what each holds now and the fees it could collect. */
export async function positionsOf(call: Call, owner: string, coinToken: string, sqrtPrice: number): Promise<Position[]> {
  const read = async <F extends 'balanceOf' | 'tokenOfOwnerByIndex' | 'positions' | 'collect'>(fn: F, args: unknown[], from?: string) =>
    decodeFunctionResult({ abi: NPM_ABI, functionName: fn, data: await call(NPM, encodeFunctionData({ abi: NPM_ABI, functionName: fn, args } as never), from) } as never) as unknown;
  const n = Number(await read('balanceOf', [owner]) as bigint);
  const ids = await Promise.all(Array.from({ length: Math.min(n, 200) }, (_, i) => read('tokenOfOwnerByIndex', [owner, BigInt(i)]) as Promise<bigint>));
  const out: Position[] = [];
  await Promise.all(ids.map(async (id) => {
    const p = await read('positions', [id]) as readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint];
    if (p[2].toLowerCase() !== coinToken.toLowerCase() || p[3].toLowerCase() !== USDT || p[4] !== FEE) return;
    if (p[7] === 0n && p[10] === 0n && p[11] === 0n) return;   // emptied
    const [raw0, raw1] = amountsOf(p[5], p[6], p[7], sqrtPrice);
    // What collect would pay now: the fees earned (it settles them first), plus anything owed.
    const fees = await read('collect', [{ tokenId: id, recipient: owner, amount0Max: MAX128, amount1Max: MAX128 }], owner).catch(() => [p[10], p[11]]) as readonly [bigint, bigint];
    out.push({ id, lower: p[5], upper: p[6], liquidity: p[7], raw0, raw1, fee0: fees[0], fee1: fees[1] });
  }));
  return out.sort((a, b) => a.lower - b.lower);
}
