import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @ijaro/db db:generate` writes SQL migrations to ./drizzle (committed).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
});
