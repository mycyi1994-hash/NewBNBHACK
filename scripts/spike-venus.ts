/**
 * pnpm spike:venus — M0-07 Venus spike. Read-only and simulate-only: nothing is signed or broadcast.
 *   1. DeFi Data: Venus protocol detail (securityScore, TVL), USDT Earn investment (APY), house position.
 *   2. DeFi Transaction: deposit and redeem calldata for 1 USDT from the house address (simulate=true,
 *      then simulate=false if the server refuses an unfunded address).
 *   3. On-chain: the market the DEPOSIT item calls must be a vToken with symbol vUSDT and underlying
 *      USDT (the Data API returns poolAddress null); exchangeRateStored, utilisation, pause flags.
 *   4. Transaction API: simulate every dataList item as an EVM tx from the house address.
 * Every response is saved under fixtures/ with the house address redacted.
 */
import { createRuntime, maskHouse, type Runtime } from '@ijaro/agent';
import { BinanceApiError, type ApiModule } from '@ijaro/binance';
import { BSC_USDT, assertUsdt, erc20Abi, readVTokenBalance, readVTokenState } from '@ijaro/chain';
import { fromUnits, underlyingFromVTokens, utilizationBps } from '@ijaro/core';
import { loadConfig } from '@ijaro/config';
import { decodeFunctionData, getAddress, maxUint256, parseAbi } from 'viem';

const AMOUNT_USDT = '1';
/** DeFi build with simulate=true refuses an unfunded address (40484); retry without it to get calldata. */
const SIMULATE_MODES = [true, false] as const;

const rt: Runtime = createRuntime(loadConfig(), { fixtures: true });
const mask = (value: unknown) => maskHouse(JSON.stringify(value) ?? String(value), rt.redact);

async function call<T>(
  module: ApiModule,
  endpoint: string,
  path: string,
  body: unknown,
): Promise<{ data?: T; error?: string }> {
  try {
    const res = await rt.client.request<T>(module, endpoint, {
      method: 'POST',
      path,
      body,
      recordFixture: true,
    });
    console.log(
      `  ${module}/${endpoint}: HTTP ${res.httpStatus} code ${res.code} ${res.latencyMs} ms → ${res.fixturePath}`,
    );
    return { data: res.data };
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    const text = `HTTP ${error.httpStatus ?? '-'} code ${error.code ?? error.kind} "${maskHouse(error.msg, rt.redact)}"`;
    console.log(`  ${module}/${endpoint}: ERROR ${text}`);
    return { error: text };
  }
}

interface Investment {
  investmentId?: string;
  investmentName?: string;
  defiProtocolId?: string;
  apyBps?: number | string;
  apyDisplay?: string;
  tvl?: string;
  poolAddress?: string | null;
  investable?: boolean;
  assetTokenList?: { tokenAddress?: string; tokenSymbol?: string }[];
}

interface BuildItem {
  callDataType?: string;
  from?: string;
  to?: string;
  value?: string;
  data?: string;
  gasLimit?: string;
}

interface BuildResult {
  dataList?: BuildItem[];
  preview?: unknown;
  redeemDelayDays?: number[];
}

interface SimulateResult {
  status?: string;
  failReason?: string;
  balanceChanges?: unknown[];
  allowanceChanges?: unknown[];
}

const approveAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

try {
  if (!rt.houseAddress) {
    throw new Error('HOUSE_WALLET_PRIVATE_KEY is required (address only; nothing is signed)');
  }
  const house = rt.houseAddress;
  console.log(
    `spike:venus — ${new Date().toISOString()} — from [house], amount ${AMOUNT_USDT} USDT, simulate only`,
  );

  console.log('\n1. DeFi Data');
  const protocol = await call<{
    protocolName?: string;
    securityScore?: unknown;
    tvl?: string;
    dimensionScores?: unknown;
  }>('defi-data', 'getProtocolDetail', '/api/v1/defi/data/protocol/detail', {
    defiProtocolId: 'venus',
  });
  console.log(
    `  ${protocol.data?.protocolName}: securityScore ${mask(protocol.data?.securityScore)}, TVL ${protocol.data?.tvl}, dimensionScores ${mask(protocol.data?.dimensionScores)}`,
  );

  const list = await call<{ list?: Investment[]; total?: number }>(
    'defi-data',
    'listDeFiInvestments',
    '/api/v1/defi/data/investment/list',
    {
      investType: 'Earn',
      defiProtocolId: 'venus',
      binanceChainId: '56',
      tokenAddressList: [BSC_USDT],
      page: 1,
      size: 20,
    },
  );
  for (const inv of list.data?.list ?? []) {
    console.log(
      `  investment ${inv.investmentId} "${inv.investmentName}" apyBps ${inv.apyBps} (${inv.apyDisplay}) tvl ${inv.tvl}`,
    );
  }
  const usdt =
    (list.data?.list ?? []).find((inv) =>
      inv.assetTokenList?.some((t) => t.tokenAddress?.toLowerCase() === BSC_USDT.toLowerCase()),
    ) ?? list.data?.list?.[0];
  if (!usdt?.investmentId) throw new Error('no Venus USDT Earn investment returned');

  const detail = await call<Investment>(
    'defi-data',
    'getInvestmentDetail',
    '/api/v1/defi/data/investment/detail',
    { investmentId: usdt.investmentId },
  );
  console.log(
    `  detail: investable ${detail.data?.investable} apyBps ${detail.data?.apyBps} (${detail.data?.apyDisplay}) tvl ${detail.data?.tvl} poolAddress ${detail.data?.poolAddress}`,
  );

  const positions = await call<unknown>(
    'defi-data',
    'getDeFiPositions',
    '/api/v1/defi/data/position/list',
    { addresses: [house], binanceChainIds: ['56'] },
  );
  console.log(`  house positions: ${mask(positions.data).slice(0, 400)}`);

  const builds: Partial<Record<'deposit' | 'redeem', BuildResult>> = {};
  for (const action of ['deposit', 'redeem'] as const) {
    for (const simulate of SIMULATE_MODES) {
      console.log(`\n2. DeFi Transaction: ${action} ${AMOUNT_USDT} USDT (simulate=${simulate})`);
      const built = await call<BuildResult>(
        'defi-transaction',
        action === 'deposit' ? 'buildDeFiDepositTransaction' : 'buildDeFiRedeemTransaction',
        `/api/v1/defi/transaction/${action}`,
        {
          address: house,
          investmentId: usdt.investmentId,
          token: { tokenAddress: BSC_USDT, amount: AMOUNT_USDT },
          simulate,
        },
      );
      if (!built.data) continue;
      builds[action] = built.data;
      console.log(
        `  dataList ${built.data.dataList?.map((i) => i.callDataType).join(', ')}; redeemDelayDays ${JSON.stringify(built.data.redeemDelayDays)}; preview ${mask(built.data.preview).slice(0, 700)}`,
      );
      break;
    }
  }

  const pool =
    detail.data?.poolAddress ??
    builds.deposit?.dataList?.find((i) => i.callDataType !== 'APPROVE')?.to;
  if (!pool) throw new Error('no vToken address from investment detail or deposit calldata');

  console.log('\n3. On-chain (BSC): vToken = DEPOSIT item `to`');
  await assertUsdt(rt.bsc);
  const v = await readVTokenState(rt.bsc, pool);
  const underlyingOk = getAddress(v.underlying) === getAddress(BSC_USDT);
  console.log(
    `  ${getAddress(pool)} @ block ${v.blockNumber}: symbol() = ${v.symbol}, decimals ${v.decimals}, underlying() = ${v.underlying} ${underlyingOk ? '= USDT' : '≠ USDT'}`,
  );
  console.log(
    `  exchangeRateStored ${v.exchangeRateStored} → 1 ${v.symbol} = ${fromUnits(underlyingFromVTokens(10n ** BigInt(v.decimals), v.exchangeRateStored), 18)} USDT`,
  );
  console.log(
    `  cash ${fromUnits(v.cash, 18)} borrows ${fromUnits(v.totalBorrows, 18)} reserves ${fromUnits(v.totalReserves, 18)} → utilisation ${(utilizationBps(v.cash, v.totalBorrows, v.totalReserves) / 100).toFixed(2)}%`,
  );
  console.log(
    `  supplyRatePerBlock ${v.supplyRatePerBlock}; Comptroller ${v.comptroller} actionPaused MINT=${v.mintPaused} REDEEM=${v.redeemPaused}`,
  );
  const [usdtBal, bnbBal, vBal] = await Promise.all([
    rt.bsc.readContract({
      address: BSC_USDT,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [house],
    }),
    rt.bsc.getBalance({ address: house }),
    readVTokenBalance(rt.bsc, pool, house),
  ]);
  console.log(
    `  house balances: USDT ${fromUnits(usdtBal, 18)}, BNB ${fromUnits(bnbBal, 18)}, ${v.symbol} ${fromUnits(vBal, v.decimals)}`,
  );
  if (v.symbol !== 'vUSDT' || !underlyingOk) process.exitCode = 1;

  for (const action of ['deposit', 'redeem'] as const) {
    for (const [n, item] of (builds[action]?.dataList ?? []).entries()) {
      let decoded = '';
      if (item.callDataType === 'APPROVE' && item.data) {
        const { args } = decodeFunctionData({ abi: approveAbi, data: item.data as `0x${string}` });
        decoded = ` approve(spender ${args[0]}, amount ${args[1] === maxUint256 ? 'type(uint256).max (UNLIMITED)' : args[1]})`;
      }
      console.log(
        `\n4. Transaction API simulate: ${action} dataList[${n}] ${item.callDataType} to ${item.to} value ${item.value} gasLimit ${item.gasLimit} selector ${item.data?.slice(0, 10)}${decoded}`,
      );
      const sim = await call<SimulateResult>(
        'transaction',
        'simulateTransactions',
        '/api/v1/dex/pre-transaction/simulate',
        {
          binanceChainId: '56',
          evmTx: {
            from: item.from ?? house,
            to: item.to,
            value: item.value?.startsWith('0x')
              ? BigInt(item.value).toString()
              : (item.value ?? '0'),
            data: item.data,
          },
        },
      );
      if (sim.data) {
        console.log(
          `  status ${sim.data.status} failReason ${JSON.stringify(sim.data.failReason ?? null)} balanceChanges ${mask(sim.data.balanceChanges)} allowanceChanges ${mask(sim.data.allowanceChanges)}`,
        );
      }
    }
  }
  if (rt.sinkErrors.length) console.log(`api_calls sink errors: ${rt.sinkErrors.length}`);
} finally {
  await rt.close();
}
