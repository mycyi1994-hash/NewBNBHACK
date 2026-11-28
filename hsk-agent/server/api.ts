// Moa's server API, the same code behind `vite` in development and behind server/main.ts in production.
// The Anthropic key and the agent key live here and never reach the browser.
// Every vault action is for the vault of the wallet that logged in: the session token on the request says whose.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkFactory, platformFee, createVault, execConfigFromEnv, executeTrade, feesLive, feesReceived, forOwner, moveStatus, serviceOn, upgradeVault, vaultStatus, vaultView, type CreatorRef, type ExecConfig, type FactoryCheck } from './executor.ts';
import * as session from './session.ts';
import { openStore, storeFile, type AutoStore } from './autoStore.ts';
import { gzipSync } from 'node:zlib';
import { agentCacheFile, DEFAULT_KEYS, isKey, openAgentCache, type AgentCache, type SetKey } from './agentCache.ts';
import { RUNNABLE } from '../src/agents.ts';
import { autoBlock, newRunnerState, pauseForMove, runnerEvery, startRunner, undoMovePause, type RunnerState } from './autoRunner.ts';
import { frameCheck } from './nanoFrame.ts';
import { cleanHistory, cleanOrder, issueTicket, MOA_LIMITS, rateLimiter, ticketBook } from './guard.ts';
import type { HiredAgent } from '../src/runner.ts';
import { openShares, sharesFile, type ShareStore } from './shareStore.ts';
import { openSpreads, spreadsFile, startRecorder, type SpreadStore } from './spreadStore.ts';
import { setGapSource, RECORD_EVERY_MS } from '../src/spread.ts';
import { onchainFile, openOnchain, startOnchain, READ_EVERY_MS } from './onchainStore.ts';
import { setOnchainSource } from '../src/onchain.ts';
import { aiFile, openAiStore, type AiStore } from './aiStore.ts';
import { aiState, claudeAsk, liveSnapshot, startAiPilot } from './aiPilot.ts';
import { setAiSource } from '../src/aiPilot.ts';
import { MODEL } from './moaAgent.ts';
import { isRunnable, SIGNAL_MARKETS } from '../src/agents.ts';
import type { Address } from 'viem';
import type { SharedRef } from '../src/share.ts';

/** Shared agents may read only the markets a vault can trade. */
const SHARE_MARKETS = SIGNAL_MARKETS.filter((m) => isRunnable(m.base)).map((m) => m.symbol);

type Env = Record<string, string | undefined>;
type Next = () => void;
const ASSETS = ['HSK', 'ETH', 'BTC'];

/**
 * Keep only what an auto agent needs, with sane numbers. The owner can only ever affect their own vault with it.
 * A shared agent's creator and fee come from the server's own record, whatever the browser sent.
 */
export function cleanAgent(x: unknown, shares?: ShareStore): HiredAgent | null {
  const a = x as Partial<HiredAgent> | null;
  if (!a || typeof a.id !== 'string' || !a.source || !ASSETS.includes(String(a.asset))) return null;
  const per = Number(a.perBuyUsd), budget = Number(a.budgetUsd);
  if (!(per > 0) || !(budget >= per) || !Number.isFinite(budget)) return null;
  if (a.source.type === 'market' ? typeof a.source.agentId !== 'string' : a.source.type !== 'custom') return null;
  return {
    id: a.id.slice(0, 40), createdAt: Number(a.createdAt) || Date.now(), source: a.source, asset: a.asset!, perBuyUsd: per, budgetUsd: budget,
    mode: 'auto', spec: a.spec, ...sharedOf(a.shared, shares), paused: !!a.paused, lastRunAt: a.lastRunAt, declined: a.declined,
    fired: Array.isArray(a.fired) ? a.fired.slice(0, 50) : [], fills: Array.isArray(a.fills) ? a.fills.slice(-500) : [], log: Array.isArray(a.log) ? a.log.slice(-500) : [],
  };
}

/** The record's own creator and fee for a shared agent the browser names; nothing when the server has no such agent. */
function sharedOf(x: unknown, shares?: ShareStore): { shared?: SharedRef } {
  const id = typeof (x as { id?: unknown } | null)?.id === 'string' ? (x as { id: string }).id : '';
  const r = id && shares ? shares.get(id) : undefined;
  return r ? { shared: { id: r.id, creator: r.creator, ...(r.nick ? { nick: r.nick } : {}), feeBps: r.feeBps } } : {};
}
const creatorOf = (s: SharedRef | undefined): CreatorRef | undefined => (s ? { address: s.creator as Address, feeBps: s.feeBps } : undefined);

export function createApi(env: Env, opts: { store?: AutoStore; shares?: ShareStore; spreads?: SpreadStore; agents?: AgentCache; ai?: AiStore } = {}) {
  const asSet = execConfigFromEnv(env);
  const secret = session.sessionSecret(env);
  const store = opts.store ?? openStore(storeFile(env));
  const shares = opts.shares ?? openShares(sharesFile(env), SHARE_MARKETS);
  // The recorded HSKSwap vs exchange gaps: read by the spread hunter here, and served to the page below.
  const spreads = opts.spreads ?? openSpreads(spreadsFile(env));
  setGapSource(async (asset, days) => spreads.read(asset, days));
  // The on-chain watch for HSK: the WHSK pool's own swaps and liquidity, read from HSK Chain.
  const onchain = openOnchain('HSK', onchainFile(env, 'HSK'));
  setOnchainSource(async (asset) => (asset === 'HSK' ? onchain.view() : null));
  // Moa AI: the decisions its model made, one per coin every 4 hours, read by the runner, the chat and the page.
  const ai = opts.ai ?? openAiStore(aiFile(env));
  const aiOn = aiState(env);
  setAiSource(async (asset) => ai.feed(asset, aiOn, aiOn === 'on' ? MODEL : null));
  // Trades Moa proposes run only from their Confirm button's single-use ticket; Moa's answers are rationed.
  const tickets = ticketBook(secret);
  // The scored agent lists, kept and refreshed here so the browser gets a market's list in one request.
  const agentSets = opts.agents ?? openAgentCache(agentCacheFile(env));
  // The auto runner's last looks, for /api/auto/status; set when the runner starts (only where the server can trade).
  let runner: RunnerState | null = null;
  const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
  const askLimit = rateLimiter({ perMinute: num(env.MOA_AI_PER_MINUTE, MOA_LIMITS.perMinute), perDayKnown: num(env.MOA_AI_PER_DAY, MOA_LIMITS.perDayKnown), perDayAnon: num(env.MOA_AI_PER_DAY_ANON, MOA_LIMITS.perDayAnon), perDayAll: num(env.MOA_AI_PER_DAY_ALL, MOA_LIMITS.perDayAll) });
  // Every trade the server sends costs the agent wallet gas: at most a few a minute and 100 a day per wallet.
  const tradeLimit = rateLimiter({ perMinute: num(env.MOA_TRADES_PER_MINUTE, 5), perDayKnown: num(env.MOA_TRADES_PER_DAY, 100), perDayAnon: 0, perDayAll: num(env.MOA_TRADES_PER_DAY_ALL, 2_000) });
  // Behind a proxy (Render sets RENDER) the caller's address is the last one the proxy added; otherwise the socket's.
  const trustProxy = env.MOA_TRUST_PROXY === '1' || !!env.RENDER;
  const ipOf = (req: IncomingMessage) => (trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).pop() : undefined) || req.socket.remoteAddress || 'unknown';
  // A factory from an earlier version of the vault is not used: the server then runs as a demo and says why.
  let factory: FactoryCheck = asSet.factory ? 'unreachable' : 'none';
  let base: ExecConfig = { ...asSet, factory: undefined };
  const settle = checkFactory(asSet).then((r) => {
    factory = r;
    // What /api/health no longer shows: where the agents on auto are kept, and how many wallets the server knows.
    console.log(`[moa] data in ${storeFile(env)} · ${store.owners().length} wallets known · factory ${r}`);
    if (r === 'ok') base = asSet;
    else if (r !== 'none') console.error(`[moa] MOA_FACTORY_ADDRESS ${asSet.factory} is not usable (${r === 'old' ? 'it is not the current MoaVaultFactory: deploy the current one' : 'the chain could not be reached'}). Running as a demo.`);
  });

  const handler = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    if (!req.url?.startsWith('/api/')) return next();
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    /** A JSON body posted by this site's own page. Another website cannot post here. */
    const posted = async (): Promise<Record<string, unknown> | null> => {
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) { send(415, { error: 'Send JSON.' }); return null; }
      const origin = req.headers.origin;
      let sameOrigin = true;
      try { if (origin) sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
      if (!sameOrigin) { send(403, { error: 'Requests from another origin are refused.' }); return null; }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 32_768) { send(413, { error: 'Too large.' }); req.destroy(); return null; }
      }
      try { const v = JSON.parse(raw) as unknown; if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* fall through */ }
      send(400, { error: 'Invalid JSON.' });
      return null;
    };
    try {
      await settle;
      const host = String(req.headers.host ?? '');
      // Who is asking: the wallet that logged in, or nobody.
      const who = session.fromHeader(secret, req.headers.authorization);
      if (req.url === '/api/login/challenge' && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        const c = session.challenge(secret, String(body.address ?? ''), host);
        return c ? send(200, c) : send(400, { error: 'Not a wallet address.' });
      }
      if (req.url === '/api/login' && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        const r = await session.login(secret, body, host);
        return r.ok ? send(200, r) : send(401, { error: r.reason });
      }
      if (req.url === '/api/vault' && req.method === 'GET') {
        if (who && serviceOn(base)) store.seen(who);
        // The active vault, plus the move to a newer one: whether one can be made, and what an earlier vault still holds.
        return send(200, { ...(await vaultView(await forOwner(base, who))), signedIn: !!who });
      }
      // Move to a new vault, step one: make the logged-in wallet's vault on the current factory although an earlier
      // factory made it one. The server pays the gas; nothing moves. The wallet's agents on auto are paused first
      // (the new vault starts empty) and say why; if no vault is made they go back as they were.
      if (req.url === '/api/vault/upgrade' && req.method === 'POST') {
        if (!(await posted())) return;
        if (!who) return send(401, { error: 'Log in first.' });
        if (!serviceOn(base)) return send(503, { error: 'This server cannot make vaults.' });
        const due = (await moveStatus(await forOwner(base, who))).upgrade.available;
        const paused = due ? pauseForMove(store, who) : [];
        let r: Awaited<ReturnType<typeof upgradeVault>>;
        try { r = await upgradeVault(base, who); } catch (e) { undoMovePause(store, who, paused); throw e; }
        const made = r.ok && r.made;
        if (!made) undoMovePause(store, who, paused);
        console.log(`[moa] new vault for ${who}: ${r.ok ? `${r.vault}${r.made ? ` (moving from ${r.from}; ${paused.length} auto agents paused)` : ' (already there)'}` : r.reason}`);
        return send(r.ok ? 200 : 409, { ...r, paused: made ? paused.length : 0 });
      }
      // Make the logged-in wallet's vault. The server pays the gas; the wallet is the owner.
      if (req.url === '/api/vault/create' && req.method === 'POST') {
        if (!(await posted())) return;
        if (!who) return send(401, { error: 'Log in first.' });
        if (!serviceOn(base)) return send(503, { error: 'This server cannot make vaults.' });
        const r = await createVault(base, who);
        console.log(`[moa] vault for ${who}: ${r.ok ? r.vault : r.reason}`);
        return send(r.ok ? 200 : 409, r);
      }

      // Agents that work on their own. The server's copy is the one that counts; the app shows it.
      if (req.url === '/api/auto' && req.method === 'GET') {
        if (!who) return send(401, { error: 'Log in first.' });
        return send(200, { agents: store.list(who) });
      }
      // Is the auto runner alive, when did it last look and when does it look next? Public. What each of my agents
      // decided at that look, and why, only for the wallet that logged in (and only its own agents).
      if (req.url.split('?')[0] === '/api/auto/status' && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams.get('owner');
        const run = runner ? { on: true, every: runner.every, startedAt: runner.startedAt, passes: runner.passes, lastPassAt: runner.lastPassAt ?? null, nextAt: runner.nextAt ?? null, error: runner.passError ?? null } : { on: false, why: serviceOn(base) ? 'starting' : 'demo' };
        const mine = !!who && (!q || q.toLowerCase() === who.toLowerCase());
        if (!mine) return send(200, { runner: run, now: Date.now() });
        const look = runner?.owners.get(who!.toLowerCase());
        const agents = store.list(who!).filter((a) => a.mode === 'auto').map((a) => ({ id: a.id, paused: a.paused, ...(a.paused && a.pausedWhy ? { why: a.pausedWhy } : {}), check: runner?.agents.get(a.id) ?? null }));
        return send(200, { runner: run, now: Date.now(), owner: { lastLookAt: look?.at ?? null, error: look?.error ?? null }, agents });
      }
      if (req.url === '/api/auto' && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        if (!who) return send(401, { error: 'Log in first.' });
        if (body.op !== 'remove' && store.list(who).length >= 20 && !store.list(who).some((a) => a.id === (body.agent as { id?: unknown } | null)?.id)) return send(409, { ok: false, why: 'tooMany' });
        if (body.op === 'remove') return send(200, { ok: true, agent: store.remove(who, String(body.id)) ?? null });
        const agent = cleanAgent(body.agent, shares);
        if (!agent) return send(400, { error: 'Invalid agent.' });
        // Moa AI runs on auto only while this server's AI is deciding (a key, and not switched off).
        if (agent.source.type === 'market' && agent.source.rule === 'aiPilot' && aiOn !== 'on' && !agent.paused) return send(409, { ok: false, why: 'aiOff' });
        const block = autoBlock(await vaultStatus(await forOwner(base, who)));
        if (block) return send(409, { ok: false, why: block });
        // Amounts, pause and the rule come from the owner; what the agent already did stays as the server has it.
        const had = store.list(who).find((a) => a.id === agent.id);
        // Resuming it clears the reason the server paused it for.
        store.put(who, had ? { ...had, perBuyUsd: agent.perBuyUsd, budgetUsd: agent.budgetUsd, paused: agent.paused, pausedWhy: agent.paused ? had.pausedWhy : undefined, spec: agent.spec, shared: agent.shared, declined: agent.paused ? had.declined : undefined } : agent);
        return send(200, { ok: true, agent: store.list(who).find((a) => a.id === agent.id) });
      }

      // Shared agents: anyone can list and open them; publishing, stopping and counting a hire need a login, and the
      // creator is always the wallet of that login.
      const path = req.url.split('?')[0];
      // The on-chain watch, public and read-only (HSK only).
      if (path === '/api/onchain' && req.method === 'GET') {
        const asset = new URL(req.url, 'http://x').searchParams.get('asset') ?? 'HSK';
        if (asset !== 'HSK') return send(400, { error: 'only HSK is watched on chain' });
        return send(200, { view: onchain.view() });
      }
      // Moa AI's decisions, public and read-only: when, the share it set, its reason, the inputs it named and the hash.
      if (path === '/api/ai/decisions' && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const asset = String(q.get('asset') ?? '');
        if (!ASSETS.includes(asset)) return send(400, { error: 'asset must be HSK, ETH or BTC' });
        return send(200, ai.feed(asset as 'HSK' | 'ETH' | 'BTC', aiOn, aiOn === 'on' ? MODEL : null, Number(q.get('n')) || 30));
      }
      // The gap history, public and read-only: only what this server recorded.
      if (path === '/api/spread' && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const asset = String(q.get('asset') ?? '');
        if (!ASSETS.includes(asset)) return send(400, { error: 'asset must be HSK, ETH or BTC' });
        const days = Math.min(14, Math.max(1, Number(q.get('days')) || 1));
        return send(200, { asset, every: Math.max(60_000, Number(env.MOA_SPREAD_MS) || RECORD_EVERY_MS), points: spreads.read(asset as 'HSK' | 'ETH' | 'BTC', days) });
      }
      if (path === '/api/shared' && req.method === 'GET') return send(200, { agents: shares.list() });
      if (path === '/api/shared/mine' && req.method === 'GET') {
        if (!who) return send(401, { error: 'Log in first.' });
        return send(200, { agents: shares.mine(who) });
      }
      // What the vaults have paid this wallet as a creator, read from their events on-chain (can take a while the first time).
      if (path === '/api/shared/fees' && req.method === 'GET') {
        if (!who) return send(401, { error: 'Log in first.' });
        return send(200, { fees: await feesReceived(base, who) });
      }
      if (path.startsWith('/api/shared/') && req.method === 'GET') {
        const r = shares.get(decodeURIComponent(path.slice('/api/shared/'.length)));
        return r ? send(200, { agent: r }) : send(404, { error: 'No such shared agent.' });
      }
      if (path === '/api/shared' && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        if (!who) return send(401, { error: 'Log in first.' });
        // A creator fee only where a vault can pay it: while this server's factory makes older vaults, a share asks none.
        if (Number(body.feeBps) > 0 && !(await feesLive(base))) return send(400, { ok: false, why: 'fee' });
        const r = shares.publish(who, { spec: body.spec, feeBps: body.feeBps, nick: body.nick });
        if (r.ok) console.log(`[moa] ${who} shared ${r.agent.id}${r.again ? ' (again)' : ''} at ${r.agent.feeBps} bps`);
        return send(r.ok ? 200 : 400, r);
      }
      if ((path === '/api/shared/unpublish' || path === '/api/shared/hire') && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        if (!who) return send(401, { error: 'Log in first.' });
        const id = String(body.id ?? '');
        const r = path.endsWith('hire') ? shares.hire(id, who) : shares.unpublish(who, id);
        return r ? send(200, { ok: true, agent: r }) : send(404, { error: 'No such shared agent of yours.' });
      }

      const cfg = await forOwner(base, who);
      // Diagnostics: is the Anthropic key loaded, from where, and does a real call work? Never returns the key.
      // Whether this Moa may show nanotradingclub's chart inside the page (its headers decide; see server/nanoFrame.ts).
      if (req.url === '/api/nano-frame' && req.method === 'GET') {
        const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
        return send(200, await frameCheck(`${proto}://${host}`));
      }
      // The factory's platform fee (0 unless its guardian set one), for the trust page; version-2 factories have none.
      // And whether a new share may ask a creator fee: only when the vaults this server makes now are version 3 or newer.
      if (path === '/api/terms' && req.method === 'GET') {
        return send(200, { platformFeeBps: await platformFee(base), creatorFees: await feesLive(base) });
      }
      // Public health: what works, in words, and nothing about keys, paths or files. It never calls the model.
      // The details are in the server's own log at start.
      // Scored agents, from the server's cache: ?base=BTC (that coin's market and its collect agents), ?keys=m:SYMBOL,c:COIN,
      // or every default set. Each set carries the time it was scored. Public, read-only, gzip when the browser takes it.
      if (path === '/api/agents' && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const base = (q.get('base') ?? '').toUpperCase();
        const keys: SetKey[] = q.get('keys') ? q.get('keys')!.split(',').filter(isKey).slice(0, 12)
          : base ? [...SIGNAL_MARKETS.filter((m) => m.base === base).map((m) => `m:${m.symbol}` as SetKey), ...((RUNNABLE as string[]).includes(base) ? [`c:${base}` as SetKey] : [])]
            : DEFAULT_KEYS;
        if (!keys.length) return send(400, { error: 'Unknown market.' });
        const sets = (await Promise.allSettled(keys.map((k) => agentSets.get(k)))).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
        if (!sets.length) return send(503, { error: 'The agents could not be scored right now.' });
        const body = Buffer.from(JSON.stringify({ sets }));
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-cache');
        if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) { res.setHeader('content-encoding', 'gzip'); return res.end(gzipSync(body)); }
        return res.end(body);
      }
      if (path === '/api/health' && req.method === 'GET') {
        return send(200, { ok: true, vaults: serviceOn(base) ? 'on' : 'demo', factory: factory === 'ok' ? 'ok' : factory === 'none' ? 'not configured' : factory === 'old' ? 'not the current version' : 'not reachable', ai: env.ANTHROPIC_API_KEY ? 'on' : 'off' });
      }
      if (req.url === '/api/moa' && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        const history = cleanHistory(body.history);
        if (!history) return send(400, { error: 'Invalid conversation.' });
        // Rationed per wallet when logged in, per address otherwise, and in all per day.
        const limited = askLimit.take(who ? `w:${who.toLowerCase()}` : `ip:${ipOf(req)}`, !!who);
        if (limited) return send(429, { error: limited === 'minute' ? 'Too many questions at once. Wait a minute.' : limited === 'day' ? (who ? 'That is all the questions for today.' : 'Log in to ask more today.') : 'Moa has answered all it can today.', why: limited });
        if (!env.ANTHROPIC_API_KEY) return send(503, { error: 'The AI is off on this server.' });
        const raw = (body.context ?? {}) as { level?: unknown; asset?: unknown };
        const context = { level: (['new', 'some', 'pro'] as const).find((l) => l === raw.level) ?? null, asset: typeof raw.asset === 'string' ? raw.asset.slice(0, 12) : undefined };
        // A proposed trade becomes a ticket for this wallet's Confirm button; nothing is sent from here.
        const propose = (o: Parameters<typeof issueTicket>[2]) => (!who ? 'The user is not logged in: no trade can be proposed. Tell them to log in first.' : !cfg.vault ? 'The user has no vault yet: no trade can be proposed.' : issueTicket(secret, who, o));
        const { runMoa } = await import('./moaAgent.ts');
        // NDJSON stream: real progress steps while Claude works, then the final result
        res.statusCode = 200;
        res.setHeader('content-type', 'application/x-ndjson');
        res.setHeader('cache-control', 'no-cache');
        const write = (o: unknown) => res.write(JSON.stringify(o) + '\n');
        // A line every few seconds tells the browser the server is alive and still working, so it can tell a
        // slow answer from a dead connection. Closing the tab or pressing stop ends the model call.
        const gone = new AbortController();
        res.on('close', () => gone.abort());
        const beat = setInterval(() => write({ type: 'ping' }), 5000);
        try {
          const result = await runMoa(env.ANTHROPIC_API_KEY, cfg, history, write, context, gone.signal, propose);
          write({ type: 'done', result });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[moa] Anthropic call failed:', msg);
          // The kind of failure (HTTP status and the API's error type, never the request or a key), so a failing AI can be
          // told apart from outside: a bad request, a refused key, no credit and a busy API need different fixes.
          const st = (e as { status?: unknown }).status, ty = ((e as { error?: { error?: { type?: unknown } } }).error?.error?.type);
          write({ type: 'error', error: 'The AI could not answer.', kind: `${typeof st === 'number' ? st : 'no-status'} ${typeof ty === 'string' ? ty : (e instanceof Error ? e.name : 'error')}`, detail: msg.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[key]').slice(0, 300) });
        } finally {
          clearInterval(beat);
        }
        return res.end();
      }
      // The Confirm button under an order Moa proposed: its ticket is for this wallet and this exact order, once.
      if (req.url === '/api/moa/confirm' && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        if (!who) return send(401, { error: 'Log in first.' });
        if (tradeLimit.take(`w:${who.toLowerCase()}`, true)) return send(429, { ok: false, reason: 'Too many orders for now. Try again later.' });
        const t = tickets.redeem(body.token, who);
        if (!t.ok) return send(t.why === 'otherWallet' ? 403 : 409, { ok: false, reason: t.why === 'expired' ? 'This order expired. Ask Moa again.' : t.why === 'used' ? 'This order was already sent.' : 'This order is not valid.', why: t.why });
        const r = await executeTrade(cfg, t.order);
        console.log(`[moa] confirmed order for ${who} ${t.order.side} ${t.order.amount} ${t.order.asset}: ${r.ok ? r.txHash : r.reason}`);
        return send(200, { ...r, request: { asset: t.order.asset, side: t.order.side, amount: t.order.amount } });
      }
      // An order asked for in plain words while the AI is off: the app read it with its fixed parser (no model), and
      // the server turns it into the same single-use ticket the AI's proposals get. Nothing is sent from here: the
      // order runs only when this wallet presses Confirm under it, and the vault checks its limits again.
      if (req.url === '/api/moa/propose' && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        if (!who) return send(401, { error: 'Log in first.', why: 'login' });
        if (askLimit.take(`w:${who.toLowerCase()}`, true)) return send(429, { error: 'Too many requests. Wait a minute.' });
        const o = cleanOrder({ ...body, note: '' });
        if (!o) return send(400, { error: 'Not an order.' });
        const mine = await forOwner(base, who);
        if (!serviceOn(base) || !mine.vault) return send(409, { error: 'There is no vault to send this order from.', why: 'noVault' });
        const sym = { HSK: 'WHSK', ETH: 'WETH', BTC: 'WBTC' }[o.asset];
        const note = o.side === 'buy' ? `User asked to buy $${o.amount} of ${sym} on HSKSwap.` : `User asked to sell ${o.amount} ${sym} on HSKSwap.`;
        return send(200, { proposal: issueTicket(secret, who, { ...o, note }) });
      }
      // A hired agent's order that the user approved on screen. No model is involved: the order is the
      // agent's own rule, the user pressed the button, and the vault enforces its limits again on-chain.
      // JSON from this origin only, and only for the vault of the wallet that logged in.
      if (req.url === '/api/agent-trade' && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        if (!who) return send(401, { error: 'Log in first.' });
        const asset = String(body.asset), side = body.side, amount = Number(body.amount);
        if (!ASSETS.includes(asset) || (side !== 'buy' && side !== 'sell') || !Number.isFinite(amount) || amount <= 0) return send(400, { error: 'Invalid order.' });
        if (tradeLimit.take(`w:${who.toLowerCase()}`, true)) return send(429, { ok: false, reason: 'Too many orders for now. Try again later.' });
        // A shared agent's order names its creator, looked up here: the browser only says which shared agent it is.
        const creator = creatorOf(sharedOf({ id: body.shared }, shares).shared);
        const r = await executeTrade(cfg, { asset: asset as 'HSK' | 'ETH' | 'BTC', side, amount, note: String(body.note ?? '').slice(0, 120), creator, agent: typeof body.agent === 'string' && body.agent ? body.agent.slice(0, 40) : undefined });
        console.log(`[moa] agent order for ${who} ${side} ${amount} ${asset}: ${r.ok ? r.txHash : r.reason}`);
        return send(200, r);
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      // The details stay in the server's log; the caller gets no internals.
      console.error('[moa] request failed:', req.method, req.url?.split('?')[0], e instanceof Error ? e.message : String(e));
      if (!res.headersSent) return send(500, { error: 'Server error.' });
      res.end();
    }
  };

  return {
    handler,
    /** Start the agents that work on their own. Only where the server can trade at all. */
    startAuto: () => {
      let stop = () => {};
      void settle.then(() => { if (serviceOn(base)) { runner = newRunnerState(runnerEvery()); stop = startRunner(base, store, runner); } });
      // The gap recorder runs on every server, trading or not: MOA_SPREAD_MS shortens it for a local trial (one minute at least).
      const stopRec = startRecorder(spreads, Number(env.MOA_SPREAD_MS) || RECORD_EVERY_MS);
      const stopChain = startOnchain('HSK', onchain, Number(env.MOA_ONCHAIN_MS) || READ_EVERY_MS);
      // The agent lists are scored on every server, trading or not, so the first visitor does not wait for them.
      const stopAgents = agentSets.start();
      // Moa AI decides only with a key and unless MOA_AI_TRADER=off; otherwise it says so and nothing follows it.
      const stopAi = aiOn === 'on' ? startAiPilot(ai, { snapshot: liveSnapshot, ask: claudeAsk(env.ANTHROPIC_API_KEY!) }, Number(env.MOA_AI_TICK_MS) || undefined) : () => {};
      console.log(`[moa] Moa AI ${aiOn === 'on' ? `on (${MODEL}, every 4 hours)` : aiOn === 'off' ? 'switched off (MOA_AI_TRADER=off)' : 'off: no ANTHROPIC_API_KEY'}`);
      return () => { stop(); stopRec(); stopChain(); stopAgents(); stopAi(); };
    },
  };
}
