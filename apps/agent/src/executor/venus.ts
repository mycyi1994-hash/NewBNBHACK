/**
 * Venus USDT for yield plans (TASKS M1-05; SPEC §5.3, §5.7). The principal sits in the vUSDT
 * market; interest is redeemed right before a buy and never more than the interest (the principal
 * is not spent). Calldata comes from the DeFi API and is decoded before signing. The DeFi APPROVE
 * item is unlimited (DECISIONS Q-16), so it is never signed: an exact approve(vToken, amount) is
 * encoded instead, for the spender the DEPOSIT item calls.
 */
import {
  BinanceApiError,
  buildDeFi,
  estimateGasLimit,
  listDeFiInvestments,
  simulateCall,
  type DeFiCall,
  type SimulationResult,
} from '@ijaro/binance';
import {
  apiInt,
  BSC_USDT,
  decodeApprove,
  decodeVenusCall,
  encodeApprove,
  transferredFrom,
  transferredTo,
} from '@ijaro/chain';
import { fromUnits, toUnits, underlyingFromVTokens } from '@ijaro/core';
import { getAddress, isAddressEqual, type Hex } from 'viem';
import type { ChainPort } from './chain-port.js';
import { sendTransaction, type SendResult } from './send.js';
import type { Failure, SentTx, TradeDeps } from './trade.js';

export interface VenusMarket {
  investmentId: string;
  /** vUSDT, verified on chain: underlying() is BSC USDT. */
  vToken: Hex;
  /** The supply APY the DeFi API listed at discovery: bps for comparisons, the display string to show. */
  apyBps?: number;
  apyDisplay?: string;
}

/** Gas estimates get a margin; the bound in signableTx still applies. */
const GAS_MARGIN_PCT = 20n;

const fail = (
  code: string,
  message: string,
  fundsMoved: 'none' | 'gas_only' = 'none',
): Failure => ({
  kind: 'failed',
  code,
  message,
  fundsMoved,
});

/**
 * Finds the Venus USDT Earn investment and its vToken: the DeFi Data API names the investment,
 * a deposit build names the market (poolAddress is null, Q-05), the chain confirms it.
 */
export async function discoverVenusUsdt(
  deps: Pick<TradeDeps, 'client' | 'chain' | 'house'>,
): Promise<VenusMarket> {
  const investments = await listDeFiInvestments(deps.client, {
    defiProtocolId: 'venus',
    investType: 'Earn',
    tokenAddress: BSC_USDT,
  });
  const usdt = investments.find((inv) =>
    inv.assetTokenList?.some(
      (t) => t.tokenAddress && isAddressEqual(t.tokenAddress as Hex, BSC_USDT),
    ),
  );
  if (!usdt) throw new Error('no Venus USDT Earn investment in the DeFi API');
  const build = await buildDeFi(deps.client, 'deposit', {
    address: deps.house,
    investmentId: usdt.investmentId,
    tokenAddress: BSC_USDT,
    amount: '1',
  });
  const deposit = build.dataList.find((item) => item.callDataType === 'DEPOSIT');
  if (!deposit) throw new Error('the deposit build has no DEPOSIT item');
  const vToken = getAddress(deposit.to);
  const underlying = await deps.chain.underlyingOf(vToken);
  if (!isAddressEqual(underlying as Hex, BSC_USDT)) {
    throw new Error(`${vToken} underlying() is ${underlying}, not USDT`);
  }
  return {
    investmentId: usdt.investmentId,
    vToken,
    ...(typeof usdt.apyBps === 'number' ? { apyBps: usdt.apyBps } : {}),
    ...(typeof usdt.apyDisplay === 'string' ? { apyDisplay: usdt.apyDisplay } : {}),
  };
}

/** The USD value of `vTokens` at the current exchange rate (18-decimal string). */
export async function vTokensToUsd(
  chain: ChainPort,
  market: VenusMarket,
  vTokens: bigint,
): Promise<string> {
  return fromUnits(underlyingFromVTokens(vTokens, await chain.exchangeRate(market.vToken)), 18);
}

function itemOf(items: readonly DeFiCall[], type: string): DeFiCall | undefined {
  return items.find((item) => item.callDataType === type);
}

async function simulate(deps: TradeDeps, call: { to: string; data: string }) {
  return simulateCall(deps.client, { from: deps.house, to: call.to, value: '0', data: call.data });
}

async function gasFor(deps: TradeDeps, call: { to: string; data: string }, fallback?: string) {
  try {
    const estimate = await estimateGasLimit(deps.client, {
      from: deps.house,
      to: call.to,
      value: '0',
      data: call.data,
    });
    return estimate + (estimate * GAS_MARGIN_PCT) / 100n;
  } catch (error) {
    if (!(error instanceof BinanceApiError) || fallback === undefined) throw error;
    return apiInt(fallback, 'gasLimit');
  }
}

function signerDeps(deps: TradeDeps) {
  if (deps.mode !== 'live' || !deps.signer) throw new Error('live mode with a signer is required');
  return {
    client: deps.client,
    chain: deps.chain,
    db: deps.db,
    signer: deps.signer,
    log: deps.log,
  };
}

type SendOutcome = SentTx | { kind: 'pending'; txHash: Hex } | Failure;

function outcomeOf(
  result: SendResult,
  kind: SentTx['kind'],
  simulatedAt: string,
  amounts: Record<string, string>,
): SendOutcome {
  switch (result.state) {
    case 'confirmed':
      return {
        kind,
        txHash: result.txHash,
        broadcastVia: result.broadcastVia,
        receipt: result.receipt,
        simulatedAt,
        amounts,
      };
    case 'pending':
      return { kind: 'pending', txHash: result.txHash };
    case 'reverted':
      return fail(
        `${kind.toUpperCase()}_REVERTED`,
        `${kind} ${result.txHash} reverted on chain`,
        'gas_only',
      );
    case 'not_sent':
      return fail(`${kind.toUpperCase()}_NOT_SENT`, result.reason);
  }
}

export type DepositResult =
  | {
      kind: 'simulated';
      approve: SimulationResult | 'existing_allowance';
      deposit: SimulationResult;
    }
  | { kind: 'deposited'; vTokensMinted: bigint; usdtSpent: bigint; sent: SentTx[] }
  | { kind: 'pending'; txHash: Hex; sent: SentTx[] }
  | Failure;

/** Deposits `amountUsd` USDT of the plan's principal into Venus. */
export async function depositPrincipal(
  deps: TradeDeps,
  args: { planId: string; market: VenusMarket; amountUsd: string },
): Promise<DepositResult> {
  const amount = toUnits(args.amountUsd, 18);
  let build;
  try {
    build = await buildDeFi(deps.client, 'deposit', {
      address: deps.house,
      investmentId: args.market.investmentId,
      tokenAddress: BSC_USDT,
      amount: args.amountUsd,
    });
  } catch (error) {
    if (error instanceof BinanceApiError)
      return fail(String(error.code ?? error.kind), `deposit build: ${error.msg}`);
    throw error;
  }
  const deposit = itemOf(build.dataList, 'DEPOSIT');
  if (!deposit) return fail('DEFI_NO_DEPOSIT', 'the deposit build has no DEPOSIT item');
  if (!isAddressEqual(deposit.to as Hex, args.market.vToken)) {
    return fail('DEFI_WRONG_MARKET', `DEPOSIT calls ${deposit.to}, not ${args.market.vToken}`);
  }
  if (
    !isAddressEqual(deposit.from as Hex, deps.house) ||
    apiInt(deposit.value ?? '0', 'value') !== 0n
  ) {
    return fail('DEFI_WRONG_SENDER', 'DEPOSIT is not a plain call from the house wallet');
  }
  const call = decodeVenusCall(deposit.data);
  if (call.fn !== 'mint' || call.amount !== amount) {
    return fail(
      'DEFI_WRONG_AMOUNT',
      `DEPOSIT is ${call.fn}(${call.amount}), the deposit is ${amount}`,
    );
  }
  const apiApprove = itemOf(build.dataList, 'APPROVE');
  if (apiApprove && !isAddressEqual(decodeApprove(apiApprove.data).spender, args.market.vToken)) {
    return fail('DEFI_APPROVE_SPENDER', 'the APPROVE item names another spender');
  }

  const sent: SentTx[] = [];
  let approveSimulation: SimulationResult | 'existing_allowance' = 'existing_allowance';
  if ((await deps.chain.allowance(BSC_USDT, deps.house, args.market.vToken)) < amount) {
    const approve = { to: BSC_USDT, data: encodeApprove(args.market.vToken, amount) };
    approveSimulation = await simulate(deps, approve);
    if (approveSimulation.status !== 'SUCCESS') {
      return fail('SIM_APPROVE', `approve simulation: ${approveSimulation.failReason}`);
    }
    if (deps.mode === 'live') {
      const result = await sendTransaction(signerDeps(deps), {
        planId: args.planId,
        cycleId: null,
        kind: 'approve',
        ...approve,
        value: 0n,
        gas: await gasFor(deps, approve, apiApprove?.gasLimit),
        gasPrice: apiInt(apiApprove?.gasPrice ?? deposit.gasPrice, 'gasPrice'),
      });
      const outcome = outcomeOf(result, 'approve', deps.now().toISOString(), {
        token: BSC_USDT,
        spender: args.market.vToken,
        amount: amount.toString(),
      });
      if (!('receipt' in outcome))
        return outcome.kind === 'pending' ? { ...outcome, sent } : outcome;
      sent.push(outcome);
    }
  }

  const depositSimulation = await simulate(deps, deposit);
  if (deps.mode === 'simulate') {
    return { kind: 'simulated', approve: approveSimulation, deposit: depositSimulation };
  }
  if (depositSimulation.status !== 'SUCCESS') {
    return fail('SIM_DEPOSIT', `deposit simulation: ${depositSimulation.failReason}`);
  }
  const result = await sendTransaction(signerDeps(deps), {
    planId: args.planId,
    cycleId: null,
    kind: 'deposit',
    to: deposit.to,
    data: deposit.data,
    value: 0n,
    gas: await gasFor(deps, deposit),
    gasPrice: apiInt(deposit.maxFeePerGas ?? deposit.gasPrice, 'deposit gasPrice'),
    ...(deposit.maxPriorityFeePerGas
      ? { maxPriorityFeePerGas: apiInt(deposit.maxPriorityFeePerGas, 'maxPriorityFeePerGas') }
      : {}),
  });
  const outcome = outcomeOf(result, 'deposit', deps.now().toISOString(), {
    amountUsd: args.amountUsd,
  });
  if (!('receipt' in outcome)) return outcome.kind === 'pending' ? { ...outcome, sent } : outcome;
  const vTokensMinted = transferredTo(outcome.receipt.logs, args.market.vToken, deps.house);
  const usdtSpent = transferredFrom(outcome.receipt.logs, BSC_USDT, deps.house);
  outcome.amounts = {
    ...outcome.amounts,
    vTokensMinted: vTokensMinted.toString(),
    usdtSpent: usdtSpent.toString(),
  };
  sent.push(outcome);
  return { kind: 'deposited', vTokensMinted, usdtSpent, sent };
}

export type RedeemResult =
  | { kind: 'simulated'; redeem: SimulationResult; vTokens: bigint }
  | { kind: 'redeemed'; usdtReceived: bigint; vTokensBurned: bigint; sent: SentTx }
  | { kind: 'pending'; txHash: Hex }
  | Failure;

/**
 * Redeems `amountUsd` of USDT from the plan's Venus position. The calldata may burn no more than
 * the plan's own vTokens and no more than the amount is worth (one vToken of rounding), so a
 * redemption of interest can never reach into the principal.
 */
export async function redeemFromVenus(
  deps: TradeDeps,
  args: {
    planId: string;
    cycleId: number | null;
    market: VenusMarket;
    amountUsd: string;
    planVTokens: bigint;
  },
): Promise<RedeemResult> {
  const amount = toUnits(args.amountUsd, 18);
  let build;
  try {
    build = await buildDeFi(deps.client, 'redeem', {
      address: deps.house,
      investmentId: args.market.investmentId,
      tokenAddress: BSC_USDT,
      amount: args.amountUsd,
    });
  } catch (error) {
    if (error instanceof BinanceApiError)
      return fail(String(error.code ?? error.kind), `redeem build: ${error.msg}`);
    throw error;
  }
  if ((build.redeemDelayDays?.length ?? 0) > 0) {
    return fail('DEFI_REDEEM_DELAY', `redeem waits ${JSON.stringify(build.redeemDelayDays)} days`);
  }
  const redeem = itemOf(build.dataList, 'REDEEM');
  if (!redeem) return fail('DEFI_NO_REDEEM', 'the redeem build has no REDEEM item');
  if (!isAddressEqual(redeem.to as Hex, args.market.vToken)) {
    return fail('DEFI_WRONG_MARKET', `REDEEM calls ${redeem.to}, not ${args.market.vToken}`);
  }
  if (
    !isAddressEqual(redeem.from as Hex, deps.house) ||
    apiInt(redeem.value ?? '0', 'value') !== 0n
  ) {
    return fail('DEFI_WRONG_SENDER', 'REDEEM is not a plain call from the house wallet');
  }
  const call = decodeVenusCall(redeem.data);
  if (call.fn !== 'redeem') return fail('DEFI_WRONG_CALL', `REDEEM is ${call.fn}()`);
  const rate = await deps.chain.exchangeRate(args.market.vToken);
  const worth = underlyingFromVTokens(call.amount, rate);
  const oneVToken = underlyingFromVTokens(1n, rate) + 1n;
  if (call.amount > args.planVTokens || worth > amount + oneVToken) {
    return fail(
      'DEFI_REDEEM_TOO_LARGE',
      `REDEEM burns ${call.amount} vTokens (≈ ${worth} units) for ${amount}; the plan holds ${args.planVTokens}`,
    );
  }

  const simulation = await simulate(deps, redeem);
  if (deps.mode === 'simulate')
    return { kind: 'simulated', redeem: simulation, vTokens: call.amount };
  if (simulation.status !== 'SUCCESS')
    return fail('SIM_REDEEM', `redeem simulation: ${simulation.failReason}`);
  const result = await sendTransaction(signerDeps(deps), {
    planId: args.planId,
    cycleId: args.cycleId,
    kind: 'redeem',
    to: redeem.to,
    data: redeem.data,
    value: 0n,
    gas: await gasFor(deps, redeem),
    gasPrice: apiInt(redeem.maxFeePerGas ?? redeem.gasPrice, 'redeem gasPrice'),
    ...(redeem.maxPriorityFeePerGas
      ? { maxPriorityFeePerGas: apiInt(redeem.maxPriorityFeePerGas, 'maxPriorityFeePerGas') }
      : {}),
  });
  const outcome = outcomeOf(result, 'redeem', deps.now().toISOString(), {
    amountUsd: args.amountUsd,
  });
  if (!('receipt' in outcome)) return outcome;
  const usdtReceived = transferredTo(outcome.receipt.logs, BSC_USDT, deps.house);
  const vTokensBurned = transferredFrom(outcome.receipt.logs, args.market.vToken, deps.house);
  outcome.amounts = {
    ...outcome.amounts,
    usdtReceived: usdtReceived.toString(),
    vTokensBurned: vTokensBurned.toString(),
  };
  return { kind: 'redeemed', usdtReceived, vTokensBurned, sent: outcome };
}
