// The browser's side of sharing: the server's list of shared agents, publishing and stopping, counting a hire,
// each shared agent's backtest (run here, on the same candles and code as every other agent), and the two vault
// calls a creator fee needs: reading what the owner approved, and approving it from the owner's own wallet.
import { useCallback, useEffect, useState } from 'react';
import { decodeFunctionResult, encodeFunctionData, keccak256, parseUnits, stringToHex } from 'viem';
import * as cex from './cex.ts';
import { scoreMadeLive, type Agent } from './agents.ts';
import { authHeaders, chainCall, sendTx, useSession, type Net } from './account.ts';
import { SHARED_PREFIX, type SharedAgent, type SharedTag } from './share.ts';
import type { MadeSpec } from './spec.ts';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) });

export async function listShared(): Promise<SharedAgent[]> {
  const r = await fetch('/api/shared');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { agents: SharedAgent[] }).agents;
}
/** One shared agent (also one its creator stopped sharing), or null when there is none with this id. */
export async function getShared(id: string): Promise<SharedAgent | null> {
  const r = await fetch(`/api/shared/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { agent: SharedAgent }).agent;
}

export type Fees = { state: 'ok'; totalUsdt: string; payments: number; vaults: number; fromBlock: string } | { state: 'unavailable'; reason: 'demo' | 'chain'; detail?: string };
export async function mineShared(): Promise<{ agents: SharedAgent[] } | null> {
  const r = await fetch('/api/shared/mine', { headers: authHeaders() });
  return r.ok ? ((await r.json()) as { agents: SharedAgent[] }) : null;
}
/** What the vaults have paid this wallet, read from the chain by the server. */
export async function feesShared(): Promise<Fees> {
  try {
    const r = await fetch('/api/shared/fees', { headers: authHeaders() });
    return r.ok ? ((await r.json()) as { fees: Fees }).fees : { state: 'unavailable', reason: 'chain', detail: `HTTP ${r.status}` };
  } catch (e) { return { state: 'unavailable', reason: 'chain', detail: e instanceof Error ? e.message : String(e) }; }
}

export type PublishWhy = 'invalid' | 'fee' | 'tooMany' | 'tooManyEver' | 'login' | 'failed';
export async function publishShared(spec: MadeSpec, feeBps: number, nick: string): Promise<{ ok: true; agent: SharedAgent } | { ok: false; why: PublishWhy }> {
  try {
    const r = await fetch('/api/shared', json({ spec, feeBps, nick }));
    const j = (await r.json().catch(() => null)) as { ok?: boolean; agent?: SharedAgent; why?: PublishWhy } | null;
    if (r.ok && j?.agent) return { ok: true, agent: j.agent };
    return { ok: false, why: r.status === 401 ? 'login' : j?.why ?? 'failed' };
  } catch { return { ok: false, why: 'failed' }; }
}
export async function unpublishShared(id: string): Promise<boolean> {
  try { return (await fetch('/api/shared/unpublish', json({ id }))).ok; } catch { return false; }
}
/** Tell the server this wallet hired it. Only a logged-in wallet counts; the server counts each wallet once. */
export async function countHire(id: string): Promise<void> {
  try { await fetch('/api/shared/hire', json({ id })); } catch { /* the count is the server's; nothing to do here */ }
}

export const tagOf = (s: SharedAgent): SharedTag => ({ id: s.id, creator: s.creator, ...(s.nick ? { nick: s.nick } : {}), feeBps: s.feeBps, hires: s.hires, ...(s.removedAt ? { removedAt: s.removedAt } : {}) });
/** A shared agent with its backtest, run in this browser exactly as for any made agent. Null when its candles do not load. */
export async function scoreShared(s: SharedAgent): Promise<Agent | null> {
  const m = cex.MARKETS.find((x) => x.symbol === s.spec.market);
  if (!m) return null;
  const a = await scoreMadeLive(s.spec, m);
  return a && { ...a, id: SHARED_PREFIX + s.id, shared: tagOf(s) };
}

export type Scored = { s: SharedAgent; a: Agent | null | 'fail' | undefined };
/** The shared agents and their backtests as they come in. `list` is null while loading and 'fail' when the server did not answer. */
export function useShared() {
  const [list, setList] = useState<Scored[] | null | 'fail'>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setList(null);
    listShared().then((xs) => {
      if (!alive) return;
      setList(xs.map((s) => ({ s, a: undefined })));
      for (const s of xs) scoreShared(s).then((a) => alive && setList((cur) => (Array.isArray(cur) ? cur.map((x) => (x.s.id === s.id ? { s, a } : x)) : cur)), () => alive && setList((cur) => (Array.isArray(cur) ? cur.map((x) => (x.s.id === s.id ? { s, a: 'fail' } : x)) : cur)));
    }, () => alive && setList('fail'));
    return () => { alive = false; };
  }, [n]);
  return { list, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** The wallet's own shared agents. Null while loading or logged out. */
export function useMineShared() {
  const s = useSession();
  const [v, setV] = useState<{ agents: SharedAgent[] } | null | 'fail'>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!s) { setV(null); return; }
    mineShared().then((x) => alive && setV(x ?? 'fail'), () => alive && setV('fail'));
    return () => { alive = false; };
  }, [s?.token, n]); // eslint-disable-line react-hooks/exhaustive-deps
  return { mine: v, reload: useCallback(() => setN((x) => x + 1), []) };
}
/** The fees this wallet received as a creator. Null while the server reads the chain. */
export function useFeesShared() {
  const s = useSession();
  const [v, setV] = useState<Fees | null>(null);
  useEffect(() => {
    let alive = true;
    setV(null);
    if (s) void feesShared().then((x) => alive && setV(x));
    return () => { alive = false; };
  }, [s?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

/* ---------- the owner's approval on their own vault ---------- */

const FEE_ABI = [
  { type: 'function', name: 'creatorOf', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'bytes32' }], outputs: [{ name: 'creator', type: 'address' }, { name: 'bps', type: 'uint16' }] },
  { type: 'function', name: 'setCreatorFee', stateMutability: 'nonpayable', inputs: [{ name: 'agentId', type: 'bytes32' }, { name: 'creator', type: 'address' }, { name: 'bps', type: 'uint16' }], outputs: [] },
  { type: 'function', name: 'setBudget', stateMutability: 'nonpayable', inputs: [{ name: 'agentId', type: 'bytes32' }, { name: 'usdt', type: 'uint256' }], outputs: [] },
] as const;
type Hex = `0x${string}`;
/** A hired agent's id on the vault (version 3): keccak256 of its id in the app, the same as the server's agentIdOf. */
export const chainAgentId = (hiredId: string): Hex => keccak256(stringToHex(hiredId));

/**
 * What this vault's owner approved for this creator on this hired agent, in basis points (0 when the agent's approved
 * creator is someone else, or none). Throws when the chain cannot be read.
 */
export async function approvedFee(vault: string, hiredId: string, creator: string): Promise<number> {
  const data = encodeFunctionData({ abi: FEE_ABI, functionName: 'creatorOf', args: [chainAgentId(hiredId)] });
  const [who, bps] = decodeFunctionResult({ abi: FEE_ABI, functionName: 'creatorOf', data: await chainCall(vault, data) }) as readonly [string, number];
  return who.toLowerCase() === creator.toLowerCase() ? Number(bps) : 0;
}
/** Approve the creator of one hired agent on my own vault (one transaction from my wallet). The vault refuses more than 1%. */
export const setCreatorFee = (net: Net, vault: string, hiredId: string, creator: string, bps: number) =>
  sendTx(net, vault, encodeFunctionData({ abi: FEE_ABI, functionName: 'setCreatorFee', args: [chainAgentId(hiredId), creator as Hex, bps] }));
/** Give one hired agent its budget on my own vault (counts while budgets are on). */
export const setChainBudget = (net: Net, vault: string, hiredId: string, usd: number) =>
  sendTx(net, vault, encodeFunctionData({ abi: FEE_ABI, functionName: 'setBudget', args: [chainAgentId(hiredId), parseUnits(Math.max(0, usd).toFixed(6), 6)] }));

/** A hired shared agent, scored again from the rule it carries (it is in nobody's local store). */
export async function scoreHired(h: { source: { type: string; agentId?: string }; spec?: MadeSpec; shared?: { id: string; creator: string; nick?: string; feeBps: number } } | undefined): Promise<Agent | null> {
  if (!h?.spec || !h.shared || !h.source.agentId?.startsWith(SHARED_PREFIX)) return null;
  const m = cex.MARKETS.find((x) => x.symbol === h.spec!.market);
  const a = m ? await scoreMadeLive(h.spec, m) : null;
  return a && { ...a, id: h.source.agentId, shared: { ...h.shared } };
}
