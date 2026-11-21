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
      if (req.url === '/api/moa' && req.method === 'POST') {
        if (!env.ANTHROPIC_API_KEY) return send(503, { error: 'ANTHROPIC_API_KEY is not set on the server.' });
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const { history } = JSON.parse(raw) as { history: { role: 'user' | 'assistant'; content: string }[] };
        const { runMoa } = await import('./server/moaAgent.ts');
        return send(200, await runMoa(env.ANTHROPIC_API_KEY, cfg, history.slice(-20)));
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    plugins: [moaApi(env)],
    server: { host: '127.0.0.1', port: 5180, strictPort: true },
    preview: { host: '127.0.0.1', port: 4180, strictPort: true },
  };
});
