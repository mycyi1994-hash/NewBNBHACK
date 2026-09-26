import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijaro/web',
    // The route tests get their own database (test/db.ts), created and migrated once here.
    globalSetup: ['./test/migrate-once.ts'],
    // Route handlers read their configuration from the environment, as in production.
    setupFiles: ['./test/env.ts'],
    // Tape runs, guardian events and the job queue are global: one file at a time.
    fileParallelism: false,
  },
});
