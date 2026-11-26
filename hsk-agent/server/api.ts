// Moa's server API, the same code behind `vite` in development and behind server/main.ts in production.
// The Anthropic key and the agent key live here and never reach the browser.
// Every vault action is for the vault of the wallet that logged in: the session token on the request says whose.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkFactory, createVault, execConfigFromEnv, executeTrade, forOwner, serviceOn, vaultStatus, type ExecConfig, type FactoryCheck } from './executor.ts';
import * as session from './session.ts';
import { openStore, storeFile, type AutoStore } from './autoStore.ts';
import { autoBlock, startRunner } from './autoRunner.ts';
import type { HiredAgent } from '../src/runner.ts';

type Env = Record<string, string | undefined>;
type Next = () => void;
const ASSETS = ['HSK', 'ETH', 'BTC'];

/** Keep only what an auto agent needs, with sane numbers. The owner can only ever affect their own vault with it. */
function cleanAgent(x: unknown): HiredAgent | null {
  const a = x as Partial<HiredAgent> | null;
  if (!a || typeof a.id !== 'string' || !a.source || !ASSETS.includes(String(a.asset))) return null;
  const per = Number(a.perBuyUsd), budget = Number(a.budgetUsd);
  if (!(per > 0) || !(budget >= per) || !Number.isFinite(budget)) return null;
  if (a.source.type === 'market' ? typeof a.source.agentId !== 'string' : a.source.type !== 'custom') return null;
  return {
    id: a.id.slice(0, 40), createdAt: Number(a.createdAt) || Date.now(), source: a.source, asset: a.asset!, perBuyUsd: per, budgetUsd: budget,
    mode: 'auto', spec: a.spec, paused: !!a.paused, lastRunAt: a.lastRunAt, declined: a.declined,
    fired: Array.isArray(a.fired) ? a.fired.slice(0, 50) : [], fills: Array.isArray(a.fills) ? a.fills.slice(-500) : [], log: Array.isArray(a.log) ? a.log.slice(-500) : [],
  };
}

export function createApi(env: Env, opts: { store?: AutoStore } = {}) {
  const asSet = execConfigFromEnv(env);
  const secret = session.sessionSecret(env);
  const store = opts.store ?? openStore(storeFile(env));
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
        const agent = cleanAgent(body.agent);
        if (!agent) return send(400, { error: 'Invalid agent.' });
        const block = autoBlock(await vaultStatus(await forOwner(base, who)));
        if (block) return send(409, { ok: false, why: block });
        // Amounts, pause and the rule come from the owner; what the agent already did stays as the server has it.
        const had = store.list(who).find((a) => a.id === agent.id);
        store.put(who, had ? { ...had, perBuyUsd: agent.perBuyUsd, budgetUsd: agent.budgetUsd, paused: agent.paused, spec: agent.spec, declined: agent.paused ? had.declined : undefined } : agent);
        return send(200, { ok: true, agent: store.list(who).find((a) => a.id === agent.id) });
      }

      const cfg = await forOwner(base, who);
      // Diagnostics: is the Anthropic key loaded, from where, and does a real call work? Never returns the key.
      if (req.url?.startsWith('/api/health') && req.method === 'GET') {
        const dir = process.cwd();
        const files = ['.env', '.env.local', '.env.development', '.env.development.local'].filter((f) => existsSync(join(dir, f)));
        const key = env.ANTHROPIC_API_KEY ?? '';
        const out: Record<string, unknown> = { envDir: dir, envFiles: files, anthropicKey: key ? `set (${key.length} chars, starts ${key.slice(0, 7)}…)` : 'missing', factory: factory === 'ok' ? `ok (${asSet.factory})` : factory === 'none' ? 'not configured' : factory === 'old' ? `${asSet.factory} is not the current MoaVaultFactory: deploy the current one and set its address` : `${asSet.factory}: the chain could not be reached at start`, agentKey: env.MOA_AGENT_PRIVATE_KEY ? 'set' : 'missing', autoOwners: store.owners().length };
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
        const r = await executeTrade(cfg, { asset: asset as 'HSK' | 'ETH' | 'BTC', side, amount, note: String(body.note ?? '').slice(0, 120) });
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
    startAuto: () => { let stop = () => {}; void settle.then(() => { if (serviceOn(base)) stop = startRunner(base, store); }); return () => stop(); },
  };
}
