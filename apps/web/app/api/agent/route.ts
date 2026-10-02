/**
 * GET /api/agent — Yieldvest's ERC-8004 registration file (DECISIONS D-33): name, description, the
 * read-only MCP server and the site, and the registry entry once AGENT_ID is set. `pnpm
 * agent:register` puts exactly this file on chain. No database, nothing signed.
 */
import { registrationFile } from '../../../lib/agent-card';
import { context } from '../../../lib/server/context';
import { json } from '../../../lib/server/http';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const { config } = context();
  return json(registrationFile(config.appUrl, config.agent.id));
}
