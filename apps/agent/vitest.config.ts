import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijaro/agent',
    // The cycle tests use the database; migrateDb serializes with @ijaro/db's own setup.
    globalSetup: ['./test/migrate-once.ts'],
  },
});
