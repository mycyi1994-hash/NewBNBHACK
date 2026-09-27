/**
 * The web tests' own database: `<test database>_web`, next to the ones @yieldvest/db's and the agent's
 * tests use. Tape runs, guardian events and jobs are global by design, so the projects — which
 * vitest runs at the same time — must not share them.
 */
const base = process.env.YIELDVEST_TEST_DATABASE_URL;

export function webDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}_web`;
  return parsed.toString();
}

export const webTestUrl = base ? webDatabaseUrl(base) : undefined;
