/**
 * API modules as grouped in llms-full.txt § API Reference. Used for api_calls.module, the
 * fixture directory, the envelope flavour, and shared rate-limit groups.
 */
export const API_MODULES = [
  'market', // General Data
  'portfolio', // Address Portfolio
  'rwa', // RWA Data
  'trading', // Trading API
  'transaction', // Transaction API
  'wallet', // Wallet API
  'defi-data', // Defi Data
  'defi-transaction', // Defi Transaction
  'b402', // B402 Payments
  'websocket', // WebSocket API (REST token endpoint)
] as const;

export type ApiModule = (typeof API_MODULES)[number];

export type EnvelopeFlavour = 'oc' | 'b402';

/** B402 answers with {status, type, code: string, …}; everything else with OCResult<T>. */
export function envelopeFlavour(module: ApiModule): EnvelopeFlavour {
  return module === 'b402' ? 'b402' : 'oc';
}

/**
 * "All DeFi API endpoints share a default rate limit of 5 QPS"
 * (llms-full.txt § DeFi Introduction › Rate Limits), so they also draw from one group bucket.
 */
export function rateLimitGroup(module: ApiModule): string | undefined {
  return module === 'defi-data' || module === 'defi-transaction' ? 'defi' : undefined;
}
