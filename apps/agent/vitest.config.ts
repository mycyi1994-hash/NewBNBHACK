import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijaro/agent',
    // The DB tests get their own database (test/db.ts), created and migrated once here.
    globalSetup: ['./test/migrate-once.ts'],
    // Guardian verdicts and the job queue are global: one file at a time.
    fileParallelism: false,
  },
});
