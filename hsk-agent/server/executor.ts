// Sends a trade to a user's MoaVault with the agent key. Every limit is enforced again by the contract.
// Each signed-in wallet has its own vault, made by the MoaVaultFactory; the server looks it up per request.
// Configuration comes from the server environment; with no factory or no agent key, execution is refused.
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeEventLog, http, parseUnits, formatUnits, zeroAddress, type Address, type Hex } from 'viem';
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
  /** the vault this request is about (the signed-in wallet's), set per request by forOwner() */
  vault?: Address;
  owner?: Address;
  /** how many vaults this server will pay to create per UTC day */
  maxVaultsPerDay: number;
  agentKey?: Hex;
  explorer: string;
  /** server-side buffer under the quote for minOut; the vault's own floor is maxSlippageBps */
  minOutBufferBps: number;
}

export function execConfigFromEnv(env: Record<string, string | undefined>): ExecConfig {
  return {
    rpcUrl: env.MOA_RPC_URL || 'https://mainnet.hsk.xyz',
    chainId: Number(env.MOA_CHAIN_ID || 177),
    factory: (env.MOA_FACTORY_ADDRESS as Address | undefined) || undefined,
    maxVaultsPerDay: Number(env.MOA_MAX_VAULTS_PER_DAY || 20),
    agentKey: (env.MOA_AGENT_PRIVATE_KEY as Hex | undefined) || undefined,
    explorer: env.MOA_EXPLORER || 'https://hsk.blockscout.com',
    minOutBufferBps: Number(env.MOA_MIN_OUT_BUFFER_BPS || 100),
  };
}

export interface TradeRequest { asset: Asset; side: 'buy' | 'sell'; amount: number; note: string }
export type TradeResult =
  | { ok: true; txHash: Hex; explorerUrl: string; amountIn: string; amountOut: string; tokenIn: string; tokenOut: string; block: string }
  | { ok: false; reason: string };

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

/** The vault the factory made for this wallet, or undefined when it has none yet. */
export async function vaultOf(cfg: ExecConfig, owner: Address): Promise<Address | undefined> {
  if (!cfg.factory) return undefined;
  const v = (await clientOf(cfg).readContract({ address: cfg.factory, abi: factoryAbi, functionName: 'vaultOf', args: [owner] })) as Address;
  return v === zeroAddress ? undefined : v;
}

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
  const [maxTrade, maxDaily, slippage, remaining, paused, stopLoss, usdtBal, walletUsdt, ...held] = await Promise.all([
    read('maxTradeUsdt'), read('maxDailyUsdt'), read('maxSlippageBps'), read('remainingToday'), read('paused'), read('stopLossBps'),
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

export function executeTrade(cfg: ExecConfig, req: TradeRequest): Promise<TradeResult> {
  return inLine(() => sendTrade(cfg, req));
}

async function sendTrade(cfg: ExecConfig, req: TradeRequest): Promise<TradeResult> {
  if (!cfg.agentKey) return { ok: false, reason: 'Execution is not configured: no agent key on this server.' };
  if (!cfg.vault) return { ok: false, reason: 'No vault: log in with your wallet first, and your vault is made for you.' };
  if (!(req.asset in TOKENS)) return { ok: false, reason: `Unsupported asset ${req.asset}.` };
  if (!(req.amount > 0)) return { ok: false, reason: 'Amount must be positive.' };
  const token = TOKENS[req.asset];
  const isBuy = req.side === 'buy';
  const amountIn = isBuy ? parseUnits(req.amount.toFixed(6), 6) : parseUnits(req.amount.toFixed(token.decimals), token.decimals);
  const account = privateKeyToAccount(cfg.agentKey);
  const chain = chainOf(cfg);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });

  try {
    const tokenIn = isBuy ? USDT : token.address;
    const held = await pub.readContract({ address: tokenIn, abi: balanceAbi, functionName: 'balanceOf', args: [cfg.vault] });
    if (held < amountIn) {
      const have = formatUnits(held, isBuy ? 6 : token.decimals), unit = isBuy ? 'USDT' : token.symbol;
      return { ok: false, reason: `The vault holds ${have} ${unit}, less than this order needs.${isBuy ? ' Deposit USDT first.' : ''}` };
    }
    const quoted = (await pub.readContract({ address: cfg.vault, abi, functionName: 'quote', args: [token.address, isBuy, amountIn] })) as bigint;
    // 0.3% pool fee + buffer for price impact, but never looser than the floor the owner set on the vault:
    // an owner who tightens the slippage ceiling gets orders that ask for at least that price, not refused ones.
    const ceiling = BigInt((await pub.readContract({ address: cfg.vault, abi, functionName: 'maxSlippageBps' })) as number);
    const wanted = (quoted * BigInt(10_000 - 30 - cfg.minOutBufferBps)) / 10_000n;
    const floor = (quoted * (10_000n - ceiling)) / 10_000n;
    const minOut = wanted > floor ? wanted : floor;
    const note = req.note.slice(0, 120);
    const { request } = await pub.simulateContract({ address: cfg.vault, abi, functionName: 'trade', args: [token.address, isBuy, amountIn, minOut, note], account });
    const txHash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') return { ok: false, reason: `Transaction ${txHash} reverted.` };
    let amountOut = 0n;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (ev.eventName === 'Traded') amountOut = (ev.args as unknown as { amountOut: bigint }).amountOut;
      } catch { /* not a vault event */ }
    }
    return {
      ok: true,
      txHash,
      explorerUrl: `${cfg.explorer}/tx/${txHash}`,
      amountIn: isBuy ? formatUnits(amountIn, 6) : formatUnits(amountIn, token.decimals),
      amountOut: isBuy ? formatUnits(amountOut, token.decimals) : formatUnits(amountOut, 6),
      tokenIn: isBuy ? 'USDT' : token.symbol,
      tokenOut: isBuy ? token.symbol : 'USDT',
      block: receipt.blockNumber.toString(),
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
