import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import type { AcceptedPlugin } from 'postcss';

// Server-only API for local dev and `vite preview`: the Anthropic key and the agent key never reach the browser.
function moaApi(env: Record<string, string>): Plugin {
  const handler: Connect.NextHandleFunction = async (req, res: ServerResponse, next) => {
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
      const { execConfigFromEnv, vaultStatus, forOwner, createVault, serviceOn } = await import('./server/executor.ts');
      const session = await import('./server/session.ts');
      const secret = session.sessionSecret(env);
      const host = String(req.headers.host ?? '');
      // Who is asking: the wallet that logged in, or nobody. Every vault action below is for that wallet's own vault.
      const who = session.fromHeader(secret, req.headers.authorization);
      const base = execConfigFromEnv(env);
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
      if (req.url === '/api/vault' && req.method === 'GET') return send(200, { ...(await vaultStatus(await forOwner(base, who))), signedIn: !!who });
      // Make the logged-in wallet's vault. The server pays the gas; the wallet is the owner.
      if (req.url === '/api/vault/create' && req.method === 'POST') {
        if (!(await posted())) return;
        if (!who) return send(401, { error: 'Log in first.' });
        if (!serviceOn(base)) return send(503, { error: 'This server cannot make vaults.' });
        const r = await createVault(base, who);
        console.log(`[moa] vault for ${who}: ${r.ok ? r.vault : r.reason}`);
        return send(r.ok ? 200 : 409, r);
      }
      const cfg = await forOwner(base, who);
      // Diagnostics: is the Anthropic key loaded, from where, and does a real call work? Never returns the key.
      if (req.url?.startsWith('/api/health') && req.method === 'GET') {
        const { existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = process.cwd();
        const files = ['.env', '.env.local', '.env.development', '.env.development.local'].filter((f) => existsSync(join(dir, f)));
        const key = env.ANTHROPIC_API_KEY ?? '';
        const out: Record<string, unknown> = { envDir: dir, envFiles: files, anthropicKey: key ? `set (${key.length} chars, starts ${key.slice(0, 7)}…)` : 'missing', factory: env.MOA_FACTORY_ADDRESS ? 'configured' : 'not configured' };
        if (key && req.url.includes('ping')) {
          try {
            const { default: Anthropic } = await import('@anthropic-ai/sdk');
            const { MODEL } = await import('./server/moaAgent.ts');
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
        const { runMoa } = await import('./server/moaAgent.ts');
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
        if (!['HSK', 'ETH', 'BTC'].includes(asset) || (side !== 'buy' && side !== 'sell') || !Number.isFinite(amount) || amount <= 0) return send(400, { error: 'Invalid order.' });
        const { executeTrade } = await import('./server/executor.ts');
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
    name: 'moa-api',
    configureServer: (s) => { s.middlewares.use(handler); },
    configurePreviewServer: (s) => { s.middlewares.use(handler); },
  };
}

const HK = { target: 'https://api-glb.hashkey.com', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/hk/, '') };

// The stylesheet is written in the pixels measured at a 1440px screen. This turns them into rem (14px = 1rem) so the
// whole interface grows with the root font size on larger screens (set by media queries in styles.css). Hairlines
// (under 2px), the root size itself and media queries stay in pixels.
const pxToRem: AcceptedPlugin = {
  postcssPlugin: 'moa-px-to-rem',
  Declaration(decl) {
    if ((decl.parent as { selector?: string } | undefined)?.selector === 'html' || !decl.value.includes('px')) return;
    decl.value = decl.value.replace(/(\d*\.?\d+)px/g, (m, n: string) => (Number(n) < 2 ? m : `${+(Number(n) / 14).toFixed(4)}rem`));
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  console.log(`[moa] env from ${process.cwd()} · ANTHROPIC_API_KEY ${env.ANTHROPIC_API_KEY ? 'loaded' : 'MISSING (put it in hsk-agent/.env.local)'}`);
  if (env.MOA_EFFORT && !process.env.MOA_EFFORT) process.env.MOA_EFFORT = env.MOA_EFFORT;
  return {
    base: './',
    plugins: [moaApi(env)],
    css: { postcss: { plugins: [pxToRem] } },
    // HashKey Global goes through this server too, so a browser extension or network rule that blocks
    // api-glb.hashkey.com in the browser does not leave the trade screen empty.
    server: { host: '127.0.0.1', port: 5180, strictPort: true, proxy: { '/hk': HK } },
    preview: { host: '127.0.0.1', port: 4180, strictPort: true, proxy: { '/hk': HK } },
  };
});
