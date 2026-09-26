import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijaro/db',
    // Migrate once before the test files run in parallel. Each file also calls migrateDb, and on a
    // fresh database (every CI run) two of them raced to create the same tables: ci run #8,
    // `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` on api_calls.
    globalSetup: ['./test/migrate-once.ts'],
    // The files share one database: caps, queues and locks are asserted on global state (sums
    // per UTC day, the oldest queued job), so they run one file at a time.
    fileParallelism: false,
  },
});
