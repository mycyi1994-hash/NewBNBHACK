// Moa's server API, the same code behind `vite` in development and behind server/main.ts in production.
// The Anthropic key and the agent key live here and never reach the browser.
// Every vault action is for the vault of the wallet that logged in: the session token on the request says whose.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkFactory, createVault, execConfigFromEnv, executeTrade, feesReceived, forOwner, serviceOn, vaultStatus, type CreatorRef, type ExecConfig, type FactoryCheck } from './executor.ts';
import * as session from './session.ts';
import { openStore, storeFile, type AutoStore } from './autoStore.ts';
import { autoBlock, startRunner } from './autoRunner.ts';
import { frameCheck } from './nanoFrame.ts';
import type { HiredAgent } from '../src/runner.ts';
import { openShares, sharesFile, type ShareStore } from './shareStore.ts';
import { openSpreads, spreadsFile, startRecorder, type SpreadStore } from './spreadStore.ts';
import { setGapSource, RECORD_EVERY_MS } from '../src/spread.ts';
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

export function createApi(env: Env, opts: { store?: AutoStore; shares?: ShareStore; spreads?: SpreadStore } = {}) {
  const asSet = execConfigFromEnv(env);
  const secret = session.sessionSecret(env);
  const store = opts.store ?? openStore(storeFile(env));
  const shares = opts.shares ?? openShares(sharesFile(env), SHARE_MARKETS);
  // The recorded HSKSwap vs exchange gaps: read by the spread hunter here, and served to the page below.
  const spreads = opts.spreads ?? openSpreads(spreadsFile(env));
  setGapSource(async (asset, days) => spreads.read(asset, days));
  // A factory from an earlier version of the vault is not used: the server then runs as a demo and says why.
  let factory: FactoryCheck = asSet.factory ? 'unreachable' : 'none';
  let base: ExecConfig = { ...asSet, factory: undefined };
  const settle = checkFactory(asSet).then((r) => {
    factory = r;
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
      for await (const chunk of req) raw += chunk;
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
        return send(200, { ...(await vaultStatus(await forOwner(base, who))), signedIn: !!who });
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
      if (req.url === '/api/auto' && req.method === 'POST') {
        const body = await posted();
        if (!body) return;
        if (!who) return send(401, { error: 'Log in first.' });
        if (body.op === 'remove') return send(200, { ok: true, agent: store.remove(who, String(body.id)) ?? null });
        const agent = cleanAgent(body.agent, shares);
        if (!agent) return send(400, { error: 'Invalid agent.' });
        const block = autoBlock(await vaultStatus(await forOwner(base, who)));
        if (block) return send(409, { ok: false, why: block });
        // Amounts, pause and the rule come from the owner; what the agent already did stays as the server has it.
        const had = store.list(who).find((a) => a.id === agent.id);
        store.put(who, had ? { ...had, perBuyUsd: agent.perBuyUsd, budgetUsd: agent.budgetUsd, paused: agent.paused, spec: agent.spec, shared: agent.shared, declined: agent.paused ? had.declined : undefined } : agent);
        return send(200, { ok: true, agent: store.list(who).find((a) => a.id === agent.id) });
      }

      // Shared agents: anyone can list and open them; publishing, stopping and counting a hire need a login, and the
      // creator is always the wallet of that login.
      const path = req.url.split('?')[0];
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
      if (req.url?.startsWith('/api/health') && req.method === 'GET') {
        const dir = process.cwd();
        const files = ['.env', '.env.local', '.env.development', '.env.development.local'].filter((f) => existsSync(join(dir, f)));
        const key = env.ANTHROPIC_API_KEY ?? '';
        const out: Record<string, unknown> = { envDir: dir, envFiles: files, anthropicKey: key ? `set (${key.length} chars, starts ${key.slice(0, 7)}…)` : 'missing', factory: factory === 'ok' ? `ok (${asSet.factory})` : factory === 'none' ? 'not configured' : factory === 'old' ? `${asSet.factory} is not the current MoaVaultFactory: deploy the current one and set its address` : `${asSet.factory}: the chain could not be reached at start`, agentKey: env.MOA_AGENT_PRIVATE_KEY ? 'set' : 'missing', dataDir: env.MOA_DATA_DIR || './data (MOA_DATA_DIR is not set)', dataFile: existsSync(storeFile(env)) ? 'kept' : 'none yet', autoOwners: store.owners().length };
        if (key && req.url.includes('ping')) {
          try {
            const { default: Anthropic } = await import('@anthropic-ai/sdk');
            const { MODEL } = await import('./moaAgent.ts');
            const r = await new Anthropic({ apiKey: key }).messages.create({ model: MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] });
            out.ping = `ok (${r.model})`;
          } catch (e) { out.ping = `failed: ${e instanceof Error ? e.message : String(e)}`; }
        }
        return send(200, out);
      }
      if (req.url === '/api/moa' && req.method === 'POST') {
        if (!env.ANTHROPIC_API_KEY) return send(503, { error: 'ANTHROPIC_API_KEY is not set on the server.' });
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const { history, context } = JSON.parse(raw) as { history: { role: 'user' | 'assistant'; content: string }[]; context?: { level?: 'new' | 'some' | 'pro' | null; asset?: string } };
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
          const result = await runMoa(env.ANTHROPIC_API_KEY, cfg, history.slice(-20), write, context ?? {}, gone.signal);
          write({ type: 'done', result });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[moa] Anthropic call failed:', msg);
          write({ type: 'error', error: msg });
        } finally {
          clearInterval(beat);
        }
        return res.end();
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
        // A shared agent's order names its creator, looked up here: the browser only says which shared agent it is.
        const creator = creatorOf(sharedOf({ id: body.shared }, shares).shared);
        const r = await executeTrade(cfg, { asset: asset as 'HSK' | 'ETH' | 'BTC', side, amount, note: String(body.note ?? '').slice(0, 120), creator });
        console.log(`[moa] agent order for ${who} ${side} ${amount} ${asset}: ${r.ok ? r.txHash : r.reason}`);
        return send(200, r);
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    handler,
    /** Start the agents that work on their own. Only where the server can trade at all. */
    startAuto: () => {
      let stop = () => {};
      void settle.then(() => { if (serviceOn(base)) stop = startRunner(base, store); });
      // The gap recorder runs on every server, trading or not: MOA_SPREAD_MS shortens it for a local trial (one minute at least).
      const stopRec = startRecorder(spreads, Number(env.MOA_SPREAD_MS) || RECORD_EVERY_MS);
      return () => { stop(); stopRec(); };
    },
  };
}
