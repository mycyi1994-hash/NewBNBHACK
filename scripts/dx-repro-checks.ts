/**
 * The checks behind `pnpm dx:repro` (dx/findings): each takes what a platform answered and says
 * whether a finding in dx/LOG.md still reproduces, with the observation in one line. Pure, so each
 * is tested against the responses recorded in fixtures/ (dx-repro-checks.test.ts).
 */
import { decodeFunctionData, maxUint256, parseAbi, type Hex } from 'viem';

export interface Verdict {
  reproduced: boolean;
  observed: string;
}

/** 2026-09-23 17:44: the docs host answers a non-browser client with a WAF challenge, not the file. */
export function wafChallenge(res: {
  status: number;
  wafAction: string | null;
  bodyBytes: number;
}): Verdict {
  return {
    reproduced: res.status === 202 && res.wafAction === 'challenge' && res.bodyBytes === 0,
    observed: `HTTP ${res.status}, x-amzn-waf-action ${res.wafAction ?? '(none)'}, ${res.bodyBytes} bytes`,
  };
}

export interface PublicRwaEntry {
  chainId?: string;
  contractAddress?: string;
  symbol?: string;
  ticker?: string;
}

/** 2026-10-01 06:04: the public RWA list repeats each ticker once per chain, Ethereum first. */
export function tickersRepeatPerChain(
  entries: readonly PublicRwaEntry[],
  ticker = 'NVDA',
): Verdict {
  const perChain = new Map<string, number>();
  const tickers = new Map<string, number>();
  for (const e of entries) {
    const chain = e.chainId ?? '?';
    perChain.set(chain, (perChain.get(chain) ?? 0) + 1);
    if (e.ticker) tickers.set(e.ticker, (tickers.get(e.ticker) ?? 0) + 1);
  }
  const repeated = [...tickers.values()].filter((n) => n > 1).length;
  const order = entries.filter((e) => e.ticker === ticker).map((e) => e.chainId ?? '?');
  const chains = [...perChain.entries()].map(([chain, n]) => `"${chain}" ${n}`).join(', ');
  return {
    reproduced: repeated > 0 && order.length > 1 && order[0] !== '56',
    observed: `${entries.length} entries for ${tickers.size} tickers (${chains}); ${repeated} tickers repeat; ${ticker} in order: ${order.join(' → ') || 'absent'}`,
  };
}

/** 2026-10-01 06:19: `baw wallet status --json` says success while signed out. */
export function signedOutLooksSuccessful(output: unknown): Verdict {
  const o = output as { success?: unknown; data?: { status?: unknown } } | null;
  const success = o?.success;
  const status = o?.data?.status;
  return {
    reproduced: success === true && status === 'UNCONNECTED',
    observed: `success ${String(success)}, data.status ${String(status)}`,
  };
}

/** 2026-09-30 02:10: a public BSC RPC refuses eth_getLogs over a few hundred blocks. */
export function logRangeRefused(
  blocks: number,
  answer: { error?: { code?: number; message?: string }; resultCount?: number },
): Verdict {
  return {
    reproduced: answer.error !== undefined,
    observed: answer.error
      ? `${blocks} blocks → error ${answer.error.code ?? '?'} "${answer.error.message ?? ''}"`
      : `${blocks} blocks → ${answer.resultCount ?? 0} logs`,
  };
}

/** A Binance Web3 API answer reduced to what the checks need. */
export interface ApiAnswer {
  ok: boolean;
  httpStatus: number | null;
  code: number | null;
  msg: string;
}

const describe = (a: ApiAnswer) =>
  `${a.httpStatus === null ? 'no response' : `HTTP ${a.httpStatus}`} code ${a.code ?? '-'} "${a.msg}"`;

/** 2026-09-24 00:52 (a measurement; the docs match): a quoteId used 35 s later is gone (40401). */
export function quoteExpired(ageSeconds: number, swap: ApiAnswer): Verdict {
  return {
    reproduced: !swap.ok && swap.code === 40401,
    observed: `/swap ${ageSeconds} s after the quote → ${describe(swap)}`,
  };
}

/** 2026-09-24 00:49: no balance and no position both answer 40484, with different messages. */
export function oneCodeTwoCauses(deposit: ApiAnswer, redeem: ApiAnswer): Verdict {
  return {
    reproduced:
      deposit.code === 40484 && redeem.code === 40484 && deposit.msg.trim() !== redeem.msg.trim(),
    observed: `deposit (no balance) → ${describe(deposit)}; redeem (no position) → ${describe(redeem)}`,
  };
}

const approveAbi = parseAbi(['function approve(address spender, uint256 amount)']);

/** 2026-09-23 18:00 / 09-24 00:49: the DeFi deposit build's APPROVE is for type(uint256).max. */
export function approvesUnlimited(build: {
  dataList?: readonly { callDataType?: string; data?: string; to?: string }[];
}): Verdict {
  const approve = build.dataList?.find((i) => i.callDataType === 'APPROVE');
  if (!approve?.data) {
    return { reproduced: false, observed: 'no APPROVE item in dataList' };
  }
  const { args } = decodeFunctionData({ abi: approveAbi, data: approve.data as Hex });
  const amount = args[1];
  return {
    reproduced: amount === maxUint256,
    observed: `APPROVE ${approve.to ?? '?'}: approve(${args[0]}, ${amount === maxUint256 ? 'type(uint256).max' : amount.toString()})`,
  };
}

/** 2026-09-24 00:55: referencePrice is tokenPrice ÷ tokenToShareRatio, not an independent price. */
export function referenceIsDerived(
  rows: readonly {
    symbol: string;
    tokenPrice: string | null;
    referencePrice: string | null;
    ratio: string | null;
  }[],
): Verdict {
  const errors: number[] = [];
  for (const r of rows) {
    if (!r.tokenPrice || !r.referencePrice || !r.ratio) continue;
    const derived = Number(r.tokenPrice) / Number(r.ratio);
    errors.push(Math.abs(derived - Number(r.referencePrice)) / Number(r.referencePrice));
  }
  const worst = errors.length ? Math.max(...errors) : NaN;
  return {
    reproduced: errors.length > 0 && worst <= 1e-6,
    observed: `${errors.length} tokens compared; worst |tokenPrice ÷ ratio − referencePrice| ÷ referencePrice = ${Number.isNaN(worst) ? 'n/a' : worst.toExponential(2)}`,
  };
}

/** 2026-09-24 00:46: a $5 quote for an Ondo token is refused as below a 5 USD minimum (40375). */
export function ondoMinimum(quote: ApiAnswer): Verdict {
  return {
    reproduced: !quote.ok && quote.code === 40375,
    observed: `$5 USDT → Ondo quote: ${quote.ok ? 'answered with a route' : describe(quote)}`,
  };
}

/**
 * 2026-09-24 01:52: a client that keeps to "5 RPS per endpoint" with a token bucket still meets
 * 429, because the gateway counts the last 1,000 ms. Five requests go out within ~260 ms and a
 * sixth at ~450 ms, when a 5-per-second bucket would have refilled two tokens: a 429 on the sixth
 * reproduces the finding.
 */
export function slidingWindow429(
  attempts: readonly { httpStatus: number | null; atMs: number }[],
): Verdict {
  const first = attempts[0]?.atMs ?? 0;
  const sixth = attempts[5];
  const timeline = attempts
    .map((a) => `${a.atMs - first} ms ${a.httpStatus ?? 'no response'}`)
    .join(', ');
  return {
    reproduced: sixth !== undefined && sixth.httpStatus === 429 && sixth.atMs - first < 1_000,
    observed: `quote burst: ${timeline || 'no attempts'}`,
  };
}
