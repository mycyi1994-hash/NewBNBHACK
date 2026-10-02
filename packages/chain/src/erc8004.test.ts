/** ERC-8004 registration file, agent URI and the `Registered` log (DECISIONS D-33). */
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  agentUri,
  canonicalJson,
  ERC8004_AGENT_REGISTRY,
  ERC8004_REGISTRY_BSC,
  fileFromAgentUri,
  identityRegistryAbi,
  parseRegistrationFile,
  registeredAgent,
  REGISTRATION_TYPE,
  type RegistrationFile,
} from './erc8004.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const file = (over: Partial<RegistrationFile> = {}): RegistrationFile => ({
  type: REGISTRATION_TYPE,
  name: 'Yieldvest',
  description: 'Buys tokenized US stocks with interest.',
  image: 'https://example.com/icon.svg',
  services: [
    { name: 'MCP', endpoint: 'https://example.com/api/mcp', version: '2025-11-25' },
    { name: 'web', endpoint: 'https://example.com/' },
  ],
  registrations: [],
  ...over,
});

describe('canonicalJson', () => {
  it('sorts keys at every level, keeps array order and leaves no spaces', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('escapes every character from U+007F, one UTF-16 unit at a time', () => {
    expect(canonicalJson({ s: 'é€\u007f😀' })).toBe('{"s":"\\u00e9\\u20ac\\u007f\\ud83d\\ude00"}');
    expect(canonicalJson('~')).toBe('"~"');
  });

  it('refuses numbers JSON cannot carry', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(TypeError);
  });
});

describe('agent URI', () => {
  it('is the canonical JSON in a base64 data URI, and reads back to the same file', () => {
    const uri = agentUri(file());
    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    const json = Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64');
    expect(json.toString('utf-8')).toBe(canonicalJson(file()));
    expect(fileFromAgentUri(uri)).toEqual(file());
  });

  it('is not read when it is not a data URI', () => {
    expect(fileFromAgentUri('https://example.com/api/agent')).toBeNull();
  });

  it('names the BSC registry as chain 56 and its address', () => {
    expect(ERC8004_AGENT_REGISTRY).toBe('eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
  });
});

describe('parseRegistrationFile', () => {
  it('takes the SDK shape, with or without a registration', () => {
    expect(parseRegistrationFile(file())).toEqual(file());
    const registered = file({
      registrations: [{ agentId: 42, agentRegistry: ERC8004_AGENT_REGISTRY }],
    });
    expect(parseRegistrationFile(JSON.parse(JSON.stringify(registered)))).toEqual(registered);
  });

  it.each([
    ['not an object', [], /not a JSON object/],
    ['an extra key', { ...file(), owner: OWNER }, /unexpected keys/],
    ['another type', { ...file(), type: 'registration-v2' }, /type is not/],
    ['no name', { ...file(), name: ' ' }, /name is empty/],
    ['no description', { ...file(), description: '' }, /description is empty/],
    ['an image that is not a web URL', { ...file(), image: 'javascript:alert(1)' }, /image/],
    ['no services', { ...file(), services: [] }, /services is empty/],
    [
      'a service endpoint that is not a web URL',
      { ...file(), services: [{ name: 'MCP', endpoint: 'ftp://example.com' }] },
      /services\[0\]\.endpoint/,
    ],
    [
      'a service with an extra key',
      { ...file(), services: [{ name: 'web', endpoint: 'https://example.com/', x: 1 }] },
      /services\[0\] is not/,
    ],
    [
      'a version that is not text',
      { ...file(), services: [{ name: 'MCP', endpoint: 'https://example.com/', version: 1 }] },
      /services\[0\]\.version/,
    ],
    [
      'an agent id that is not a whole number',
      { ...file(), registrations: [{ agentId: 1.5, agentRegistry: ERC8004_AGENT_REGISTRY }] },
      /agentId is not a whole number/,
    ],
    [
      'an agent id as text',
      { ...file(), registrations: [{ agentId: '7', agentRegistry: ERC8004_AGENT_REGISTRY }] },
      /agentId is not a whole number/,
    ],
    ['registrations that are not a list', { ...file(), registrations: {} }, /not a list/],
  ])('refuses %s', (_label, value, reason) => {
    expect(() => parseRegistrationFile(value)).toThrow(reason);
  });
});

describe('registeredAgent', () => {
  const registeredLog = (address: string, agentId: bigint, owner: string, uri: string) => ({
    address: address as Hex,
    topics: encodeEventTopics({
      abi: identityRegistryAbi,
      eventName: 'Registered',
      args: { agentId, owner: owner as Hex },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'string' }], [uri]),
  });
  const transferLog = {
    address: ERC8004_REGISTRY_BSC,
    topics: encodeEventTopics({
      abi: parseAbi([
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
      ]),
      eventName: 'Transfer',
      args: { from: '0x0000000000000000000000000000000000000000', to: OWNER, tokenId: 7n },
    }) as [Hex, ...Hex[]],
    data: '0x' as Hex,
  };

  it("reads the id, owner and URI from the registry's own log", () => {
    const logs = [transferLog, registeredLog(ERC8004_REGISTRY_BSC, 7n, OWNER, 'data:x')];
    expect(registeredAgent(logs)).toEqual({ agentId: 7n, owner: OWNER, agentUri: 'data:x' });
  });

  it('ignores the same event from another contract, and finds nothing without one', () => {
    expect(registeredAgent([registeredLog(OTHER, 9n, OWNER, 'data:y')])).toBeNull();
    expect(registeredAgent([transferLog])).toBeNull();
    expect(registeredAgent([])).toBeNull();
  });
});
