/**
 * CLAUDE.md rule 5 as the linter enforces it: outside packages/config, no code may reach the
 * environment — not as process.env, and not around it (imports, globalThis, aliases).
 * Probes are linted as text at paths inside the repository with the real eslint.config.mjs; only
 * the three rules involved run, so no type information is needed.
 */
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { findWorkspaceRoot } from './index.js';

const ROOT = findWorkspaceRoot(import.meta.dirname) ?? '';
const RULES = ['no-restricted-properties', 'no-restricted-imports', 'no-restricted-syntax'];
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
  ruleFilter: ({ ruleId }) => RULES.includes(ruleId),
});

async function flagged(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

const ESCAPES = [
  'export const cap = process.env.X;',
  "export const cap = process['env'].X;",
  'const { env } = process; export const cap = env.X;',
  "import { env } from 'node:process'; export const cap = env.X;",
  "import { env as e } from 'process'; export const cap = e.X;",
  "export { env } from 'node:process';",
  "import * as proc from 'node:process'; export const cap = proc.env.X;",
  "import proc from 'node:process'; export const cap = proc.env.X;",
  'export const cap = globalThis.process.env.X;',
  "export const cap = globalThis['process']['env'].X;",
  'const { env } = globalThis.process; export const cap = env.X;',
  'const proc = globalThis.process; export const cap = proc.env.X;',
  'const proc = process; export const cap = proc.env.X;',
  'let proc; proc = process; export const cap = proc.env.X;',
  "const proc = require('node:process'); export const cap = proc.env.X;",
  "const { env } = await import('node:process'); export const cap = env.X;",
];

const ALLOWED = [
  'export const args = process.argv; const { argv } = process; export { argv };',
  "import process from 'node:process'; export const args = process.argv;",
  "import { argv, exit } from 'node:process'; export { argv, exit };",
  'export const job = { process: 1 }; export const step = job.process;',
  'export const cwd = process.cwd();',
];

describe('eslint: the environment is read only in packages/config', { timeout: 60_000 }, () => {
  it.each(ESCAPES)('flags `%s` in apps, packages and scripts (.ts and .mjs)', async (code) => {
    for (const file of [
      'apps/agent/src/probe.ts',
      'packages/core/src/probe.ts',
      'scripts/probe.mjs',
    ]) {
      expect(await flagged(code, file), file).toHaveLength(1);
    }
  });

  it.each(ALLOWED)('allows `%s`', async (code) => {
    expect(await flagged(code, 'apps/agent/src/probe.ts')).toEqual([]);
  });

  it('flags none of it inside packages/config', async () => {
    for (const code of ESCAPES) {
      expect(await flagged(code, 'packages/config/src/probe.ts')).toEqual([]);
    }
  });
});
