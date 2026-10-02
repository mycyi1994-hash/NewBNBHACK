/**
 * The MCP protocol versions /api/mcp speaks, newest first (DECISIONS D-31). Its own module so the
 * ERC-8004 registration file (lib/agent-card.ts) can name the version without loading the
 * server's tools.
 */
export const MCP_LATEST_VERSION = '2025-11-25';
export const MCP_PROTOCOL_VERSIONS = [MCP_LATEST_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'];
