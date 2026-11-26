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
    try {
      const { execConfigFromEnv, vaultStatus } = await import('./server/executor.ts');
      const cfg = execConfigFromEnv(env);
      if (req.url === '/api/vault' && req.method === 'GET') return send(200, await vaultStatus(cfg));
      // Diagnostics: is the Anthropic key loaded, from where, and does a real call work? Never returns the key.
      if (req.url?.startsWith('/api/health') && req.method === 'GET') {
        const { existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = process.cwd();
        const files = ['.env', '.env.local', '.env.development', '.env.development.local'].filter((f) => existsSync(join(dir, f)));
        const key = env.ANTHROPIC_API_KEY ?? '';
        const out: Record<string, unknown> = { envDir: dir, envFiles: files, anthropicKey: key ? `set (${key.length} chars, starts ${key.slice(0, 7)}…)` : 'missing', vault: env.MOA_VAULT_ADDRESS ? 'configured' : 'not configured' };
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
      // JSON from this origin only, so another website cannot post an order to a local server.
      if (req.url === '/api/agent-trade' && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) return send(415, { error: 'Send JSON.' });
        const origin = req.headers.origin;
        let sameOrigin = true;
        try { if (origin) sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
        if (!sameOrigin) return send(403, { error: 'Orders from another origin are refused.' });
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw) as { asset?: unknown; side?: unknown; amount?: unknown; note?: unknown };
        const asset = String(body.asset), side = body.side, amount = Number(body.amount);
        if (!['HSK', 'ETH', 'BTC'].includes(asset) || (side !== 'buy' && side !== 'sell') || !Number.isFinite(amount) || amount <= 0) return send(400, { error: 'Invalid order.' });
        const { executeTrade } = await import('./server/executor.ts');
        const r = await executeTrade(cfg, { asset: asset as 'HSK' | 'ETH' | 'BTC', side, amount, note: String(body.note ?? '').slice(0, 120) });
        console.log(`[moa] agent order ${side} ${amount} ${asset}: ${r.ok ? r.txHash : r.reason}`);
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
