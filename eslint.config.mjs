import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const CONFIG_ONLY = 'Read configuration through @yieldvest/config (loadConfig/parseConfig).';
const PROCESS_MODULE = '/^(node:)?process$/';
/**
 * The ways around a plain `process.env` ban: reaching `process` through the global object, giving
 * it another name, or importing it. Each is flagged where it starts, so what follows (`.env`,
 * destructuring, a later `proc.env`) cannot slip through. packages/config turns these off.
 */
const PROCESS_ENV_ESCAPES = [
  {
    // globalThis.process, global['process'] …: process reached through the global object.
    selector:
      "MemberExpression:matches([property.name='process'], [property.value='process'])" +
      ":matches([object.name='globalThis'], [object.name='global'], [object.name='window'], [object.name='self'])",
    message: `Use the process global itself, never through the global object. ${CONFIG_ONLY}`,
  },
  {
    // const proc = process; proc = process — an alias would hide proc.env from the ban.
    selector:
      "VariableDeclarator[id.type='Identifier'][init.type='Identifier'][init.name='process'], " +
      "AssignmentExpression[right.type='Identifier'][right.name='process']",
    message: `Do not alias process. ${CONFIG_ONLY}`,
  },
  {
    // import proc from 'node:process' (a default import named process stays allowed).
    selector: `ImportDeclaration[source.value=${PROCESS_MODULE}] > ImportDefaultSpecifier[local.name!='process']`,
    message: `Import process under its own name. ${CONFIG_ONLY}`,
  },
  {
    // require('node:process'), import('node:process'): process is a global; use it as such.
    selector:
      `CallExpression[callee.name='require'][arguments.0.value=${PROCESS_MODULE}], ` +
      `ImportExpression[source.value=${PROCESS_MODULE}]`,
    message: `Use the process global. ${CONFIG_ONLY}`,
  },
];

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'docs/vendor/**',
      'packages/db/drizzle/**',
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md rule 5: caps (and every other setting) are read only through @yieldvest/config.
      // process.env, process['env'] and const { env } = process:
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: CONFIG_ONLY },
      ],
      // import { env } from 'node:process', and namespace imports of it:
      'no-restricted-imports': [
        'error',
        {
          paths: ['process', 'node:process'].map((name) => ({
            name,
            importNames: ['env'],
            message: CONFIG_ONLY,
          })),
        },
      ],
      'no-restricted-syntax': ['error', ...PROCESS_ENV_ESCAPES],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The config package itself, test wiring, and doc-fetch tooling may read the environment.
    // (no-restricted-imports/-syntax carry only the process.env rules above.)
    files: [
      'packages/config/**',
      '**/*.test.ts',
      'packages/*/test/**',
      'apps/*/test/**',
      'scripts/fetch-docs-browser.mjs',
    ],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
    },
    settings: { next: { rootDir: 'apps/web' } },
  },
  prettier,
);
