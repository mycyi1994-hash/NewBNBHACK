/**
 * Refuses a Cloudflare build of apps/web that carries variables from .env files (G2-2).
 *
 * The OpenNext build copies every variable of the .env, .env.production, .env.local and
 * .env.production.local files it finds, in apps/web and at the repository root (where the
 * worker's keys live), into the Worker bundle (.open-next/cloudflare/next-env.mjs), and the Worker
 * loads them into process.env. The web holds no key (SPEC §5 v2), so such a build is deleted
 * before anything can deploy it. Worker settings go in wrangler.jsonc `vars`, secrets in Worker
 * secrets. Prints variable names, never values.
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.open-next');
const envModule = path.join(output, 'cloudflare', 'next-env.mjs');

if (!existsSync(envModule)) {
  console.error('cf-env-guard: .open-next/cloudflare/next-env.mjs not found; run pnpm cf:build');
  process.exit(1);
}
/** One object of variables per Next.js mode (production, development, test). */
const modes = await import(pathToFileURL(envModule).href);
const names = [...new Set(Object.values(modes).flatMap((vars) => Object.keys(vars)))].sort();
if (names.length > 0) {
  rmSync(output, { recursive: true, force: true });
  console.error(
    `cf-env-guard: the build carried ${names.length} variable(s) from .env files into the ` +
      `Worker (${names.join(', ')}); deleted .open-next/. Build from a checkout without .env ` +
      'files in apps/web and at the repository root.',
  );
  process.exit(1);
}
console.log('cf-env-guard: no .env variables in the Worker bundle');
