// npm run test:ui: start the built app (server/main.ts serving dist/) on a free port with no keys (demo mode), run the
// Playwright smoke tests in tests/ui/*.test.mjs against it, stop the server. Builds dist/ first if it is missing.
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`, or a global install on
// NODE_PATH) and internet access: the screens read live market data from HashKey, Gate and HSK Chain.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
if (!existsSync(join(root, 'dist/index.html'))) {
  const b = spawnSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
const port = await new Promise((ok) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const env = { ...process.env, PORT: String(port), MOA_DATA_DIR: mkdtempSync(join(tmpdir(), 'moa-ui-')) };
// Demo mode: whatever keys this shell has are not passed to the server under test.
for (const k of ['ANTHROPIC_API_KEY', 'MOA_AGENT_PRIVATE_KEY', 'MOA_FACTORY_ADDRESS']) env[k] = '';
const server = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
  if (i > 100 || server.exitCode !== null) { console.error(`the server did not start:\n${log}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 200));
}
const files = readdirSync(join(root, 'tests/ui')).filter((f) => f.endsWith('.test.mjs')).map((f) => join('tests/ui', f));
const t = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, MOA_UI_BASE: base } });
server.kill();
process.exit(t.status ?? 1);
