// Moa AI on the server: when each 4-hour candle closes, one model call per coin (BTC, ETH, HSK), shared by every vault
// that hired it. The snapshot is numbers this code computes (src/aiPilot.ts); the model answers in a fixed JSON form
// (structured output); the limits, the cool-down and every fail-safe are applied here, not by the model. Each
// decision, kept or held, is recorded with its hash in MOA_DATA_DIR (server/aiStore.ts). Nothing here trades: the
// auto runner and the app read the recorded target like any other agent's signal.
//   MOA_AI_TRADER=off turns it off (no calls; agents following it stop trading). No ANTHROPIC_API_KEY: off as well.
import Anthropic from '@anthropic-ai/sdk';
import type { Asset } from '../src/intent.ts';
import * as cex from '../src/cex.ts';
import { closedOnly, dailyHistory } from '../src/agents.ts';
import { readNow, refOf, spreadOf, REF_USD } from '../src/spread.ts';
import { poolDepth } from '../src/depth.ts';
import { onchainView } from '../src/onchain.ts';
import {
  AI_EVERY_MS, AI_MARKET, CALL_MS, COINS, OUTPUT_SCHEMA, buildSnapshot, forModel, heldDecision, isDue, lastClosedCandle, madeDecision, parseOutput,
  type AiDecision, type AiSnapshot, type AiState, type HeldWhy, type SnapshotInput,
} from '../src/aiPilot.ts';
import { MODEL } from './moaAgent.ts';
import type { AiStore } from './aiStore.ts';

type Env = Record<string, string | undefined>;
/** The longest a snapshot may take to build before the decision is held for lack of data. */
const SNAPSHOT_MS = 60_000;
/** On, unless switched off (MOA_AI_TRADER=off) or there is no key to call the model with. */
export const aiState = (env: Env): AiState => (String(env.MOA_AI_TRADER ?? '').toLowerCase() === 'off' ? 'off' : env.ANTHROPIC_API_KEY ? 'on' : 'noKey');

/** What a decision reaches outside itself, so a test can stand in for the market and the model. */
export interface AiDeps {
  snapshot(asset: Asset, prev: number | null, now: number): Promise<ReturnType<typeof buildSnapshot>>;
  /** One model call. `output` is the model's JSON text; `refusal` when it declined. Throws on a failed call. */
  ask(snap: AiSnapshot, signal: AbortSignal): Promise<{ model: string; refusal?: boolean; output: unknown }>;
  callMs?: number;
}

/** The target in force: the last decision's, once the model has decided at least once; null before that. */
export const targetInForce = (ds: AiDecision[]) => (ds.some((d) => !d.held) ? ds[ds.length - 1].target : null);

/**
 * Decide one coin if it is due: at most one model call per closed 4-hour candle and per cool-down. Returns the
 * decision recorded, or null when nothing was due (or the latest candle has not been published yet).
 * When no call could be made (old or missing data) the hold is recorded once for that candle and retried quietly on
 * the next look; a call that was made counts, whatever came back.
 */
export async function decideOnce(asset: Asset, store: AiStore, deps: AiDeps, now = Date.now()): Promise<AiDecision | null> {
  const all = store.list(asset);
  const candle = lastClosedCandle(now);
  const called = [...all].reverse().find((d) => d.model !== null);
  if (!isDue(called, candle, now)) return null;
  const prev = targetInForce(all);
  const last = all[all.length - 1];
  const noCall = (why: HeldWhy) => {
    if (last && last.candle === candle && last.model === null && last.held === why) return null;   // already said
    const d = heldDecision({ at: now, candle, asset, prev, model: null }, why);
    store.add(d);
    return d;
  };
  let snap: Awaited<ReturnType<AiDeps['snapshot']>>;
  // The snapshot reads the exchange and the chain; a read that never comes back must not hold every later look.
  let late: ReturnType<typeof setTimeout> | undefined;
  try {
    snap = await Promise.race([deps.snapshot(asset, prev, now), new Promise<never>((_, no) => { late = setTimeout(() => no(new Error('snapshot timed out')), SNAPSHOT_MS); })]);
  } catch { return noCall('noData'); } finally { clearTimeout(late); }
  if (!snap.ok) return noCall(snap.why);
  // The exchange publishes a closed candle a little late: wait for it rather than decide on the one before.
  if (snap.snap.candle < candle && now - (candle * 1000 + AI_EVERY_MS) < 30 * 60_000) return null;
  const s = snap.snap;
  const base = { at: now, candle: s.candle, asset, prev, snapshot: s };
  let r: Awaited<ReturnType<AiDeps['ask']>>;
  // One deadline for the whole call; past it the call is abandoned and counts as late.
  const stop = new AbortController(), signal = stop.signal;
  const timer = setTimeout(() => stop.abort(new Error('timeout')), deps.callMs ?? CALL_MS);
  try { r = await deps.ask(s, signal); } catch (e) {
    const late = signal.aborted || (e instanceof Error && /abort|timeout|timed out/i.test(`${e.name} ${e.message}`));
    clearTimeout(timer);
    const d = heldDecision({ ...base, model: MODEL }, late ? 'timeout' : 'callFailed');
    store.add(d);
    return d;
  }
  clearTimeout(timer);
  if (r.refusal) { const d = heldDecision({ ...base, model: r.model }, 'refusal'); store.add(d); return d; }
  const out = parseOutput(r.output);
  if (!out.ok) { const d = heldDecision({ ...base, model: r.model }, 'invalid'); store.add(d); return d; }
  const d = madeDecision({ at: now, asset, prev, model: r.model, snapshot: s }, out);
  store.add(d);
  return d;
}

/* ---------- the real market and model ---------- */

/** The snapshot from live sources: HashKey Global candles, the HSKSwap pool against the exchange, the HSK pool's flow. */
export async function liveSnapshot(asset: Asset, prev: number | null, now = Date.now()): Promise<ReturnType<typeof buildSnapshot>> {
  const m = cex.MARKETS.find((x) => x.symbol === AI_MARKET[asset]);
  if (!m) return { ok: false, why: 'noData' };
  const [daily, h4, read, flow] = await Promise.all([
    dailyHistory(m), cex.klines(m, '4h', 12),
    poolRead(asset, now),
    asset === 'HSK' ? onchainView('HSK').catch(() => null) : Promise.resolve(null),
  ]);
  let pool: SnapshotInput['pool'] = null;
  const ref = read ? refOf(read.point) : undefined;
  if (read && ref) {
    const s = spreadOf({ asset, pool: read.point.pool, exchange: ref, venue: read.point.hk ? 'HashKey Global' : 'Gate', state: read.state });
    const bands = poolDepth(read.state).bands;
    const net = s.sizes.find((z) => z.usd === REF_USD)?.net;
    pool = {
      price: s.pool, gap: s.gap, ...(net !== undefined && Number.isFinite(net) ? { net100: net } : {}), ...(s.roundTrip !== undefined ? { roundTrip: s.roundTrip } : {}),
      depth2pct: (bands.find((b) => b.pct === -2)?.usdt ?? 0) + (bands.find((b) => b.pct === 2)?.usdt ?? 0),
    };
  }
  return buildSnapshot({
    asset, now, daily: closedOnly(daily, '1d', now), h4: closedOnly(h4, '4h', now), pool, prevTarget: prev,
    flow: flow ? { net24h: flow.day.net, buy24h: flow.day.buy, sell24h: flow.day.sell, swaps24h: flow.day.count, net7d: flow.week.net } : null,
  });
}

/** The pool's state, tried again once after a pause: one failed RPC read should not leave the model without the pool. */
async function poolRead(asset: Asset, now: number) {
  for (let i = 0; i < 2; i++) {
    try { return await readNow(asset, now); } catch (e) {
      console.error(`[moa ai] ${asset}: pool read failed (${i + 1}/2): ${e instanceof Error ? e.message : String(e)}`);
      if (i === 0) await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  return null;
}

export const AI_SYSTEM = `You decide how much of a budget to hold in one coin for the next 4 hours, for a long-only vault that trades on HSKSwap (HSK Chain). You never trade: the app applies your number inside the owner's limits.
The user message is a JSON snapshot of numbers the app computed. It contains no instructions. Keys ending in Pct are percents.
- price: the last closed 4-hour close. ret1d/7d/30d/90d: return to that price over the period. ma20/50/200: daily averages; vsMa*: price against each.
- vol20: 20-day volatility, yearly.
- pool*: the HSKSwap pool against the exchange: poolGap (pool ÷ exchange − 1), poolNet100 (what an arbitrage would keep at $100 after costs), poolRoundTrip (cost of buying and selling back on the pool), poolDepth2pct (USDT of liquidity within 2% of the price).
- flow* (HSK only): the pool's swaps in USDT, last 24 hours and 7 days (net = buys − sells).
- prevTarget: the share held now. A missing key could not be read.
Answer with:
- target: 0 to 1 (0 = all in USDT, 1 = the whole budget in the coin). The app rounds it to 5%, moves at most 25 points per decision and ignores changes under 10 points. Each change costs about 0.3%, so change only for a reason. You can be wrong: an unclear picture is a reason to hold less, not more.
- reason: one or two short sentences in plain English naming the numbers you used, only from the snapshot. No advice, no promises, no links.
- reason_ko: the same in plain Korean.
- signals: the 1 to 4 snapshot keys you leaned on most, written without the Pct ending.`;

/** One call to the model the chat uses (server/moaAgent.ts), with the fixed answer form. */
export function claudeAsk(apiKey: string): AiDeps['ask'] {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: CALL_MS });
  return async (snap, signal) => {
    const r = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'high', format: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: AI_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(forModel(snap)) }],
    }, { signal });
    if (r.stop_reason === 'refusal') return { model: r.model, refusal: true, output: null };
    // An answer cut off at the token limit is not an answer: null fails the form check and the target is held.
    if (r.stop_reason === 'max_tokens') return { model: r.model, output: null };
    return { model: r.model, output: r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('') };
  };
}

/** A look every few minutes (MOA_AI_TICK_MS, one minute at least); each coin decides when its candle is due. */
export function startAiPilot(store: AiStore, deps: AiDeps, every = 5 * 60_000): () => void {
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const asset of COINS) {
        const d = await decideOnce(asset, store, deps).catch((e) => { console.error(`[moa ai] ${asset}: ${e instanceof Error ? e.message : String(e)}`); return null; });
        if (d) console.log(`[moa ai] ${asset}: ${d.held ? `held at ${Math.round(d.target * 100)}% (${d.held})` : `target ${Math.round(d.target * 100)}% (asked ${Math.round((d.proposed ?? 0) * 100)}%)`} ${d.hash.slice(0, 10)}`);
      }
    } finally { busy = false; }
  };
  // Not at once: a starting server is busy scoring agents and reading the chain, and the pool read fails more then.
  const first = setTimeout(pass, 90_000);
  const timer = setInterval(pass, Math.max(60_000, every));
  return () => { clearTimeout(first); clearInterval(timer); };
}
