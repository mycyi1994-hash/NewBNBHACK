/**
 * Yieldvest's ERC-8004 registration file (DECISIONS D-33): what the identity registry on BSC points
 * at — the agent's name, what it does, and where to reach it (the read-only MCP server and the
 * site). GET /api/agent serves it; `pnpm agent:register` writes exactly what that route serves on
 * chain, so the site is the one source. The format and its bytes are @yieldvest/chain's (the
 * SDK's, checked against the SDK in test/agent-card.test.ts).
 */
import { ERC8004_AGENT_REGISTRY, REGISTRATION_TYPE, type RegistrationFile } from '@yieldvest/chain';
import { MCP_LATEST_VERSION } from './mcp-versions';

export const AGENT_NAME = 'Yieldvest';
/** Kept short: the registry stores the whole file on chain, and every 32 bytes cost gas. */
export const AGENT_DESCRIPTION =
  'Buys tokenized US stocks on BNB Smart Chain (bStocks, Ondo) with the interest of a USDT deposit in Venus, or a fixed amount, only in the US regular session, under hard per-buy and per-day caps. Every action has an on-chain receipt and a one-sentence reason. Rules decide, not a model. The MCP server is read-only.';

/** The registration file for the site at `appUrl`; `agentId` once the registry has assigned one. */
export function registrationFile(appUrl: string, agentId?: string): RegistrationFile {
  const base = new URL(appUrl);
  const at = (path: string) => new URL(path, base).href;
  return {
    type: REGISTRATION_TYPE,
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    image: at('/icon.svg'),
    services: [
      { name: 'MCP', endpoint: at('/api/mcp'), version: MCP_LATEST_VERSION },
      { name: 'web', endpoint: at('/') },
    ],
    registrations:
      agentId === undefined
        ? []
        : [{ agentId: Number(agentId), agentRegistry: ERC8004_AGENT_REGISTRY }],
  };
}
