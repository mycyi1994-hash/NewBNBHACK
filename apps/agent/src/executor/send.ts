/**
 * Sending one signed transaction (SPEC §5.8 v2, DECISIONS D-13). The order is fixed:
 *   nonce → sign → tx_outbox SIGNED → broadcast (Transaction API, RPC fallback) → PENDING →
 *   receipt → CONFIRMED | FAILED.
 * The signed bytes are recorded before they leave, so a worker that dies mid-way reconciles the
 * same transaction at boot instead of signing a second one. A receipt that does not arrive in time
 * leaves the row PENDING — never FAILED — so the same buy is never sent twice.
 */
import { BinanceApiError, broadcastSigned } from '@yieldvest/binance';
import type { BinanceClient } from '@yieldvest/binance';
import { BSC_CHAIN_ID, signableTx } from '@yieldvest/chain';
import {
  isoTime,
  lastOutboxNonce,
  markOutbox,
  recordSigned,
  unsettledOutbox,
  type Db,
} from '@yieldvest/db';
import { keccak256, type Hex } from 'viem';
import type { ChainPort, ReceiptLike } from './chain-port.js';
import type { Signer } from './signer.js';

/** SPEC §5.8: poll the receipt for at most three minutes. */
export const RECEIPT_TIMEOUT_MS = 180_000;

export interface SendDeps {
  client: BinanceClient;
  chain: ChainPort;
  db: Db;
  signer: Signer;
  log: (line: string) => void;
}

export interface SendRequest {
  planId: string;
  cycleId: number | null;
  kind: 'approve' | 'swap' | 'deposit' | 'redeem';
  to: string;
  data: string;
  value: bigint;
  gas: bigint;
  gasPrice: bigint;
  maxPriorityFeePerGas?: bigint;
}

export type SendResult =
  | { state: 'confirmed'; txHash: Hex; broadcastVia: string; receipt: ReceiptLike }
  /** Mined with status 0: only gas was spent. */
  | { state: 'reverted'; txHash: Hex; broadcastVia: string; receipt: ReceiptLike }
  /** Broadcast, not mined within the timeout: the outbox row stays PENDING. */
  | { state: 'pending'; txHash: Hex; broadcastVia: string }
  /** Refused by both broadcast paths: nothing left the wallet. */
  | { state: 'not_sent'; txHash: Hex; reason: string };

/** Another signed transaction of this wallet is not settled yet; nothing new may be signed. */
export class OutboxBusyError extends Error {
  constructor(readonly pending: string[]) {
    super(`unsettled outbox transactions: ${pending.join(', ')}`);
    this.name = 'OutboxBusyError';
  }
}

/** The RPC answer for bytes the node already has: the first broadcast did go out. */
const ALREADY_KNOWN = /already known|known transaction|nonce too low/i;
/**
 * RPC answers that reject the bytes themselves: no node would accept them, so they cannot have
 * gone out through the Transaction API either. Any other failure (timeout, network) is unclear.
 */
const INVALID_TX =
  /insufficient funds|intrinsic gas|exceeds block gas limit|invalid sender|invalid signature/i;
/**
 * RPC answers about this node's own policy (its minimum gas price, its fee cap) or about a
 * transaction it already holds with the same nonce ("replacement transaction underpriced" — very
 * likely ours, relayed by the Transaction API). Definite only when the Transaction API itself
 * answered: after its timeout or gateway error the bytes may well have gone out there.
 */
const NODE_POLICY = /underpriced|exceeds the configured cap/i;
/**
 * A used nonce with no receipt for ours, or swap bytes the node lost, is put to a human after this
 * long (RUNBOOK §3.4). Until then it may be a node that has not indexed ours yet.
 */
export const HUMAN_CHECK_AFTER_MS = 30 * 60_000;
/** Signed swap bytes are sent again only while their quote could still be current. */
export const SWAP_REBROADCAST_MAX_MS = 10 * 60_000;

type Broadcast =
  | { ok: true; via: string }
  /** `definite`: the bytes certainly did not go out; otherwise they may have (a timeout). */
  | { ok: false; reason: string; definite: boolean };

async function broadcast(deps: SendDeps, raw: Hex, txHash: Hex): Promise<Broadcast> {
  try {
    const res = await broadcastSigned(deps.client, {
      address: deps.signer.address,
      signedTransaction: raw,
    });
    if (res.txHash.toLowerCase() !== txHash.toLowerCase()) {
      deps.log(
        `send: Transaction API returned hash ${res.txHash}, ours is ${txHash} (tracking ours)`,
      );
    }
    return { ok: true, via: 'transaction_api' };
  } catch (error) {
    if (!(error instanceof BinanceApiError)) throw error;
    // A compliance refusal (KYT, region) is final: the RPC path must not route around it. Any
    // other failure — 40431, a timeout, a gateway error — sends the same bytes by RPC (D-13).
    if (error.classify().category === 'compliance') {
      return {
        ok: false,
        reason: `Transaction API refused: ${error.code ?? error.kind} ${error.msg}`,
        definite: true,
      };
    }
    deps.log(`send: Transaction API broadcast failed (${error.code ?? error.kind}); trying RPC`);
    // Whether the Transaction API answered at all (an error envelope) — or may have relayed the
    // bytes before failing (no response, a gateway page).
    return broadcastByRpc(deps, raw, error.kind === 'api');
  }
}

async function broadcastByRpc(deps: SendDeps, raw: Hex, apiAnswered: boolean): Promise<Broadcast> {
  try {
    await deps.chain.sendRaw(raw);
    return { ok: true, via: 'rpc' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ALREADY_KNOWN.test(message)) return { ok: true, via: 'transaction_api' };
    return {
      ok: false,
      reason: `RPC refused: ${message.split('\n')[0] ?? message}`,
      definite: INVALID_TX.test(message) || (apiAnswered && NODE_POLICY.test(message)),
    };
  }
}

export async function sendTransaction(deps: SendDeps, req: SendRequest): Promise<SendResult> {
  const from = deps.signer.address;
  const unsettled = (await unsettledOutbox(deps.db)).filter(
    (row) => row.fromAddress.toLowerCase() === from.toLowerCase(),
  );
  if (unsettled.length > 0) throw new OutboxBusyError(unsettled.map((row) => row.txHash));

  const nonce = await deps.chain.pendingNonce(from);
  const recorded = await lastOutboxNonce(deps.db, BSC_CHAIN_ID, from);
  if (recorded !== undefined && nonce <= recorded) {
    // The node has not seen a transaction we recorded as settled: never reuse its nonce.
    throw new Error(`chain nonce ${nonce} is not above the last recorded nonce ${recorded}`);
  }
  const raw = await deps.signer.sign(
    signableTx({
      to: req.to,
      data: req.data,
      value: req.value,
      gas: req.gas,
      gasPrice: req.gasPrice,
      nonce,
      ...(req.maxPriorityFeePerGas === undefined
        ? {}
        : { maxPriorityFeePerGas: req.maxPriorityFeePerGas }),
    }),
  );
  const txHash = keccak256(raw);
  await recordSigned(deps.db, {
    planId: req.planId,
    cycleId: req.cycleId,
    kind: req.kind,
    chainId: BSC_CHAIN_ID,
    fromAddress: from,
    nonce,
    rawTx: raw,
    txHash,
  });
  deps.log(`send: ${req.kind} signed, nonce ${nonce}, ${txHash}`);

  let sent: Broadcast;
  try {
    sent = await broadcast(deps, raw, txHash);
  } catch (error) {
    // Anything unexpected after signing (a response without a hash, a thrown RPC client) leaves
    // it unclear whether the bytes went out: track them, never report "not sent".
    const reason = error instanceof Error ? error.message : String(error);
    sent = { ok: false, reason: `broadcast: ${reason.split('\n')[0] ?? reason}`, definite: false };
  }
  if (!sent.ok) {
    if (sent.definite) {
      await markOutbox(deps.db, txHash, { status: 'FAILED', error: sent.reason, attempted: true });
      return { state: 'not_sent', txHash, reason: sent.reason };
    }
    await markOutbox(deps.db, txHash, {
      status: 'PENDING',
      broadcastVia: 'unknown',
      error: sent.reason,
      attempted: true,
    });
    deps.log(`send: ${txHash} may or may not have gone out (${sent.reason}) — left PENDING`);
    return { state: 'pending', txHash, broadcastVia: 'unknown' };
  }
  await markOutbox(deps.db, txHash, { status: 'PENDING', broadcastVia: sent.via, attempted: true });
  return settle(deps, txHash, sent.via, RECEIPT_TIMEOUT_MS);
}

/** Waits for a broadcast transaction and records how it ended (also used at boot). */
export async function settle(
  deps: Pick<SendDeps, 'chain' | 'db' | 'log'>,
  txHash: Hex,
  broadcastVia: string,
  timeoutMs: number,
): Promise<SendResult> {
  let receipt: ReceiptLike | undefined;
  try {
    receipt = await deps.chain.waitForReceipt(txHash, timeoutMs);
  } catch (error) {
    // An RPC error while waiting says nothing about the transaction: it stays PENDING.
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    deps.log(`send: waiting for ${txHash} failed (${reason}) — left PENDING`);
    return { state: 'pending', txHash, broadcastVia };
  }
  if (!receipt) {
    deps.log(`send: ${txHash} not mined within ${timeoutMs / 1000} s — left PENDING`);
    return { state: 'pending', txHash, broadcastVia };
  }
  if (receipt.status === 'success') {
    await markOutbox(deps.db, txHash, { status: 'CONFIRMED' });
    return { state: 'confirmed', txHash, broadcastVia, receipt };
  }
  await markOutbox(deps.db, txHash, { status: 'FAILED', error: 'receipt status 0 (reverted)' });
  return { state: 'reverted', txHash, broadcastVia, receipt };
}

export interface Reconciliation {
  confirmed: string[];
  failed: string[];
  /** Still waiting: in the mempool, or sent again and not mined yet. */
  pending: string[];
  rebroadcast: string[];
  /** Pending rows only a human can settle (RUNBOOK §3.4); they keep new signing blocked. */
  needsHuman: { txHash: string; reason: string }[];
}

/**
 * Boot reconciliation (SPEC §5.8 v2): every SIGNED or PENDING row is settled against the chain
 * before a new cycle opens. A mined transaction gets its receipt's status; bytes the node does not
 * know (a crash before the broadcast, a dropped transaction) are sent again unchanged, except swap
 * bytes whose quote went stale. A row is never marked FAILED on a guess: a nonce used with no
 * receipt for ours, or a stale swap, stays PENDING and goes to a human (SPEC §5.8, RUNBOOK §3.4).
 */
export async function reconcileOutbox(
  deps: Pick<SendDeps, 'chain' | 'db' | 'log'>,
  options: { from: string; waitMs?: number },
): Promise<Reconciliation> {
  const result: Reconciliation = {
    confirmed: [],
    failed: [],
    pending: [],
    rebroadcast: [],
    needsHuman: [],
  };
  const own = (await unsettledOutbox(deps.db)).filter(
    (row) => row.fromAddress.toLowerCase() === options.from.toLowerCase(),
  );
  for (const row of own) {
    const hash = row.txHash as Hex;
    const age = Date.now() - Date.parse(isoTime(row.createdAt));
    const mined = await deps.chain.receipt(hash);
    if (mined) {
      const ok = mined.status === 'success';
      await markOutbox(
        deps.db,
        hash,
        ok ? { status: 'CONFIRMED' } : { status: 'FAILED', error: 'receipt status 0 (reverted)' },
      );
      (ok ? result.confirmed : result.failed).push(hash);
      continue;
    }
    if ((await deps.chain.minedNonce(row.fromAddress)) > row.nonce) {
      // The nonce is used — by ours, mined between the two reads, or by another transaction.
      const late = await deps.chain.receipt(hash);
      if (late) {
        const ok = late.status === 'success';
        await markOutbox(
          deps.db,
          hash,
          ok ? { status: 'CONFIRMED' } : { status: 'FAILED', error: 'receipt status 0 (reverted)' },
        );
        (ok ? result.confirmed : result.failed).push(hash);
        continue;
      }
      // No receipt for ours: a node that has not indexed it yet, or a transaction signed with
      // this key somewhere else. Calling ours failed on a guess could book a mined buy as never
      // sent (and buy again), so it stays PENDING; after a while a human looks.
      result.pending.push(hash);
      if (age >= HUMAN_CHECK_AFTER_MS) {
        result.needsHuman.push({
          txHash: hash,
          reason: `nonce ${row.nonce} is used on chain, but no receipt for this transaction`,
        });
      }
      continue;
    }
    const unknownToNode = (await deps.chain.pendingNonce(row.fromAddress)) <= row.nonce;
    if (unknownToNode && row.kind === 'swap' && age > SWAP_REBROADCAST_MAX_MS) {
      // Swap bytes the node lost after their quote went stale are not sent again: a human decides
      // (RUNBOOK §3.4). The row stays PENDING, so nothing new is signed meanwhile.
      deps.log(`reconcile: ${hash} (swap) is no longer known to the node and too old to resend`);
      result.pending.push(hash);
      result.needsHuman.push({
        txHash: hash,
        reason: 'swap no longer known to the node; its quote is too old to send it again',
      });
      continue;
    }
    if (unknownToNode) {
      try {
        await deps.chain.sendRaw(row.rawTx as Hex);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!ALREADY_KNOWN.test(message))
          deps.log(`reconcile: resend of ${hash} refused — ${message}`);
      }
      await markOutbox(deps.db, hash, {
        status: 'PENDING',
        broadcastVia: row.broadcastVia ?? 'rpc',
        attempted: true,
      });
      result.rebroadcast.push(hash);
    } else if (row.status === 'SIGNED') {
      await markOutbox(deps.db, hash, { status: 'PENDING', broadcastVia: 'unknown' });
    }
    const settled = await settle(deps, hash, row.broadcastVia ?? 'rpc', options.waitMs ?? 30_000);
    if (settled.state === 'confirmed') result.confirmed.push(hash);
    else if (settled.state === 'reverted') result.failed.push(hash);
    else result.pending.push(hash);
  }
  if (result.confirmed.length + result.failed.length + result.pending.length > 0) {
    deps.log(
      `reconcile: ${result.confirmed.length} confirmed, ${result.failed.length} failed, ` +
        `${result.pending.length} pending, ${result.rebroadcast.length} sent again`,
    );
  }
  return result;
}
