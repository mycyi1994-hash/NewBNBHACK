/**
 * The agent tests' own database: `<test database>_agent`, next to the one @yieldvest/db's tests use.
 * Guardian verdicts, samples and the job queue are global by design, so the two projects — which
 * vitest runs at the same time — must not share them.
 */
const base = process.env.YIELDVEST_TEST_DATABASE_URL;

export function agentDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}_agent`;
  return parsed.toString();
}

export const agentTestUrl = base ? agentDatabaseUrl(base) : undefined;
