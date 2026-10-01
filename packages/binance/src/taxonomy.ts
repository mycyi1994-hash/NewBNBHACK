/**
 * Error taxonomy v1 (SPEC §11, TASKS M1-07): what the agent does with each Binance Web3 API
 * failure, whether ops are alerted, and which copy key people see. Every code below comes from the
 * module's official error table (llms-full.txt § Error Codes; DECISIONS V-11) or from our own
 * measurement (noted). A code that is not here is `documented: false`: its first sighting is a DX
 * event, and the cycle fails safely until a human classifies it.
 */
import type { ErrorKind } from './errors.js';
import { isSuccess } from './metrics.js';
import type { ApiModule } from './modules.js';
import type { ApiCallRecord } from './telemetry.js';

export type ErrorAction =
  /** Transient: the same idempotent call again after a backoff. */
  | 'retry'
  /** The quote is stale or its route vanished: fetch a fresh quote. */
  | 'requote'
  /** This issuer cannot fill the order: try the next issuer in the plan's preference. */
  | 'next_issuer'
  /** The venue is closed: defer to the next open. */
  | 'market_closed'
  /** Price-impact protection tripped: re-quote a smaller amount. */
  | 'reduce_size'
  /** The Transaction API could not broadcast: send the same signed transaction by RPC. */
  | 'rpc_fallback'
  /** Nothing to do now: try again on a later tick. */
  | 'defer'
  /** Stop: the cycle fails with no funds moved. */
  | 'fail';

export type ErrorCategory =
  | 'request'
  | 'auth'
  | 'compliance'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'quote'
  | 'liquidity'
  | 'market'
  | 'swap'
  | 'broadcast'
  | 'defi'
  | 'unknown';

export interface ErrorClass {
  code: string | null;
  category: ErrorCategory;
  action: ErrorAction;
  /** Ops must act: our bug, keys, region or compliance, backend configuration, unknown codes. */
  alert: boolean;
  /** SPEC §11 copy key; null when the agent handles it without telling anyone. */
  userKey: string | null;
  /** Listed in the official tables or measured by us. */
  documented: boolean;
  meaning: string;
}

type Rule = Omit<ErrorClass, 'code' | 'documented'>;

const rule = (
  category: ErrorCategory,
  action: ErrorAction,
  alert: boolean,
  userKey: string | null,
  meaning: string,
): Rule => ({ category, action, alert, userKey, meaning });

const ourBug = (meaning: string) => rule('request', 'fail', true, 'err.internal', meaning);

/** Gateway codes, the same in every module (§ Authentication › Error Codes and each module page). */
const GATEWAY: Record<string, Rule> = {
  '40001': ourBug('invalid request parameters'),
  '40101': rule('auth', 'fail', true, 'err.internal', 'API key missing, invalid or disabled'),
  '40102': rule('auth', 'fail', true, 'err.internal', 'signature mismatch'),
  '40103': rule(
    'auth',
    'fail',
    true,
    'err.internal',
    'timestamp expired or request replayed (clock drift, or a signature sent twice)',
  ),
  '40104': rule('auth', 'fail', true, 'err.internal', 'API key lacks permission'),
  '40301': rule('compliance', 'fail', true, 'err.region', 'service not available in region'),
  '40302': rule('compliance', 'fail', true, 'err.region', 'proxy or VPN detected'),
  '40303': rule('compliance', 'fail', true, 'err.region', 'unusual IP activity (multi-region)'),
  '40304': rule('compliance', 'fail', true, 'err.region', 'compliance restriction'),
  '40311': rule('compliance', 'fail', true, 'err.trade', 'KYT: high-risk address'),
  '40312': rule('compliance', 'fail', true, 'err.trade', 'KYT: sanctioned address'),
  '40313': rule('compliance', 'fail', true, 'err.trade', 'KYT: risky fund origin'),
  '40314': rule('compliance', 'fail', true, 'err.trade', 'KYT: medium risk, needs confirmation'),
  '40411': ourBug('chain not supported'),
  '42900': rule('rate_limit', 'retry', false, null, 'rate limit exceeded'),
  '50000': rule('server', 'retry', false, 'err.internal', 'internal server error'),
  '50001': rule('server', 'retry', false, 'err.internal', 'service temporarily unavailable'),
};

/** Trading API business codes (§ Error Codes (Trading API)). */
const TRADING: Record<string, Rule> = {
  '40401': rule('quote', 'requote', false, null, 'quoteId expired (30 s TTL, measured 35 s)'),
  '40412': rule('request', 'fail', true, 'err.internal', 'DEX contract not configured (backend)'),
  '40421': rule(
    'liquidity',
    'next_issuer',
    false,
    'why.skipped.no_liquidity',
    'no liquidity for pair',
  ),
  '40432': rule('server', 'retry', false, 'err.internal', 'gas price estimate failed'),
  '40441': rule(
    'liquidity',
    'defer',
    false,
    'why.skipped.no_liquidity',
    'no vendor returned a quote',
  ),
  '40442': ourBug('from and to token are the same'),
  '40461': rule('swap', 'requote', false, null, 'no valid swap route for the quote'),
  '40462': ourBug('quoteId does not match the swap parameters'),
  '40463': rule(
    'swap',
    'reduce_size',
    false,
    'why.deferred.quote_impact',
    'price impact over protection',
  ),
  '40464': ourBug('slippagePercent out of range'),
  '40465': rule('swap', 'retry', false, 'err.trade', 'vendor swap build failed'),
  // Custom fee codes: we never send fee parameters, so any of these is our bug.
  '40466': ourBug('invalid feePercent'),
  '40467': ourBug('invalid referrer wallet address'),
  '40468': ourBug('two referrer addresses'),
  '40469': ourBug('referrer not activated (Solana)'),
  '40470': ourBug('tax token with same-side fee (Solana)'),
  // RFQ / equity token codes.
  '40365': rule(
    'liquidity',
    'next_issuer',
    false,
    'why.skipped.no_liquidity',
    'Ondo pair not supported',
  ),
  '40366': rule(
    'liquidity',
    'next_issuer',
    false,
    'why.skipped.no_liquidity',
    'over Ondo single-order limit',
  ),
  '40367': rule(
    'market',
    'market_closed',
    false,
    'why.deferred.market_closed',
    'Ondo market not tradable',
  ),
  '40368': ourBug('Ondo stablecoin pair invalid'),
  '40369': rule(
    'market',
    'market_closed',
    false,
    'why.deferred.market_closed',
    'bStock outside trading time',
  ),
  '40370': ourBug('bStock trading pair invalid'),
  '40374': rule(
    'liquidity',
    'next_issuer',
    false,
    'why.skipped.no_liquidity',
    'RWA token has no liquidity',
  ),
  // msg carries the minimum ("Minimum order amount is 5 USD." — $5.00 rejected, $5.01 accepted).
  '40375': rule(
    'liquidity',
    'next_issuer',
    false,
    'why.skipped.below_min',
    'under the Ondo minimum',
  ),
  // Only /order/submit (RFQ) returns it, and we never submit RFQ orders (Q-15).
  '42901': ourBug('RFQ order submit in progress'),
};

/** Transaction API business codes (§ Error Codes (Transaction API)). */
const TRANSACTION: Record<string, Rule> = {
  '40431': rule('broadcast', 'rpc_fallback', false, null, 'Transaction API broadcast failed'),
  '40434': rule('compliance', 'fail', true, 'err.trade', 'KYT check before broadcast failed'),
};

/** DeFi API codes (§ Error Codes (DeFi API)); 40484 measured on an unfunded wallet (Q-05). */
const DEFI: Record<string, Rule> = {
  '40434': rule('compliance', 'fail', true, 'err.trade', 'KYT verification failed'),
  '40450': ourBug('chain not supported for DeFi'),
  '40451': ourBug('investment invalid or not registered'),
  '40452': rule('defi', 'fail', true, 'err.trade', 'investment delisted'),
  '40453': ourBug('invalid DeFi request parameters'),
  '40454': ourBug('claim parameters do not match claim type'),
  '40455': rule('defi', 'fail', true, 'err.trade', 'health factor below threshold'),
  '40456': rule('defi', 'fail', true, 'err.trade', 'position not found for wallet'),
  '40457': rule('defi', 'fail', false, 'err.trade', 'no liquidity left to remove'),
  '40458': rule('defi', 'fail', false, 'err.trade', 'zap failed'),
  '40459': rule('defi', 'fail', true, 'err.trade', 'DeFi build failed (see msg)'),
  '40460': rule('defi', 'fail', false, 'why.failed.simulation', 'DeFi simulation reverted'),
  '40470': ourBug('DeFi resource not found (protocol or investment id)'),
  // The DeFi error page (10/1): "v1.0 returned 40470 for the same condition — v1.1 renumbers it to
  // 40490" (dx/LOG.md 2026-10-01 16:52). Both mean the same until 40470 is gone.
  '40490': ourBug('DeFi resource not found (protocol or investment id)'),
  '40480': rule('defi', 'fail', false, 'why.failed.simulation', 'insufficient balance'),
  '40481': rule('defi', 'defer', false, 'err.trade', 'DeFi action temporarily unavailable'),
  '40482': rule('server', 'retry', false, 'err.internal', 'blockchain RPC error'),
  '40483': rule('server', 'retry', false, 'err.internal', 'DeFi service internal error'),
  '40484': rule('defi', 'fail', false, 'why.failed.simulation', 'preview simulation reverted'),
  '40485': rule('defi', 'fail', false, 'why.failed.simulation', 'redeem exceeds position'),
};

const BY_MODULE: Partial<Record<ApiModule, Record<string, Rule>>> = {
  trading: TRADING,
  transaction: TRANSACTION,
  'defi-data': DEFI,
  'defi-transaction': DEFI,
};

export interface ClassifiableError {
  kind: ErrorKind;
  module: ApiModule;
  httpStatus: number | null;
  code: number | string | null;
}

/** Codes with a meaning of their own in this module (not the shared gateway codes). */
export function moduleCodes(module: ApiModule): string[] {
  return Object.keys(BY_MODULE[module] ?? {}).sort();
}

/** The documented codes of a module (gateway codes included), for docs and tests. */
export function documentedCodes(module: ApiModule): string[] {
  return [...Object.keys(GATEWAY), ...Object.keys(BY_MODULE[module] ?? {})].sort();
}

export function classifyError(error: ClassifiableError): ErrorClass {
  const code = error.code === null ? null : String(error.code);
  const known = code === null ? undefined : (BY_MODULE[error.module]?.[code] ?? GATEWAY[code]);
  if (known) return { code, documented: true, ...known };
  if (error.httpStatus === 429) {
    return { code, documented: true, ...rule('rate_limit', 'retry', false, null, 'HTTP 429') };
  }
  // No response at all, or a request we could not build: nothing the server documented or not.
  if (error.kind === 'network' || error.kind === 'timeout') {
    const meaning = `${error.kind}: no response`;
    return { code, documented: true, ...rule('network', 'retry', false, 'err.internal', meaning) };
  }
  if (error.kind === 'config') {
    return { code, documented: true, ...ourBug('request could not be built (configuration)') };
  }
  if (code === null && error.httpStatus !== null && error.httpStatus >= 500) {
    const meaning = `HTTP ${error.httpStatus} without an envelope`;
    return { code, documented: true, ...rule('server', 'retry', false, 'err.internal', meaning) };
  }
  // The docs promise an envelope with a known code; anything else is a DX finding.
  if (code === null) {
    const meaning =
      error.kind === 'transport'
        ? 'a 2xx that is not an envelope (WAF challenge or HTML)'
        : `HTTP ${error.httpStatus ?? '-'} without an envelope code`;
    return { code, documented: false, ...rule('unknown', 'defer', true, 'err.internal', meaning) };
  }
  const meaning = `code ${code} is not in the ${error.module} error table`;
  return { code, documented: false, ...rule('unknown', 'fail', true, 'err.internal', meaning) };
}

/** Transient failures worth an immediate retry of an idempotent call. */
export function isTransient(error: ClassifiableError): boolean {
  return classifyError(error).action === 'retry';
}

/**
 * The venue minimum in a 40375 message ("Minimum order amount is 5 USD." → "5"). The venue rejects
 * exactly the minimum (measured: $5.00 rejected, $5.01 accepted), so callers must exceed it.
 */
export function venueMinimumUsd(msg: string): string | undefined {
  return /minimum order amount is\s+(\d+(?:\.\d+)?)\s*usd/i.exec(msg)?.[1];
}

export type DxFindingKind = 'unknown_code' | 'undocumented_shape';

/**
 * What one api_calls record is worth to the DX log (SPEC §10): an error code the module's table
 * does not list, or an error response without the documented envelope. Successes, rate limits and
 * no-response failures are not findings.
 */
export function dxFindingOf(
  record: ApiCallRecord,
): { kind: DxFindingKind; meaning: string } | undefined {
  if (record.httpStatus === null || isSuccess(record)) return undefined;
  const kind: ErrorKind =
    record.code !== null ? 'api' : record.httpStatus < 300 ? 'transport' : 'http';
  const verdict = classifyError({
    kind,
    module: record.module,
    httpStatus: record.httpStatus,
    code: record.code,
  });
  if (verdict.documented) return undefined;
  return {
    kind: record.code === null ? 'undocumented_shape' : 'unknown_code',
    meaning: verdict.meaning,
  };
}
