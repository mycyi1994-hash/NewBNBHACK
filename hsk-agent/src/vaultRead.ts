// Any Moa vault, read straight from HSK Chain and its public explorer, with no login: what it holds, the limits and
// stop-loss its owner set, and everything it has done (trades with the agent's note, stop-outs, deposits,
// withdrawals, setting changes). Nothing here is the app's own record: every value is a contract read or an event.
import { createPublicClient, decodeEventLog, formatUnits, getAddress, http, isAddress, parseAbi, type Address, type Hex } from 'viem';
import type { Asset } from './intent.ts';

export const RPC = 'https://mainnet.hsk.xyz';
export const EXPLORER = 'https://hsk.blockscout.com';
const API = `${EXPLORER}/api/v2`;
export const USDT: Address = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029';
export const TOKENS: { asset: Asset; symbol: string; address: Address; decimals: number }[] = [
  { asset: 'BTC', symbol: 'WBTC', address: '0x6119ca49a79f5825c8b345f8d7ac36b272565b14', decimals: 8 },
  { asset: 'ETH', symbol: 'WETH', address: '0xefd4bC9afD210517803f293ABABd701CaeeCdfd0', decimals: 18 },
  { asset: 'HSK', symbol: 'WHSK', address: '0xB210D2120d57b758EE163cFfb43e73728c471Cf1', decimals: 18 },
];
/** Moa's vault factories on HSK Chain mainnet, newest first (see contracts/MAINNET.md). Each vault is listed by its factory's VaultCreated event. */
export const FACTORIES: { address: Address; label: string }[] = [
  { address: '0xd6bF84aF1a81EB88EF2fD0c5B254b955E8256546', label: 'v2' },
  { address: '0x49807417fcebfb90e59933f0c44e4f1edf96444c', label: 'v1' },
];

const VAULT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function agent() view returns (address)',
  'function maxTradeUsdt() view returns (uint256)',
  'function maxDailyUsdt() view returns (uint256)',
  'function maxSlippageBps() view returns (uint16)',
  'function remainingToday() view returns (uint256)',
  'function paused() view returns (bool)',
  'function stopLossBps() view returns (uint16)',
  'function VERSION() view returns (uint16)',
  'function position(address) view returns (uint256, uint256, uint256, uint256)',
  'function balanceOf(address) view returns (uint256)',
  'event Traded(address indexed token, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 notionalUsdt, string note)',
  'event StoppedOut(address indexed token, address indexed caller, uint256 amountIn, uint256 amountOut, uint256 costUsdt)',
  'event LimitsSet(uint256 maxTradeUsdt, uint256 maxDailyUsdt, uint16 maxSlippageBps)',
  'event StopLossSet(uint16 stopLossBps)',
  'event Paused(bool paused)',
  // version 1 named the first field `withdrawer`; the types, and so the topic, are the same
  'event Withdrawn(address token, uint256 amount)',
  'event AgentSet(address agent)',
  'event CreatorPaid(address indexed creator, address indexed token, bool isBuy, uint256 feeUsdt, uint16 bps)',
  'event CreatorFeeSet(address indexed creator, uint16 bps)',
  'event VaultCreated(address indexed owner, address vault)',
]);

const client = createPublicClient({ transport: http(RPC) });
/** A limit this large is "no limit" (the contract has no separate off switch). */
const NO_LIMIT = 2n ** 200n;
const usd6 = (v: bigint) => Number(formatUnits(v, 6));

export const asVault = (s: string | null | undefined): Address | null => (s && isAddress(s.trim()) ? getAddress(s.trim()) : null);

export interface Holding { asset: Asset; symbol: string; qty: number; costUsdt?: number; valueUsdt?: number; stopUsdt?: number }
export interface VaultSnapshot {
  address: Address; version: number; owner: Address; agent?: Address;
  usdt: number; holdings: Holding[];
  /** undefined: the owner set no limit */
  maxTradeUsdt?: number; maxDailyUsdt?: number; remainingToday?: number; slippageBps?: number;
  /** 0: off; undefined: this version has no stop-loss */
  stopLossBps?: number; paused: boolean; at: number;
}

const tryRead = async <T>(p: Promise<T>): Promise<T | undefined> => { try { return await p; } catch { return undefined; } };

/** The vault now. Throws when the address is not a Moa vault (no owner to read). */
export async function readVault(address: Address): Promise<VaultSnapshot> {
  const read = <T>(functionName: string, args: unknown[] = []) => client.readContract({ address, abi: VAULT_ABI, functionName: functionName as 'owner', args: args as [] }) as unknown as Promise<T>;
  const owner = await read<Address>('owner');
  const [agent, maxTrade, maxDaily, slip, left, paused, stop, ver, usdt] = await Promise.all([
    tryRead(read<Address>('agent')), tryRead(read<bigint>('maxTradeUsdt')), tryRead(read<bigint>('maxDailyUsdt')), tryRead(read<number>('maxSlippageBps')),
    tryRead(read<bigint>('remainingToday')), tryRead(read<boolean>('paused')), tryRead(read<number>('stopLossBps')), tryRead(read<number>('VERSION')),
    client.readContract({ address: USDT, abi: VAULT_ABI, functionName: 'balanceOf', args: [address] }) as Promise<bigint>,
  ]);
  // Version 2 and later report each holding with its cost and its value at the pool price; version 1 only holds tokens.
  const holdings = (await Promise.all(TOKENS.map(async (tk): Promise<Holding | null> => {
    const pos = stop !== undefined ? await tryRead(client.readContract({ address, abi: VAULT_ABI, functionName: 'position', args: [tk.address] }) as Promise<readonly [bigint, bigint, bigint, bigint]>) : undefined;
    if (pos) {
      const [qty, cost, value, stopAt] = pos;
      return qty > 0n ? { asset: tk.asset, symbol: tk.symbol, qty: Number(formatUnits(qty, tk.decimals)), costUsdt: usd6(cost), valueUsdt: usd6(value), stopUsdt: stopAt > 0n ? usd6(stopAt) : undefined } : null;
    }
    const bal = (await client.readContract({ address: tk.address, abi: VAULT_ABI, functionName: 'balanceOf', args: [address] })) as bigint;
    return bal > 0n ? { asset: tk.asset, symbol: tk.symbol, qty: Number(formatUnits(bal, tk.decimals)) } : null;
  }))).filter((x): x is Holding => !!x);
  const lim = (v?: bigint) => (v === undefined || v >= NO_LIMIT ? undefined : usd6(v));
  return {
    address, owner, agent, version: ver ?? (stop !== undefined ? 2 : 1), usdt: usd6(usdt), holdings,
    maxTradeUsdt: lim(maxTrade), maxDailyUsdt: lim(maxDaily), remainingToday: maxDaily !== undefined && maxDaily < NO_LIMIT && left !== undefined ? usd6(left) : undefined,
    slippageBps: slip, stopLossBps: stop, paused: !!paused, at: Date.now(),
  };
}

/* ---------- history: the vault's own events, plus USDT moving between it and its owner ---------- */

export type VaultEvent =
  | { k: 'trade'; at: number; tx: string; symbol: string; side: 'buy' | 'sell'; usdt: number; qty: number; note: string; agent?: { name: string; why: string; auto: boolean } }
  | { k: 'stopOut'; at: number; tx: string; symbol: string; qty: number; usdt: number }
  | { k: 'limits'; at: number; tx: string; maxTradeUsdt?: number; maxDailyUsdt?: number; slippageBps: number }
  | { k: 'stopSet'; at: number; tx: string; bps: number }
  | { k: 'paused'; at: number; tx: string; on: boolean }
  | { k: 'deposit' | 'withdraw'; at: number; tx: string; symbol: string; amount: number }
  | { k: 'agentSet'; at: number; tx: string; agent: string }
  | { k: 'creatorPaid'; at: number; tx: string; usdt: number; creator: string };

interface RawLog { block_number: number; block_timestamp: string; transaction_hash: string; topics: (string | null)[]; data: string }
interface RawTransfer { timestamp: string; transaction_hash: string; from: { hash: string }; to: { hash: string }; token: { symbol: string; address_hash?: string; address?: string }; total: { value: string; decimals: string } }

async function pages<T>(url: string, max = 4): Promise<T[]> {
  const out: T[] = [];
  let next: Record<string, string> | null = null;
  for (let i = 0; i < max; i++) {
    const q: string = next ? `${url.includes('?') ? '&' : '?'}${new URLSearchParams(next).toString()}` : '';
    const r = await fetch(url + q);
    if (!r.ok) throw new Error(`explorer HTTP ${r.status}`);
    const j = (await r.json()) as { items: T[]; next_page_params: Record<string, string> | null };
    out.push(...j.items);
    next = j.next_page_params;
    if (!next) break;
  }
  return out;
}

const tokenOf = (a: string) => TOKENS.find((x) => x.address.toLowerCase() === a.toLowerCase());

/** "Moa agent BTC 스냅: signal on, standing order from the owner" → who decided and why. Anything else is a chat or manual order. */
export function agentOfNote(note: string): { name: string; why: string; auto: boolean } | undefined {
  const m = /^Moa agent (.+?): (.+?), (standing order from the owner|approved by the owner)/.exec(note);
  return m ? { name: m[1], why: m[2], auto: m[3].startsWith('standing') } : undefined;
}

export async function vaultHistory(address: Address, owner: Address): Promise<VaultEvent[]> {
  const [logs, transfers] = await Promise.all([
    pages<RawLog>(`${API}/addresses/${address}/logs`),
    pages<RawTransfer>(`${API}/addresses/${address}/token-transfers?type=ERC-20`).catch(() => [] as RawTransfer[]),
  ]);
  const out: VaultEvent[] = [];
  for (const l of logs) {
    const at = Date.parse(l.block_timestamp), tx = l.transaction_hash;
    let ev: { eventName: string; args: Record<string, unknown> };
    try { ev = decodeEventLog({ abi: VAULT_ABI, topics: l.topics.filter(Boolean) as [Hex, ...Hex[]], data: l.data as Hex }) as unknown as typeof ev; } catch { continue; }
    const a = ev.args;
    switch (ev.eventName) {
      case 'Traded': {
        const tk = tokenOf(a.token as string);
        if (!tk) break;
        const buy = a.isBuy as boolean;
        const usdt = usd6(buy ? (a.amountIn as bigint) : (a.amountOut as bigint));
        const qty = Number(formatUnits(buy ? (a.amountOut as bigint) : (a.amountIn as bigint), tk.decimals));
        out.push({ k: 'trade', at, tx, symbol: tk.symbol, side: buy ? 'buy' : 'sell', usdt, qty, note: a.note as string, agent: agentOfNote(a.note as string) });
        break;
      }
      case 'StoppedOut': {
        const tk = tokenOf(a.token as string);
        if (tk) out.push({ k: 'stopOut', at, tx, symbol: tk.symbol, qty: Number(formatUnits(a.amountIn as bigint, tk.decimals)), usdt: usd6(a.amountOut as bigint) });
        break;
      }
      case 'LimitsSet': {
        const lim = (v: bigint) => (v >= NO_LIMIT ? undefined : usd6(v));
        out.push({ k: 'limits', at, tx, maxTradeUsdt: lim(a.maxTradeUsdt as bigint), maxDailyUsdt: lim(a.maxDailyUsdt as bigint), slippageBps: Number(a.maxSlippageBps) });
        break;
      }
      case 'StopLossSet': out.push({ k: 'stopSet', at, tx, bps: Number(a.stopLossBps) }); break;
      case 'Paused': out.push({ k: 'paused', at, tx, on: a.paused as boolean }); break;
      case 'AgentSet': out.push({ k: 'agentSet', at, tx, agent: a.agent as string }); break;
      case 'CreatorPaid': out.push({ k: 'creatorPaid', at, tx, usdt: usd6(a.feeUsdt as bigint), creator: a.creator as string }); break;
      default: break; // Withdrawn is taken from the token transfers below, which name the token in every version
    }
  }
  // Money between the vault and its owner: deposits and withdrawals. Transfers to and from the pool are the trades above.
  for (const x of transfers) {
    const from = x.from.hash.toLowerCase(), to = x.to.hash.toLowerCase(), me = address.toLowerCase(), who = owner.toLowerCase();
    const k = from === who && to === me ? 'deposit' : from === me && to === who ? 'withdraw' : undefined;
    if (!k) continue;
    out.push({ k, at: Date.parse(x.timestamp), tx: x.transaction_hash, symbol: x.token.symbol, amount: Number(formatUnits(BigInt(x.total.value), Number(x.total.decimals))) });
  }
  return out.sort((p, q) => q.at - p.at);
}

export interface VaultListing { vault: Address; owner: Address; at: number; factory: string; tx: string }
/** Every vault Moa's factories have made, newest first. */
export async function listVaults(): Promise<VaultListing[]> {
  const lists = await Promise.all(FACTORIES.map(async (f) => {
    const logs = await pages<RawLog>(`${API}/addresses/${f.address}/logs`);
    return logs.flatMap((l) => {
      try {
        const ev = decodeEventLog({ abi: VAULT_ABI, topics: l.topics.filter(Boolean) as [Hex, ...Hex[]], data: l.data as Hex }) as unknown as { eventName: string; args: { owner: Address; vault: Address } };
        return ev.eventName === 'VaultCreated' ? [{ vault: getAddress(ev.args.vault), owner: getAddress(ev.args.owner), at: Date.parse(l.block_timestamp), factory: f.label, tx: l.transaction_hash }] : [];
      } catch { return []; }
    });
  }));
  return lists.flat().sort((a, b) => b.at - a.at);
}

/** The public, read-only address of a vault in this app. */
export const vaultLink = (v: string) => `${window.location.origin}${window.location.pathname}?vault=${v}`;
