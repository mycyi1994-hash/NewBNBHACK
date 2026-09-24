import { defineConfig } from 'vitest/config';

// One run covers every workspace package; each package is its own project so failures
// are reported per package (`pnpm test --project @ijaro/binance`).
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'scripts'],
    passWithNoTests: true,
    // `pnpm coverage:core` (SPEC §12: the pure domain package stays at 100%). With one project
    // selected, `include` resolves against that project's root, hence `src/…`.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reporter: ['text'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
