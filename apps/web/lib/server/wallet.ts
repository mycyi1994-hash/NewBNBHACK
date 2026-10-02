/**
 * "My wallet" (DECISIONS D-32): a BNB Smart Chain address — the user's Binance Wallet or Agentic
 * Wallet (`baw wallet address`) — read at one block: every registered tokenized stock it holds,
 * counted in shares (tokens × the multiplier: a bStocks token's own on chain at that block, with
 * any scheduled change; an Ondo token's from the registry), its USDT, its Venus USDT position, and
 * the Yieldvest plans that use it. Public chain reads and the worker's records only: nothing is
 * signed, nothing about the address is stored.
 */
import type { Config } from '@yieldvest/config';
import {
  formatShares,
  fromUnits,
  sharesFromTokens,
  toUnits,
  truncateDecimal,
  underlyingFromVTokens,
  upcomingMultiplierChange,
  type Instrument,
  type Issuer,
} from '@yieldvest/core';
import {
  instrumentFromRow,
  listInstruments,
  listPlans,
  planFromRow,
  readWorkerStatus,
  type Db,
  type TapeSampleRow,
} from '@yieldvest/db';
import { getAddress } from 'viem';
import { webChain, type WalletReading } from './chain';
import { tapeView, type TapeView } from './market';

export interface WalletStock {
  ticker: string;
  issuer: Issuer;
  symbol: string;
  /** The token's contract address. */
  token: string;
  /** Tokens held, as a decimal. */
  tokens: string;
  /** Underlying shares: tokens × multiplier, at most six decimals, rounded down. */
  shares: string;
  multiplier: string;
  /** bStocks: read on chain at this block. Ondo: Binance's tokenToShareRatio in the registry. */
  multiplierSource: 'chain' | 'registry';
  /** A scheduled bStocks multiplier change (a dividend or a split), when one is pending. */
  pendingChange: { to: string; effectiveAt: string } | null;
  /** Tokens × the last recorded token price, USD to the cent, rounded down; null without one. */
  valueUsd: string | null;
}

export interface WalletPlan {
  id: string;
  mode: string;
  ticker: string | null;
  cadence: string;
  window: string;
  contributionUsd: string;
  status: string;
  pausedReason: string | null;
}

export interface WalletView {
  address: string;
  chain:
    | { state: 'LIVE'; blockNumber: string; readAt: string }
    | { state: 'UNAVAILABLE'; reason: string };
  /** The registered tokens this wallet holds, by ticker. */
  stocks: WalletStock[];
  /** How many registered tokens were read, and how many of those reads failed. */
  checked: number;
  unread: number;
  /** USDT in the wallet, a decimal; null when not read. */
  usdt: string | null;
  venus:
    { state: 'LIVE'; usdt: string; vTokens: string } | { state: 'UNAVAILABLE'; reason: string };
  /** The tape the values come from: LIVE, STALE with its time, or UNAVAILABLE. */
  prices: Pick<TapeView, 'state' | 'sampledAt'>;
  plans: WalletPlan[];
}

const E18 = 10n ** 18n;
const ISSUER_ORDER: readonly Issuer[] = ['bstocks', 'ondo', 'xstocks'];

/** A token amount in its own decimals as 18-decimal units (registered tokens have 18). */
function to18(units: bigint, decimals: number): bigint {
  return decimals <= 18
    ? units * 10n ** BigInt(18 - decimals)
    : units / 10n ** BigInt(decimals - 18);
}

/** Tokens × price per token, to the cent, rounded down; null without a usable price. */
function valueOf(tokens18: bigint, row: TapeSampleRow | undefined): string | null {
  const price = row?.tokenPrice;
  if (!price || !/^\d+(\.\d+)?$/.test(price)) return null;
  const value = (tokens18 * toUnits(truncateDecimal(price, 18), 18)) / E18;
  return fromUnits(value - (value % 10n ** 16n), 18);
}

export interface WalletInput {
  address: string;
  instruments: readonly Instrument[];
  /** The chain reading, or why there is none. */
  reading: WalletReading | { error: string };
  /** The verified Venus market, when the worker has one. */
  vToken: string | null;
  tape: TapeView;
  plans: WalletPlan[];
  now: Date;
}

/** The wallet view from one chain reading; pure, so every branch is a unit test. */
export function walletFromReading(input: WalletInput): WalletView {
  const { reading, tape } = input;
  const address = getAddress(input.address);
  const prices = { state: tape.state, sampledAt: tape.sampledAt };
  const base = { address, prices, plans: input.plans, checked: input.instruments.length };
  if ('error' in reading) {
    return {
      ...base,
      chain: { state: 'UNAVAILABLE', reason: reading.error },
      stocks: [],
      unread: input.instruments.length,
      usdt: null,
      venus: { state: 'UNAVAILABLE', reason: reading.error },
    };
  }

  const stocks: WalletStock[] = [];
  let unread = 0;
  const ordered = [...input.instruments].sort(
    (a, b) =>
      a.ticker.localeCompare(b.ticker) ||
      ISSUER_ORDER.indexOf(a.issuer) - ISSUER_ORDER.indexOf(b.issuer),
  );
  for (const instrument of ordered) {
    const key = instrument.address.toLowerCase();
    const balance = reading.balances.get(key);
    if (balance === undefined) {
      unread += 1;
      continue;
    }
    if (balance <= 0n) continue;
    const onChain = instrument.issuer === 'bstocks' ? reading.multipliers.get(key) : undefined;
    const multiplier = onChain ? fromUnits(onChain.uiMultiplier, 18) : instrument.multiplier;
    const change = onChain
      ? upcomingMultiplierChange(
          multiplier,
          fromUnits(onChain.newUIMultiplier, 18),
          Number(onChain.effectiveAt),
          input.now,
        )
      : null;
    const tokens18 = to18(balance, instrument.decimals);
    const shares = sharesFromTokens(balance, instrument.decimals, multiplier);
    stocks.push({
      ticker: instrument.ticker,
      issuer: instrument.issuer,
      symbol: instrument.symbol,
      token: instrument.address,
      tokens: fromUnits(tokens18, 18),
      shares: formatShares(toUnits(truncateDecimal(shares, 18), 18)),
      multiplier,
      multiplierSource: onChain ? 'chain' : 'registry',
      pendingChange: change ? { to: change.to, effectiveAt: change.effectiveAt } : null,
      valueUsd:
        tape.state === 'UNAVAILABLE'
          ? null
          : valueOf(
              tokens18,
              tape.rows.find((r) => r.instrumentId === instrument.id),
            ),
    });
  }

  return {
    ...base,
    chain: {
      state: 'LIVE',
      blockNumber: reading.blockNumber.toString(),
      readAt: new Date(Number(reading.blockTime) * 1000).toISOString(),
    },
    stocks,
    unread,
    usdt: reading.usdt === null ? null : fromUnits(reading.usdt, 18),
    venus: !input.vToken
      ? { state: 'UNAVAILABLE', reason: 'Venus market not verified yet' }
      : reading.venus
        ? {
            state: 'LIVE',
            usdt: fromUnits(
              underlyingFromVTokens(reading.venus.vTokens, reading.venus.exchangeRate),
              18,
            ),
            vTokens: reading.venus.vTokens.toString(),
          }
        : { state: 'UNAVAILABLE', reason: 'Venus position not read' },
  };
}

/** GET /api/wallet, the /wallet page and the MCP tool: the chain read now, the plans on record. */
export async function walletView(
  db: Db,
  config: Config,
  address: string,
  now = new Date(),
): Promise<WalletView> {
  const [rows, venus, tape, planRows] = await Promise.all([
    listInstruments(db),
    readWorkerStatus(db, 'venus'),
    tapeView(db, now),
    listPlans(db, { walletAddress: address }),
  ]);
  const instruments = rows.map(instrumentFromRow);
  const vTokenValue = (venus?.value as { vToken?: unknown } | undefined)?.vToken;
  const vToken = typeof vTokenValue === 'string' ? vTokenValue : null;
  let reading: WalletReading | { error: string };
  try {
    reading = await webChain(config).readWallet(
      address,
      instruments.map((i) => ({ address: i.address, bstocks: i.issuer === 'bstocks' })),
      vToken,
    );
  } catch (error) {
    console.error('web: wallet read failed —', error instanceof Error ? error.message : error);
    reading = { error: 'BSC RPC did not answer' };
  }
  const plans = planRows.map((row): WalletPlan => {
    const plan = planFromRow(row);
    return {
      id: plan.id,
      mode: plan.mode,
      ticker: plan.target.type === 'ticker' ? plan.target.ticker : null,
      cadence: plan.cadence,
      window: plan.window,
      contributionUsd: plan.contributionUsd,
      status: plan.status,
      pausedReason: plan.pausedReason ?? null,
    };
  });
  return walletFromReading({ address, instruments, reading, vToken, tape, plans, now });
}
