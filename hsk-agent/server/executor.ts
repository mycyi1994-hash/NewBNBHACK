// Sends a trade to a user's MoaVault with the agent key. Every limit is enforced again by the contract.
// Each signed-in wallet has its own vault, made by the MoaVaultFactory; the server looks it up per request.
// Configuration comes from the server environment; with no factory or no agent key, execution is refused.
import { BaseError, ContractFunctionRevertedError, keccak256, stringToHex, zeroHash, createPublicClient, createWalletClient, decodeEventLog, http, parseUnits, formatUnits, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import vaultArtifact from '../contracts/out/MoaVault.json' with { type: 'json' };
import factoryArtifact from '../contracts/out/MoaVaultFactory.json' with { type: 'json' };

export type Asset = 'HSK' | 'ETH' | 'BTC';
export const TOKENS: Record<Asset, { address: Address; decimals: number; symbol: string }> = {
  HSK: { address: '0xB210D2120d57b758EE163cFfb43e73728c471Cf1', decimals: 18, symbol: 'WHSK' },
  ETH: { address: '0xefd4bC9afD210517803f293ABABd701CaeeCdfd0', decimals: 18, symbol: 'WETH' },
  BTC: { address: '0x6119ca49a79f5825c8b345f8d7ac36b272565b14', decimals: 8, symbol: 'WBTC' },
};
export const USDT: Address = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029';
const abi = vaultArtifact.abi;
const factoryAbi = factoryArtifact.abi;
const balanceAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;

export interface ExecConfig {
  rpcUrl: string;
  chainId: number;
  /** makes and lists the vaults; without it the app is a demo */
  factory?: Address;
  /** earlier factories whose vaults are still in use: a wallet that has one keeps it (those vaults pay no creator fee) */
  legacyFactories?: Address[];
  /** the vault this request is about (the signed-in wallet's), set per request by forOwner() */
  vault?: Address;
  owner?: Address;
  /** how many vaults this server will pay to create per UTC day */
  maxVaultsPerDay: number;
  agentKey?: Hex;
  /** Earlier or other agent keys this server still holds, for vaults whose owner authorised one of them (key rotation). */
  agentKeys?: Hex[];
  explorer: string;
  /** server-side buffer under the quote for minOut; the vault's own floor is maxSlippageBps */
  minOutBufferBps: number;
  /** where to start reading creator-fee events; without it, the block the factory was deployed in is looked up */
  feesFromBlock?: bigint;
}

export function execConfigFromEnv(env: Record<string, string | undefined>): ExecConfig {
  return {
    rpcUrl: env.MOA_RPC_URL || 'https://mainnet.hsk.xyz',
    chainId: Number(env.MOA_CHAIN_ID || 177),
    factory: (env.MOA_FACTORY_ADDRESS as Address | undefined) || undefined,
    legacyFactories: (env.MOA_LEGACY_FACTORY_ADDRESSES ?? '').split(',').map((x) => x.trim()).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x)) as Address[],
    maxVaultsPerDay: Number(env.MOA_MAX_VAULTS_PER_DAY || 20),
    agentKey: (env.MOA_AGENT_PRIVATE_KEY as Hex | undefined) || undefined,
    agentKeys: (env.MOA_AGENT_EXTRA_KEYS ?? '').split(',').map((x) => x.trim()).filter((x) => /^0x[0-9a-fA-F]{64}$/.test(x)) as Hex[],
    explorer: env.MOA_EXPLORER || 'https://hsk.blockscout.com',
    minOutBufferBps: Number(env.MOA_MIN_OUT_BUFFER_BPS || 100),
    feesFromBlock: /^\d+$/.test(env.MOA_FEES_FROM_BLOCK ?? '') ? BigInt(env.MOA_FEES_FROM_BLOCK!) : undefined,
  };
}

/** The person who made a shared agent, and the fee they asked for (basis points; the vault pays at most what its owner approved). */
export interface CreatorRef { address: Address; feeBps: number }
/**
 * `agent` is the hired agent's id in the app; on a version-3 vault the trade is made for it (its on-chain budget, its
 * approved creator). Without one the trade is the vault's plain `trade` (agent id 0), as a chat order is.
 */
export interface TradeRequest { asset: Asset; side: 'buy' | 'sell'; amount: number; note: string; creator?: CreatorRef; agent?: string }
/** The on-chain id of a hired agent: keccak256 of its id in the app. */
export const agentIdOf = (id: string | undefined): Hex => (id ? keccak256(stringToHex(id)) : zeroHash);
export type TradeResult =
  | { ok: true; txHash: Hex; explorerUrl: string; amountIn: string; amountOut: string; tokenIn: string; tokenOut: string; block: string; creatorFeeUsdt?: string; feeNote?: FeeNote }
  | { ok: false; reason: string };
/** Why a shared agent's trade paid its creator nothing: the vault is older than creator fees, or its owner did not approve this creator. */
export type FeeNote = 'oldVault' | 'notApproved';

function chainOf(cfg: ExecConfig) {
  return {
    id: cfg.chainId,
    name: cfg.chainId === 177 ? 'HSK Chain' : `chain ${cfg.chainId}`,
    nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  } as const;
}

const clientOf = (cfg: ExecConfig) => createPublicClient({ chain: chainOf(cfg), transport: http(cfg.rpcUrl) });
/** Can this server make vaults and trade for them? */
export const serviceOn = (cfg: ExecConfig) => !!cfg.factory && !!cfg.agentKey;

/** One transaction at a time from the agent key, so two requests never fight over the same nonce. */
let line: Promise<unknown> = Promise.resolve();
function inLine<T>(job: () => Promise<T>): Promise<T> {
  const run = line.then(job, job);
  line = run.catch(() => undefined);
  return run;
}

export type FactoryCheck = 'ok' | 'none' | 'old' | 'unreachable';
/**
 * Is the configured factory the one this server's code was written for? An earlier factory makes vaults without the
 * stop-loss, which this code cannot read. Pointing at one must not half-work: it is reported and left unused.
 */
export async function checkFactory(cfg: ExecConfig): Promise<FactoryCheck> {
  if (!cfg.factory) return 'none';
  const pub = clientOf(cfg);
  try {
    const code = await pub.getCode({ address: cfg.factory });
    if (!code || code === '0x') return 'old';
  } catch { return 'unreachable'; }
  try { await pub.readContract({ address: cfg.factory, abi: factoryAbi, functionName: 'stopLossBps' }); return 'ok'; } catch { return 'old'; }
}

/**
 * The vault the factory made for this wallet, or undefined when it has none yet. A wallet whose vault an earlier
 * factory made keeps that one, so nobody's funds are left behind in a vault the app no longer shows.
 */
export async function vaultOf(cfg: ExecConfig, owner: Address): Promise<Address | undefined> {
  if (!cfg.factory) return undefined;
  for (const f of [cfg.factory, ...(cfg.legacyFactories ?? [])]) {
    const v = (await clientOf(cfg).readContract({ address: f, abi: factoryAbi, functionName: 'vaultOf', args: [owner] })) as Address;
    if (v !== zeroAddress) return v;
  }
  return undefined;
}

/* ---------- vault versions: creator fees exist from version 3 ---------- */

const versions = new Map<string, number>();
/** 3 for a vault that can pay creator fees; 2 for an older one (no VERSION to read). Never changes, so it is kept. */
export async function vaultVersion(cfg: ExecConfig, vault: Address): Promise<number> {
  const key = `${cfg.rpcUrl}|${vault.toLowerCase()}`;
  const had = versions.get(key);
  if (had !== undefined) return had;
  let v = 2;
  try { v = Number(await clientOf(cfg).readContract({ address: vault, abi, functionName: 'VERSION' })); } catch { /* an older vault has no VERSION */ }
  versions.set(key, v);
  return v;
}
export const paysCreators = (version: number) => version >= 3;

/** The same configuration, pointed at this wallet's vault. */
export async function forOwner(cfg: ExecConfig, owner: Address | null | undefined): Promise<ExecConfig> {
  if (!owner) return { ...cfg, vault: undefined, owner: undefined };
  return { ...cfg, owner, vault: await vaultOf(cfg, owner) };
}

const madeOn = { day: -1, count: 0 };
export type CreateResult = { ok: true; vault: Address; txHash?: Hex } | { ok: false; reason: string };
/** Make this wallet's vault, paid for by the agent key. The wallet is the vault's owner. At most maxVaultsPerDay a day. */
export function createVault(cfg: ExecConfig, owner: Address): Promise<CreateResult> {
  return inLine(async () => {
    if (!cfg.factory || !cfg.agentKey) return { ok: false, reason: 'This server cannot make vaults: no factory contract or agent key.' };
    const account = privateKeyToAccount(cfg.agentKey);
    if (account.address.toLowerCase() === owner.toLowerCase()) return { ok: false, reason: 'The agent wallet cannot own a vault.' };
    try {
      const had = await vaultOf(cfg, owner);
      if (had) return { ok: true, vault: had };
      const day = Math.floor(Date.now() / 86_400_000);
      if (madeOn.day !== day) { madeOn.day = day; madeOn.count = 0; }
      if (madeOn.count >= cfg.maxVaultsPerDay) return { ok: false, reason: 'No more vaults can be made today. Try again tomorrow.' };
      const chain = chainOf(cfg);
      const pub = clientOf(cfg);
      const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
      const { request } = await pub.simulateContract({ address: cfg.factory, abi: factoryAbi, functionName: 'createVault', args: [owner], account });
      madeOn.count++;
      const txHash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') return { ok: false, reason: `Transaction ${txHash} reverted.` };
      const vault = await vaultOf(cfg, owner);
      return vault ? { ok: true, vault, txHash } : { ok: false, reason: 'The vault was not found after it was made.' };
    } catch (e) {
      return { ok: false, reason: `The vault could not be made: ${explain(e)}` };
    }
  });
}

/** What the browser needs to know about the network to deposit and withdraw from the user's own wallet. */
export function network(cfg: ExecConfig) {
  return {
    chainId: cfg.chainId, explorer: cfg.explorer, usdt: USDT,
    // the key the owner authorises in a version-3 vault's session (public: it is an address)
    agent: cfg.agentKey ? privateKeyToAccount(cfg.agentKey).address : undefined,
    tokens: Object.values(TOKENS).map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals })),
  };
}

/** A limit this large is "no limit": the owner chose not to cap the agent (the contract has no separate off switch). */
const NO_LIMIT = 2n ** 200n;
const limit = (v: unknown) => ((v as bigint) >= NO_LIMIT ? undefined : formatUnits(v as bigint, 6));

export async function vaultStatus(cfg: ExecConfig) {
  const base = { service: serviceOn(cfg), owner: cfg.owner, localFork: /127\.0\.0\.1|localhost/.test(cfg.rpcUrl), net: network(cfg) };
  if (!cfg.vault) return { configured: false as const, ...base };
  const pub = clientOf(cfg);
  const read = (functionName: string, args: unknown[] = []) => pub.readContract({ address: cfg.vault!, abi, functionName, args }) as Promise<unknown>;
  const balance = (token: Address, who: Address) => pub.readContract({ address: token, abi: balanceAbi, functionName: 'balanceOf', args: [who] });
  const v3 = paysCreators(await vaultVersion(cfg, cfg.vault));
  const [version, budgetsOn, halted, maxTrade, maxDaily, slippage, remaining, paused, stopLoss, usdtBal, walletUsdt, ...held] = await Promise.all([
    vaultVersion(cfg, cfg.vault),
    // version 3: per-agent budgets on or off, and the factory guardian's halt of all agent trading
    v3 ? read('budgetsOn') : Promise.resolve(false),
    v3 ? termsOf(cfg, cfg.vault).catch(() => ({ halted: false, platformFeeBps: 0, offeredBps: 0 })) : Promise.resolve({ halted: false, platformFeeBps: 0, offeredBps: 0 }), read('maxTradeUsdt'), read('maxDailyUsdt'), read('maxSlippageBps'), read('remainingToday'), read('paused'), read('stopLossBps'),
    balance(USDT, cfg.vault), cfg.owner ? balance(USDT, cfg.owner) : Promise.resolve(0n),
    // held, what it cost, what it is worth at the pool price now, and the value under which the stop-loss applies
    ...Object.values(TOKENS).map((t) => read('position', [t.address]) as Promise<readonly [bigint, bigint, bigint, bigint]>),
  ]);
  return {
    configured: true as const,
    ...base,
    holdings: Object.values(TOKENS).map((t, i) => {
      const [qty, cost, value, stop] = held[i] as readonly [bigint, bigint, bigint, bigint];
      return { symbol: t.symbol, address: t.address, decimals: t.decimals, amount: formatUnits(qty, t.decimals), costUsdt: formatUnits(cost, 6), valueUsdt: formatUnits(value, 6), stopUsdt: stop > 0n ? formatUnits(stop, 6) : undefined, stopDue: stop > 0n && cost > 0n && value < stop };
    }).filter((h) => Number(h.amount) > 0),
    stopLossBps: Number(stopLoss),
    version: version as number,
    budgetsOn: budgetsOn as boolean,
    halted: (halted as { halted: boolean }).halted,
    /** 0 unless the factory's guardian set a platform fee (at most 0.2%); shown to the user only when it is not 0 */
    platformFeeBps: (halted as { platformFeeBps: number }).platformFeeBps,
    /** the factory's rate; it applies to this vault only up to what its owner accepted (acceptPlatformFee) */
    platformFeeOfferedBps: (halted as { offeredBps: number }).offeredBps,
    /** version 3: the agent key's session on this vault (who, until when, which coins, most per buy, whether Moa holds that key) */
    session: v3 ? await sessionOf(cfg, cfg.vault).catch(() => undefined) : undefined,
    walletUsdt: formatUnits(walletUsdt as bigint, 6),
    vault: cfg.vault,
    explorerUrl: `${cfg.explorer}/address/${cfg.vault}`,
    // a missing value means the owner set no limit
    maxTradeUsdt: limit(maxTrade),
    maxDailyUsdt: limit(maxDaily),
    maxSlippageBps: Number(slippage),
    remainingTodayUsdt: limit(remaining),
    paused: paused as boolean,
    usdtBalance: formatUnits(usdtBal as bigint, 6),
  };
}

export type StopResult = { ok: true; txHash: Hex; explorerUrl: string; symbol: string; amountOut: string } | { ok: false; reason: string };
/**
 * Carry out a stop-loss that is due on this vault. Anyone may do this on-chain; the server does it from the agent
 * key so the owner does not have to be there. The vault itself decides whether the stop applies.
 */
export function stopOut(cfg: ExecConfig, asset: Asset): Promise<StopResult> {
  return inLine(async () => {
    if (!cfg.vault || !cfg.agentKey) return { ok: false, reason: 'No vault or agent key.' };
    const token = TOKENS[asset];
    const account = privateKeyToAccount(cfg.agentKey);
    const pub = clientOf(cfg);
    try {
      const { request } = await pub.simulateContract({ address: cfg.vault, abi, functionName: 'stopOut', args: [token.address], account });
      const wallet = createWalletClient({ account, chain: chainOf(cfg), transport: http(cfg.rpcUrl) });
      const txHash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') return { ok: false, reason: `Transaction ${txHash} reverted.` };
      let amountOut = 0n;
      for (const log of receipt.logs) {
        try { const ev = decodeEventLog({ abi, data: log.data, topics: log.topics }); if (ev.eventName === 'StoppedOut') amountOut = (ev.args as unknown as { amountOut: bigint }).amountOut; } catch { /* not a vault event */ }
      }
      return { ok: true, txHash, explorerUrl: `${cfg.explorer}/tx/${txHash}`, symbol: token.symbol, amountOut: formatUnits(amountOut, 6) };
    } catch (e) {
      return { ok: false, reason: explain(e) };
    }
  });
}

/** The contract's own cap on a creator fee (MAX_CREATOR_FEE_BPS): 1%. */
export const MAX_FEE_BPS = 100;

export function executeTrade(cfg: ExecConfig, req: TradeRequest): Promise<TradeResult> {
  return inLine(() => sendTrade(cfg, req));
}

/** The key this server holds for the vault's current agent, if any (the main key or one of the extra keys). */
export function keyForAgent(cfg: ExecConfig, agent: Address): Hex | undefined {
  return [cfg.agentKey, ...(cfg.agentKeys ?? [])].find((k): k is Hex => !!k && privateKeyToAccount(k).address.toLowerCase() === agent.toLowerCase());
}

/** A version-3 vault's agent session, as the server reads it before sending anything. */
export async function sessionOf(cfg: ExecConfig, vault: Address) {
  const pub = clientOf(cfg);
  const [agent, until, maxTrade] = await Promise.all(['agent', 'agentUntil', 'sessionMaxTradeUsdt'].map((f) => pub.readContract({ address: vault, abi, functionName: f }))) as [Address, bigint, bigint];
  const tokens = await Promise.all(Object.values(TOKENS).map((t) => pub.readContract({ address: vault, abi, functionName: 'sessionAllows', args: [t.address] }) as Promise<boolean>));
  return { agent, until: Number(until), maxTradeUsdt: limit(maxTrade), assets: (Object.keys(TOKENS) as Asset[]).filter((_, i) => tokens[i]), ours: !!keyForAgent(cfg, agent) };
}

/** The factory's terms every version-3 vault reads on a trade: the guardian's halt and the platform fee. */
/** platformFeeBps is what this vault pays now: the factory's rate, never above what its owner accepted. */
async function termsOf(cfg: ExecConfig, vault: Address): Promise<{ halted: boolean; platformFeeBps: number; offeredBps: number }> {
  const pub = clientOf(cfg);
  const f = (await pub.readContract({ address: vault, abi, functionName: 'factory' })) as Address;
  const [halted, bps, treasury] = (await pub.readContract({ address: f, abi: factoryAbi, functionName: 'tradeTerms' })) as readonly [boolean, number, Address];
  const offered = treasury === zeroAddress || bps > 20 ? 0 : Number(bps);
  const accepted = Number(await pub.readContract({ address: vault, abi, functionName: 'platformFeeAccepted' }));
  return { halted, platformFeeBps: Math.min(offered, accepted), offeredBps: offered };
}

/** The current factory's platform fee in basis points; 0 for a factory without one, or when it cannot be read. */
export async function platformFee(cfg: ExecConfig): Promise<number> {
  if (!cfg.factory) return 0;
  try {
    const [, bps, treasury] = (await clientOf(cfg).readContract({ address: cfg.factory, abi: factoryAbi, functionName: 'tradeTerms' })) as readonly [boolean, number, Address];
    return treasury === zeroAddress || bps > 20 ? 0 : Number(bps);
  } catch { return 0; }
}

async function sendTrade(cfg: ExecConfig, req: TradeRequest): Promise<TradeResult> {
  if (!cfg.agentKey) return { ok: false, reason: 'Execution is not configured: no agent key on this server.' };
  if (!cfg.vault) return { ok: false, reason: 'No vault: log in with your wallet first, and your vault is made for you.' };
  if (!(req.asset in TOKENS)) return { ok: false, reason: `Unsupported asset ${req.asset}.` };
  if (!(req.amount > 0)) return { ok: false, reason: 'Amount must be positive.' };
  const token = TOKENS[req.asset];
  const isBuy = req.side === 'buy';
  const amountIn = isBuy ? parseUnits(req.amount.toFixed(6), 6) : parseUnits(req.amount.toFixed(token.decimals), token.decimals);
  const chain = chainOf(cfg);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  let key: Hex = cfg.agentKey;

  try {
    // Version 3: the owner's session decides which key may trade, until when and on which coins. The server sends
    // nothing a session does not cover, and uses the key the owner authorised (never another one it holds).
    const v3first = paysCreators(await vaultVersion(cfg, cfg.vault));
    let platformFeeBps = 0;
    if (v3first) {
      const ses = await sessionOf(cfg, cfg.vault);
      const k = keyForAgent(cfg, ses.agent);
      if (!k) return { ok: false, reason: `This vault's owner authorised another agent key (${ses.agent}); Moa holds no key for it.` };
      // the chain's clock decides, as the vault's check does
      if (ses.until < Number((await pub.getBlock()).timestamp) + 15) return { ok: false, reason: `The agent's session on this vault ended${ses.until ? ` on ${new Date(ses.until * 1000).toISOString().slice(0, 10)}` : ''}. Renew it from the hire sheet or the account menu.` };
      if (!ses.assets.includes(req.asset)) return { ok: false, reason: `The agent's session on this vault does not cover ${req.asset}.` };
      key = k;
      platformFeeBps = (await termsOf(cfg, cfg.vault)).platformFeeBps;
    }
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
    const tokenIn = isBuy ? USDT : token.address;
    const held = await pub.readContract({ address: tokenIn, abi: balanceAbi, functionName: 'balanceOf', args: [cfg.vault] });
    if (held < amountIn) {
      const have = formatUnits(held, isBuy ? 6 : token.decimals), unit = isBuy ? 'USDT' : token.symbol;
      return { ok: false, reason: `The vault holds ${have} ${unit}, less than this order needs.${isBuy ? ' Deposit USDT first.' : ''}` };
    }
    // Only a vault of version 3 knows agents, budgets and creator fees: an older one is sent the plain trade, never
    // the new call. On version 3 the vault pays the creator the owner approved for this agent, at most at the
    // approved rate; the server asks for no more than the creator's published fee, and nothing when the approved
    // creator is not this agent's maker.
    const v3 = paysCreators(await vaultVersion(cfg, cfg.vault));
    const agentId = agentIdOf(req.agent);
    const fees = v3 && !!req.creator && req.creator.feeBps > 0;
    const approved = fees ? ((await pub.readContract({ address: cfg.vault, abi, functionName: 'creatorOf', args: [agentId] })) as readonly [Address, number]) : undefined;
    const sameCreator = !!approved && approved[0].toLowerCase() === req.creator!.address.toLowerCase();
    const feeBps = sameCreator ? Math.max(0, Math.min(MAX_FEE_BPS, Math.floor(req.creator!.feeBps), Number(approved![1]))) : 0;
    // the platform fee (0 unless the factory's guardian set one, at most 0.2%) comes out of the buy the same way
    const fee = isBuy ? (amountIn * BigInt(feeBps)) / 10_000n + (amountIn * BigInt(platformFeeBps)) / 10_000n : 0n;
    // On a buy the fee comes out of the USDT going in, so the swap is for the rest and the price floor is for that.
    const quoted = (await pub.readContract({ address: cfg.vault, abi, functionName: 'quote', args: [token.address, isBuy, amountIn - fee] })) as bigint;
    // 0.3% pool fee + buffer for price impact, but never looser than the floor the vault checks: on version 3 the
    // owner's slippage ceiling under the pool's 10-minute average, on older vaults under the price now.
    const ceiling = BigInt((await pub.readContract({ address: cfg.vault, abi, functionName: 'maxSlippageBps' })) as number);
    const wanted = (quoted * BigInt(10_000 - 30 - cfg.minOutBufferBps)) / 10_000n;
    // On version 3 the floor moves a little with each second until the block lands (the average slides), so the
    // server asks 10 bps over it.
    const floor = v3
      ? (((await pub.readContract({ address: cfg.vault, abi, functionName: 'minOutFloor', args: [token.address, isBuy, amountIn - fee] })) as bigint) * 10_010n) / 10_000n
      : (quoted * (10_000n - ceiling)) / 10_000n;
    const minOut = wanted > floor ? wanted : floor;
    const note = req.note.slice(0, 120);
    const { request } = v3 && req.agent
      ? await pub.simulateContract({ address: cfg.vault, abi, functionName: 'tradeFor', args: [token.address, isBuy, amountIn, minOut, note, agentId, feeBps], account })
      : await pub.simulateContract({ address: cfg.vault, abi, functionName: 'trade', args: [token.address, isBuy, amountIn, minOut, note], account });
    const txHash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') return { ok: false, reason: `Transaction ${txHash} reverted.` };
    let amountOut = 0n, paid = 0n;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (ev.eventName === 'Traded') amountOut = (ev.args as unknown as { amountOut: bigint }).amountOut;
        if (ev.eventName === 'CreatorPaid') paid = (ev.args as unknown as { feeUsdt: bigint }).feeUsdt;
      } catch { /* not a vault event */ }
    }
    const shared = req.creator && req.creator.feeBps > 0;
    return {
      ok: true,
      txHash,
      explorerUrl: `${cfg.explorer}/tx/${txHash}`,
      amountIn: isBuy ? formatUnits(amountIn, 6) : formatUnits(amountIn, token.decimals),
      amountOut: isBuy ? formatUnits(amountOut, token.decimals) : formatUnits(amountOut, 6),
      tokenIn: isBuy ? 'USDT' : token.symbol,
      tokenOut: isBuy ? token.symbol : 'USDT',
      block: receipt.blockNumber.toString(),
      ...(shared ? { creatorFeeUsdt: formatUnits(paid, 6), ...(paid > 0n ? {} : { feeNote: (fees ? 'notApproved' : 'oldVault') as FeeNote }) } : {}),
    };
  } catch (e) {
    return { ok: false, reason: `The vault refused or the transaction failed: ${explain(e)}` };
  }
}

/** Name the vault's custom error (e.g. TradeTooLarge) when the call reverted on-chain. */
function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError && rev.data?.errorName) {
      const args = (rev.data.args ?? []).map((a) => String(a)).join(', ');
      return `${rev.data.errorName}(${args})`;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

/* ---------- fees a creator has received, read from the vaults' own events ---------- */

export type FeesReceived =
  | { state: 'ok'; totalUsdt: string; payments: number; vaults: number; fromBlock: string; toBlock: string }
  | { state: 'unavailable'; reason: 'demo' | 'chain'; detail?: string };

/** The block the current factory was deployed in: no vault that can pay a creator fee is older. Found by bisection. */
let factoryBirth: { factory: string; block: bigint } | null = null;
async function birthOf(cfg: ExecConfig): Promise<bigint> {
  if (cfg.feesFromBlock !== undefined) return cfg.feesFromBlock;
  const known = factoryBirth;
  if (known && known.factory === cfg.factory) return known.block;
  const pub = clientOf(cfg);
  let lo = 0n, hi = await pub.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await pub.getCode({ address: cfg.factory!, blockNumber: mid }).catch(() => undefined);
    if (code && code !== '0x') hi = mid; else lo = mid + 1n;
  }
  factoryBirth = { factory: cfg.factory!, block: lo };
  return lo;
}

const genuine = new Map<string, boolean>();
/** Is this address a vault one of Moa's factories made? Anyone can emit an event that looks like a fee; only these count. */
async function isMoaVault(cfg: ExecConfig, address: Address): Promise<boolean> {
  const key = address.toLowerCase();
  const had = genuine.get(key);
  if (had !== undefined) return had;
  let ok = false;
  try {
    const owner = (await clientOf(cfg).readContract({ address, abi, functionName: 'owner' })) as Address;
    ok = (await vaultOf(cfg, owner))?.toLowerCase() === key;
  } catch { ok = false; }
  genuine.set(key, ok);
  return ok;
}

const scanned = new Map<string, { to: bigint; from: bigint; total: bigint; payments: number; vaults: Set<string> }>();
const PAID = abi.find((x) => x.type === 'event' && x.name === 'CreatorPaid') as Extract<(typeof abi)[number], { type: 'event' }>;
/**
 * Everything Moa vaults have paid this creator, from the vaults' CreatorPaid events since the current factory was
 * deployed. Read in steps and kept, so asking again only reads the new blocks. Without a factory there is nothing
 * to read, and the answer says so.
 */
export async function feesReceived(cfg: ExecConfig, creator: Address, step = 5_000n): Promise<FeesReceived> {
  if (!cfg.factory) return { state: 'unavailable', reason: 'demo' };
  const key = `${cfg.factory.toLowerCase()}|${creator.toLowerCase()}`;
  try {
    const pub = clientOf(cfg);
    const head = await pub.getBlockNumber();
    const from = await birthOf(cfg);
    const s = scanned.get(key) ?? { to: from - 1n, from, total: 0n, payments: 0, vaults: new Set<string>() };
    // HSK Chain's public RPC answers at most about 5,000 blocks of logs at a time ("block range too large" above
    // 10,000 on 27 Nov 2026); a range it still refuses is halved.
    for (let a = s.to + 1n; a <= head; a += step) {
      const b = a + step - 1n > head ? head : a + step - 1n;
      let logs: { address: Address; args: { feeUsdt: bigint } }[];
      try {
        logs = (await pub.getLogs({ event: PAID as never, args: { creator } as never, fromBlock: a, toBlock: b })) as unknown as typeof logs;
      } catch (e) {
        if (step > 100n && /range|too large|limit/i.test(e instanceof Error ? e.message : String(e))) { step /= 2n; a -= step; continue; }
        throw e;
      }
      for (const log of logs) {
        if (!(await isMoaVault(cfg, log.address))) continue;
        s.total += log.args.feeUsdt; s.payments++; s.vaults.add(log.address.toLowerCase());
      }
      s.to = b;
      scanned.set(key, s);
    }
    return { state: 'ok', totalUsdt: formatUnits(s.total, 6), payments: s.payments, vaults: s.vaults.size, fromBlock: s.from.toString(), toBlock: s.to.toString() };
  } catch (e) {
    return { state: 'unavailable', reason: 'chain', detail: explain(e).slice(0, 160) };
  }
}
