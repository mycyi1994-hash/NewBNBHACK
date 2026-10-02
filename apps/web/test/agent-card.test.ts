/**
 * The ERC-8004 registration file (DECISIONS D-33) against BNB Agent Studio's own SDK: the agent URI
 * we put on chain must be byte for byte the one `@bnbagent/sdk` 0.6.0 builds from the same name,
 * description, image and endpoints (made with its MCP endpoint constructor), with and without an
 * agent id — so any reader of SDK-made registrations reads ours. And GET /api/agent serves it.
 */
import { AgentEndpoint, AgentURIGenerator } from '@bnbagent/sdk/erc8004';
import { agentUri, canonicalJson, ERC8004_REGISTRY_BSC } from '@yieldvest/chain';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_DESCRIPTION, AGENT_NAME, registrationFile } from '../lib/agent-card';
import { MCP_LATEST_VERSION, MCP_PROTOCOL_VERSIONS } from '../lib/mcp-versions';
import { GET as agentRoute } from '../app/api/agent/route';
import { context, resetContext } from '../lib/server/context';
import { call } from './harness';

const SITE = 'https://yieldvest.example';

/** The SDK's agent URI for our agent, from its own endpoint types. */
function sdkUri(agentId?: number): string {
  return AgentURIGenerator.generateAgentUri({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    image: `${SITE}/icon.svg`,
    endpoints: [
      AgentEndpoint.mcp(`${SITE}/api/mcp`, { version: MCP_LATEST_VERSION }),
      new AgentEndpoint({ name: 'web', endpoint: `${SITE}/` }),
    ],
    ...(agentId === undefined
      ? {}
      : { agentId, identityRegistry: ERC8004_REGISTRY_BSC, chainId: 56 }),
  });
}

describe('ERC-8004 registration file', () => {
  it('is the agent URI the SDK builds, before an id is assigned', () => {
    expect(agentUri(registrationFile(SITE))).toBe(sdkUri());
  });

  it('is the agent URI the SDK builds, with the registry entry once it is', () => {
    const file = registrationFile(SITE, '42');
    expect(file.registrations).toEqual([
      { agentId: 42, agentRegistry: 'eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' },
    ]);
    expect(agentUri(file)).toBe(sdkUri(42));
    expect(AgentURIGenerator.decodeRegistrationFileFromBase64(agentUri(file))).toEqual(file);
  });

  it('serializes like the SDK where the bytes could differ: key order and non-ASCII', () => {
    const tricky = { z: 'é€😀', a: [{ y: 1, b: null }], m: 'line\nbreak "quoted"' };
    const ours = Buffer.from(canonicalJson(tricky), 'utf-8').toString('base64');
    expect(ours).toBe(AgentURIGenerator.encodeRegistrationFileToBase64(tricky));
  });

  it("names the newest MCP version /api/mcp speaks, and only this site's addresses", () => {
    const file = registrationFile(`${SITE}/some/path`);
    expect(file.services).toEqual([
      { name: 'MCP', endpoint: `${SITE}/api/mcp`, version: MCP_PROTOCOL_VERSIONS[0] },
      { name: 'web', endpoint: `${SITE}/` },
    ]);
    expect(file.image).toBe(`${SITE}/icon.svg`);
  });

  it('stays small: the registry stores the whole URI on chain', () => {
    // About 22k gas per 32 bytes stored; ~1 KB keeps one registration well under 1M gas.
    expect(agentUri(registrationFile(SITE, '123456')).length).toBeLessThan(1100);
  });
});

describe('GET /api/agent', () => {
  afterEach(async () => {
    process.env.AGENT_ID = '';
    await resetContext();
  });

  it('serves the registration file, empty registrations without AGENT_ID', async () => {
    await resetContext();
    const res = await call(agentRoute, { path: '/api/agent' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(registrationFile(context().config.appUrl));
    expect(res.body.registrations).toEqual([]);
  });

  it('adds the registry entry once AGENT_ID is set', async () => {
    process.env.AGENT_ID = '42';
    await resetContext();
    const res = await call(agentRoute, { path: '/api/agent' });
    expect(res.body).toEqual(registrationFile(context().config.appUrl, '42'));
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});
