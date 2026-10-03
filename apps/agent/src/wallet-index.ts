/**
 * The Wallet API in the worker (DECISIONS D-34). Two reads beside the chain, once per tick:
 * - the official flow's last step — the status of a broadcast transaction
 *   (transaction-detail-by-txhash) — recorded on each receipt after its BSC receipt settled it;
 * - the house balances through token-balances-by-address, next to the RPC read.
 * Read-only and best-effort: never in the signing path; a failure is logged (and kept in api_calls)
 * and asked again on a later tick, never a tick error. The chain stays the record: an answer that
 * disagrees is shown as a disagreement and logged as DX evidence, never used for a decision.
 */
import { getTokenBalances, getTransactionDetail } from '@yieldvest/binance';
import { BSC_USDT } from '@yieldvest/chain';
import {
  receiptsToIndex,
  recordReceiptIndex,
  writeWorkerStatus,
  type ReceiptIndex,
} from '@yieldvest/db';
import type { CycleDeps } from './cycle.js';

/** Receipts are asked about for a day: indexing lags a broadcast by seconds, not hours. */
export const INDEX_WINDOW_MS = 24 * 3_600_000;
/** At most this many receipts per tick: the API's own limit is 5 a second per endpoint. */
export const INDEX_PER_TICK = 5;

type Deps = Pick<CycleDeps, 'client' | 'db' | 'house' | 'log' | 'now'>;

const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/** Asks the Wallet API about the receipts it has not reported final yet; returns how many. */
export async function indexReceipts(deps: Deps): Promise<{ asked: number; recorded: number }> {
  const now = deps.now();
  const rows = await receiptsToIndex(
    deps.db,
    new Date(now.getTime() - INDEX_WINDOW_MS),
    INDEX_PER_TICK,
  );
  let recorded = 0;
  for (const row of rows) {
    let detail;
    try {
      detail = await getTransactionDetail(deps.client, row.txHash);
    } catch (error) {
      deps.log(`wallet api: transaction detail of ${row.txHash} not read — ${reason(error)}`);
      continue;
    }
    const previous = row.indexed as ReceiptIndex | null;
    const index: ReceiptIndex =
      detail === null
        ? {
            state: 'not_indexed',
            tries: (previous?.state === 'not_indexed' ? previous.tries : 0) + 1,
            checkedAt: now.toISOString(),
          }
        : {
            state: 'indexed',
            txStatus: detail.txStatus,
            txFee: detail.txFee,
            height: detail.height,
            agrees:
              detail.txStatus === 'pending'
                ? null
                : (detail.txStatus === 'success') === (row.status === 'success'),
            checkedAt: now.toISOString(),
          };
    if (index.state === 'indexed' && index.agrees === false) {
      deps.log(
        `wallet api: ${row.txHash} is "${index.txStatus}" in the Wallet API but "${row.status}" by its BSC receipt — the receipt stays the record`,
      );
    }
    await recordReceiptIndex(deps.db, row.txHash, index);
    recorded += 1;
  }
  return { asked: rows.length, recorded };
}

/**
 * The house's USDT and BNB through the Wallet API, written beside the RPC read it is compared with
 * (worker_status `house_index`); `rpc` is that tick's chain read, or undefined when it failed.
 */
export async function houseViaWalletApi(
  deps: Deps,
  rpc: { usdt: bigint; bnb: bigint } | undefined,
): Promise<void> {
  const at = deps.now().toISOString();
  try {
    const balances = await getTokenBalances(deps.client, {
      address: deps.house,
      tokens: [BSC_USDT, ''],
    });
    const raw = (token: string) =>
      balances.find((b) => b.tokenContractAddress.toLowerCase() === token.toLowerCase())
        ?.rawBalance ?? null;
    const usdt = raw(BSC_USDT);
    const bnb = raw('');
    const agrees = (units: string | null, chain: bigint | undefined) =>
      units === null || chain === undefined ? null : BigInt(units) === chain;
    const value = {
      usdtUnits: usdt,
      bnbWei: bnb,
      agrees: { usdt: agrees(usdt, rpc?.usdt), bnb: agrees(bnb, rpc?.bnb) },
      at,
    };
    if (value.agrees.usdt === false || value.agrees.bnb === false) {
      deps.log(
        `wallet api: house balances differ from the chain (usdt ${String(value.agrees.usdt)}, bnb ${String(value.agrees.bnb)}) — the chain stays the record`,
      );
    }
    await writeWorkerStatus(deps.db, 'house_index', value);
  } catch (error) {
    deps.log(`wallet api: house balances not read — ${reason(error)}`);
    await writeWorkerStatus(deps.db, 'house_index', { error: 'not read', at });
  }
}
