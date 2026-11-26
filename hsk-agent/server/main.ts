// Moa in production: one Node process that serves the built app (dist/), the API, and the agents on "auto".
//   npm run build && npm start
// Settings come from the environment (on a host such as Render, from its dashboard; locally, from .env.local):
//   PORT, ANTHROPIC_API_KEY, MOA_FACTORY_ADDRESS, MOA_AGENT_PRIVATE_KEY, MOA_RPC_URL, MOA_DATA_DIR, MOA_SESSION_SECRET
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createApi } from './api.ts';

// A local .env.local is read the simple way: KEY=value lines. A real environment variable always wins.
const envFile = resolve('.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const dist = resolve('dist');
if (!existsSync(join(dist, 'index.html'))) { console.error('dist/index.html is missing: run "npm run build" first.'); process.exit(1); }
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const HASHKEY = 'https://api-glb.hashkey.com';

const api = createApi(process.env);
const server = createServer((req, res) => {
  void api.handler(req, res, () => {
    const url = new URL(req.url ?? '/', 'http://x');
    // HashKey Global's market data, passed through so the browser does not depend on reaching it directly.
    if (url.pathname.startsWith('/hk/')) {
      fetch(HASHKEY + url.pathname.slice(3) + url.search, { signal: AbortSignal.timeout(10_000) })
        .then(async (r) => { res.statusCode = r.status; res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json'); res.end(Buffer.from(await r.arrayBuffer())); })
        .catch(() => { res.statusCode = 502; res.end('{"error":"market data is not reachable"}'); });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
    // A file from dist/, or the app itself for any other path.
    const wanted = normalize(join(dist, decodeURIComponent(url.pathname)));
    const file = wanted.startsWith(dist) && existsSync(wanted) && statSync(wanted).isFile() ? wanted : join(dist, 'index.html');
    res.statusCode = 200;
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    // Built files carry a hash in their name and never change; the page itself is always fetched fresh.
    res.setHeader('cache-control', file.includes(`${join(dist, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  });
});

const port = Number(process.env.PORT || 4180);
server.listen(port, '0.0.0.0', () => {
  console.log(`[moa] listening on :${port} · Anthropic key ${process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING'} · factory ${process.env.MOA_FACTORY_ADDRESS ?? 'not set (demo mode)'}`);
  api.startAuto();
});
