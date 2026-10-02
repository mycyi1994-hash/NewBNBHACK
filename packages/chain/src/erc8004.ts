/**
 * ERC-8004 agent identity on BNB Smart Chain (DECISIONS D-28, D-33): the identity registry, the
 * calls a registration makes, and the registration file in the exact bytes BNB Agent Studio's SDK
 * writes (`@bnbagent/sdk` 0.6.0, `AgentURIGenerator`, read in its source): `type`
 * registration-v1, `services` of `{ name, endpoint, version? }`, `registrations` of
 * `{ agentId, agentRegistry: "eip155:56:<registry>" }` once the registry has assigned an id, kept
 * on chain as the file's canonical JSON (keys sorted, no spaces, every character from U+007F
 * escaped) in a base64 data URI. apps/web/test/agent-card.test.ts builds the same URI with the
 * SDK itself.
 */
import { decodeEventLog, getAddress, isAddressEqual, parseAbi, type Address, type Log } from 'viem';

/** The identity registry on BSC mainnet ("AgentIdentity" / "AGENT"), dx/LOG 2026-09-27 14:11. */
export const ERC8004_REGISTRY_BSC: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
/** The registry as a registration file names it: chain 56, then the registry address. */
export const ERC8004_AGENT_REGISTRY = `eip155:56:${ERC8004_REGISTRY_BSC}`;
export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
const DATA_URI_PREFIX = 'data:application/json;base64,';

/** The registry calls and events a registration uses (the SDK's ABI, trimmed to those). */
export const identityRegistryAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function register(string agentURI) returns (uint256)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

export interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
}

export interface AgentRegistration {
  agentId: number;
  agentRegistry: string;
}

export interface RegistrationFile {
  type: typeof REGISTRATION_TYPE;
  name: string;
  description: string;
  image: string;
  services: AgentService[];
  registrations: AgentRegistration[];
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`canonicalJson: not a finite number (${value})`);
  }
  return value;
}

/** Keys sorted at every level, no spaces, every character from U+007F escaped — the SDK's. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)).replace(
    /[\u007f-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** The agent URI the registry stores: the canonical JSON in a base64 data URI. */
export function agentUri(file: RegistrationFile): string {
  return `${DATA_URI_PREFIX}${Buffer.from(canonicalJson(file), 'utf-8').toString('base64')}`;
}

/** The registration file inside an agent URI, checked like a fetched one; null if not a data URI. */
export function fileFromAgentUri(uri: string): RegistrationFile | null {
  if (!uri.startsWith(DATA_URI_PREFIX)) return null;
  const json = Buffer.from(uri.slice(DATA_URI_PREFIX.length), 'base64').toString('utf-8');
  return parseRegistrationFile(JSON.parse(json) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exactly these keys: what the file may carry is what the SDK writes, nothing smuggled in. */
function keysAre(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:';
}

/**
 * A registration file as JSON hands it over (the site's /api/agent, or a URI read on chain),
 * validated to the shape above; anything else throws with the reason.
 */
export function parseRegistrationFile(value: unknown): RegistrationFile {
  const fail = (why: string): never => {
    throw new Error(`registration file: ${why}`);
  };
  if (!isRecord(value)) return fail('not a JSON object');
  if (!keysAre(value, ['type', 'name', 'description', 'image', 'services', 'registrations'])) {
    return fail(`unexpected keys (${Object.keys(value).sort().join(', ')})`);
  }
  const { type, name, description, image, services, registrations } = value;
  if (type !== REGISTRATION_TYPE) fail(`type is not ${REGISTRATION_TYPE}`);
  if (typeof name !== 'string' || name.trim() === '') fail('name is empty');
  if (typeof description !== 'string' || description.trim() === '') fail('description is empty');
  if (typeof image !== 'string' || (image !== '' && !isWebUrl(image))) {
    fail('image is not an http(s) URL');
  }
  if (!Array.isArray(services) || services.length === 0) fail('services is empty');
  if (!Array.isArray(registrations)) fail('registrations is not a list');
  const serviceList = (services as unknown[]).map((service, i): AgentService => {
    if (!isRecord(service) || !keysAre(service, ['name', 'endpoint'], ['version'])) {
      return fail(`services[${i}] is not { name, endpoint, version? }`);
    }
    if (typeof service.name !== 'string' || service.name === '') {
      fail(`services[${i}].name is empty`);
    }
    if (!isWebUrl(service.endpoint)) fail(`services[${i}].endpoint is not an http(s) URL`);
    if (service.version !== undefined && typeof service.version !== 'string') {
      fail(`services[${i}].version is not text`);
    }
    return {
      name: service.name as string,
      endpoint: service.endpoint as string,
      ...(service.version === undefined ? {} : { version: service.version as string }),
    };
  });
  const registrationList = (registrations as unknown[]).map((entry, i): AgentRegistration => {
    if (!isRecord(entry) || !keysAre(entry, ['agentId', 'agentRegistry'])) {
      return fail(`registrations[${i}] is not { agentId, agentRegistry }`);
    }
    if (!Number.isSafeInteger(entry.agentId) || (entry.agentId as number) < 0) {
      fail(`registrations[${i}].agentId is not a whole number`);
    }
    if (typeof entry.agentRegistry !== 'string') fail(`registrations[${i}].agentRegistry`);
    return { agentId: entry.agentId as number, agentRegistry: entry.agentRegistry as string };
  });
  return {
    type: REGISTRATION_TYPE,
    name: name as string,
    description: description as string,
    image: image as string,
    services: serviceList,
    registrations: registrationList,
  };
}

/**
 * The identity a `register` receipt created: the registry's own `Registered` log only — a log of
 * the same shape from another contract in the receipt is not ours (the SDK filters the same way).
 */
export function registeredAgent(
  logs: readonly Pick<Log, 'address' | 'data' | 'topics'>[],
  registry: string = ERC8004_REGISTRY_BSC,
): { agentId: bigint; owner: Address; agentUri: string } | null {
  for (const log of logs) {
    if (!isAddressEqual(log.address, getAddress(registry))) continue;
    try {
      const decoded = decodeEventLog({
        abi: identityRegistryAbi,
        eventName: 'Registered',
        data: log.data,
        topics: log.topics,
      });
      return {
        agentId: decoded.args.agentId,
        owner: getAddress(decoded.args.owner),
        agentUri: decoded.args.agentURI,
      };
    } catch {
      // Another event of the registry (Transfer, MetadataSet …): keep looking.
    }
  }
  return null;
}
