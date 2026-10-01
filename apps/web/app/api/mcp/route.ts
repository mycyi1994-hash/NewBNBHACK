/**
 * POST /api/mcp (DECISIONS D-31, F4) — Yieldvest's read-only MCP server over Streamable HTTP:
 * `claude mcp add --transport http yieldvest <app URL>/api/mcp`. One JSON-RPC message per POST,
 * one JSON answer. GET (a server-to-client stream) and DELETE (a session) are not offered: Next
 * answers 405 for methods a route does not export, as the transport allows.
 */
import { context } from '../../../lib/server/context';
import { clientIp, json, rateLimited, readJson } from '../../../lib/server/http';
import { MCP_PROTOCOL_VERSIONS, mcpReply, rpcError } from '../../../lib/server/mcp';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const { config, db } = context();
  // MCP transport: a browser page from another origin must not reach the server (DNS rebinding).
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(config.appUrl).origin) {
    return json(rpcError(null, -32600, 'origin not allowed'), 403);
  }
  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !MCP_PROTOCOL_VERSIONS.includes(version)) {
    return json(rpcError(null, -32600, `unsupported MCP-Protocol-Version ${version}`), 400);
  }
  if (rateLimited(`mcp:${clientIp(request)}`, 120, 60_000)) {
    return json(rpcError(null, -32000, 'too many requests, try again shortly'), 429);
  }
  const raw = await readJson(request);
  if (raw instanceof Response) {
    const { error } = (await raw.json()) as { error: { message: string } };
    return json(rpcError(null, -32700, error.message), raw.status);
  }
  if (raw === undefined) return json(rpcError(null, -32700, 'empty body'), 400);
  const reply = await mcpReply(raw, { db, config, now: new Date() });
  if (reply.status === 202) return new Response(null, { status: 202 });
  return json(reply.body, reply.status);
}
