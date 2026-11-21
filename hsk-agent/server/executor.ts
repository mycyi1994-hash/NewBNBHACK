// Sends a trade to the MoaVault contract with the agent key. Every limit is enforced again by the contract.
// Configuration comes from the server environment; with no vault configured, execution is refused.
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeEventLog, http, parseUnits, formatUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import vaultArtifact from '../contracts/out/MoaVault.json' with { type: 'json' };

export type Asset = 'HSK' | 'ETH' | 'BTC';
export const TOKENS: Record<Asset, { address: Address; decimals: number; symbol: string }> = {
  HSK: { address: '0xB210D2120d57b758EE163cFfb43e73728c471Cf1', decimals: 18, symbol: 'WHSK' },
  ETH: { address: '0xefd4bC9afD210517803f293ABABd701CaeeCdfd0', decimals: 18, symbol: 'WETH' },
  BTC: { address: '0x6119ca49a79f5825c8b345f8d7ac36b272565b14', decimals: 8, symbol: 'WBTC' },
};
export const USDT: Address = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029';
const abi = vaultArtifact.abi;

export interface ExecConfig {
  rpcUrl: string;
  chainId: number;
  vault?: Address;
  agentKey?: Hex;
  explorer: string;
  /** server-side buffer under the quote for minOut; the vault's own floor is maxSlippageBps */
  minOutBufferBps: number;
}

export function execConfigFromEnv(env: Record<string, string | undefined>): ExecConfig {
  return {
    rpcUrl: env.MOA_RPC_URL || 'https://mainnet.hsk.xyz',
    chainId: Number(env.MOA_CHAIN_ID || 177),
    vault: (env.MOA_VAULT_ADDRESS as Address | undefined) || undefined,
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

export async function vaultStatus(cfg: ExecConfig) {
  if (!cfg.vault) return { configured: false as const };
  const pub = createPublicClient({ chain: chainOf(cfg), transport: http(cfg.rpcUrl) });
  const read = (functionName: string, args: unknown[] = []) => pub.readContract({ address: cfg.vault!, abi, functionName, args }) as Promise<unknown>;
  const [maxTrade, maxDaily, slippage, remaining, paused, usdtBal] = await Promise.all([
    read('maxTradeUsdt'), read('maxDailyUsdt'), read('maxSlippageBps'), read('remainingToday'), read('paused'),
    pub.readContract({ address: USDT, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [cfg.vault] }),
  ]);
  return {
    configured: true as const,
    vault: cfg.vault,
    maxTradeUsdt: formatUnits(maxTrade as bigint, 6),
    maxDailyUsdt: formatUnits(maxDaily as bigint, 6),
    maxSlippageBps: Number(slippage),
    remainingTodayUsdt: formatUnits(remaining as bigint, 6),
    paused: paused as boolean,
    usdtBalance: formatUnits(usdtBal as bigint, 6),
  };
}

export async function executeTrade(cfg: ExecConfig, req: TradeRequest): Promise<TradeResult> {
  if (!cfg.vault || !cfg.agentKey) return { ok: false, reason: 'Execution is not configured: no vault contract or agent key on this server.' };
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
    const quoted = (await pub.readContract({ address: cfg.vault, abi, functionName: 'quote', args: [token.address, isBuy, amountIn] })) as bigint;
    // 0.3% pool fee + buffer for price impact; the vault rejects anything looser than its own floor
    const minOut = (quoted * BigInt(10_000 - 30 - cfg.minOutBufferBps)) / 10_000n;
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
