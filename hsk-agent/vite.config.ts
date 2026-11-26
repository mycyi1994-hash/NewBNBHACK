import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import type { AcceptedPlugin } from 'postcss';

// The server API (server/api.ts) for local dev and `vite preview`: the Anthropic key and the agent key never reach
// the browser. The same code runs behind server/main.ts in production. It is loaded on first use so that the
// config itself stays light.
function moaApi(env: Record<string, string>): Plugin {
  let api: Promise<{ handler: (req: Connect.IncomingMessage, res: ServerResponse, next: () => void) => Promise<unknown>; startAuto: () => () => void }> | undefined;
  const load = () => (api ??= import('./server/api.ts').then((m) => m.createApi(env)));
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next();
    void load().then((a) => a.handler(req, res, next), (e: unknown) => { res.statusCode = 500; res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); });
  };
  // The agents on "auto" run here too, so the whole thing can be tried on one machine.
  const auto = () => { void load().then((a) => a.startAuto(), () => undefined); };
  return {
    name: 'moa-api',
    configureServer: (s) => { s.middlewares.use(handler); auto(); },
    configurePreviewServer: (s) => { s.middlewares.use(handler); auto(); },
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
