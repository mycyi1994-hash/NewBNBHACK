import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import type { ServerResponse } from 'node:http';

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
        const { history } = JSON.parse(raw) as { history: { role: 'user' | 'assistant'; content: string }[] };
        const { runMoa } = await import('./server/moaAgent.ts');
        // NDJSON stream: real progress steps while Claude works, then the final result
        res.statusCode = 200;
        res.setHeader('content-type', 'application/x-ndjson');
        res.setHeader('cache-control', 'no-cache');
        const write = (o: unknown) => res.write(JSON.stringify(o) + '\n');
        try {
          const result = await runMoa(env.ANTHROPIC_API_KEY, cfg, history.slice(-20), write);
          write({ type: 'done', result });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[moa] Anthropic call failed:', msg);
          write({ type: 'error', error: msg });
        }
        return res.end();
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  console.log(`[moa] env from ${process.cwd()} · ANTHROPIC_API_KEY ${env.ANTHROPIC_API_KEY ? 'loaded' : 'MISSING (put it in hsk-agent/.env.local)'}`);
  if (env.MOA_EFFORT && !process.env.MOA_EFFORT) process.env.MOA_EFFORT = env.MOA_EFFORT;
  return {
    base: './',
    plugins: [moaApi(env)],
    // HashKey Global goes through this server too, so a browser extension or network rule that blocks
    // api-glb.hashkey.com in the browser does not leave the trade screen empty.
    server: { host: '127.0.0.1', port: 5180, strictPort: true, proxy: { '/hk': HK } },
    preview: { host: '127.0.0.1', port: 4180, strictPort: true, proxy: { '/hk': HK } },
  };
});
