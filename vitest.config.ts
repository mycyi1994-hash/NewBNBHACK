import { defineConfig } from 'vitest/config';

// One run covers every workspace package; each package is its own project so failures
// are reported per package (`pnpm test --project @ijaro/binance`).
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'scripts'],
    passWithNoTests: true,
  },
});
