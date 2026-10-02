/**
 * The decisions of `pnpm agent:register` (DECISIONS D-33) as pure functions, so every refusal is a
 * unit test (agent-register-rules.test.ts); agent-register.ts does the I/O. One identity
 * transaction per run, gas only, from a wallet of its own.
 */
import {
  ERC8004_AGENT_REGISTRY,
  MAX_GAS_LIMIT,
  MAX_GAS_PRICE_WEI,
  type RegistrationFile,
} from '@yieldvest/chain';
import { fromUnits } from '@yieldvest/core';

/** At most this much gas money per identity transaction: a constant, no setting raises it. */
export const IDENTITY_MAX_FEE_WEI = 1_000_000_000_000_000n; // 0.001 BNB

export const bnb = (wei: bigint) => `${fromUnits(wei, 18)} BNB`;

/** The gas limit: the estimate plus a fifth (the SDK pads its estimate the same way), rounded up. */
export function paddedGas(estimate: bigint): bigint {
  return (estimate * 6n + 4n) / 5n;
}

/** Hosts nobody else can reach: never the address an on-chain identity points at. */
const PRIVATE_HOST =
  /^(localhost|.+\.localhost|.+\.local|.+\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

/** Why `site` cannot serve the file: any http(s) site for a dry run, a public https one on chain. */
export function siteProblem(site: string, broadcast: boolean): string | undefined {
  if (!URL.canParse(site)) return `the site ${site} is not a URL`;
  const url = new URL(site);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `the site must be an http(s) URL, not ${url.protocol}`;
  }
  if (!broadcast) return undefined;
  if (url.protocol !== 'https:') return `the site on chain must be https: ${site} is not`;
  if (PRIVATE_HOST.test(url.hostname)) {
    return `the site on chain must be public, not ${url.hostname}`;
  }
  return undefined;
}

/**
 * Why the file the site serves is not the one to put on chain for AGENT_ID (undefined: no id yet):
 * every address in it must be the site's own, and its registry entry must be exactly AGENT_ID's —
 * none before the registry assigns one.
 */
export function fileProblem(
  file: RegistrationFile,
  site: string,
  agentId: string | undefined,
): string | undefined {
  const origin = new URL(site).origin;
  const away = [file.image, ...file.services.map((s) => s.endpoint)].filter(
    (address) => address !== '' && new URL(address).origin !== origin,
  );
  if (away.length > 0) return `the file points away from ${origin}: ${away.join(', ')}`;
  const served = file.registrations.map((r) => `agent ${r.agentId} of ${r.agentRegistry}`);
  if (agentId === undefined) {
    return served.length === 0
      ? undefined
      : `the site already names ${served.join(', ')}: set AGENT_ID to that id here, or unset it on the site`;
  }
  const expected = `agent ${BigInt(agentId)} of ${ERC8004_AGENT_REGISTRY}`;
  return served.length === 1 && served[0] === expected
    ? undefined
    : `the site serves [${served.join(', ')}], not ${expected}: set AGENT_ID=${BigInt(agentId)} on the web deploy, redeploy it, then run again`;
}

export interface ChainFacts {
  /** The identity wallet's address. */
  identity: string;
  /** AGENT_ID, when set. */
  agentId: string | undefined;
  /** The agent identities the wallet holds (the registry's balanceOf). */
  held: bigint;
  /** ownerOf(AGENT_ID); null when the registry has no such agent. Read only with AGENT_ID. */
  owner?: string | null;
  /** tokenURI(AGENT_ID). Read only with AGENT_ID. */
  onChainUri?: string;
  /** The agent URI of the file the site serves. */
  uri: string;
}

export type Step =
  /** No id yet: register(agentURI) mints one. */
  | { kind: 'register' }
  /** The id exists and is this wallet's: setAgentURI(id, agentURI) makes it the site's file. */
  | { kind: 'set-uri'; agentId: bigint }
  /** The chain already holds the site's file for this id: nothing to send. */
  | { kind: 'current'; agentId: bigint }
  | { kind: 'refused'; reason: string };

/** Which transaction, if any, makes the chain hold the site's file (the SDK's two phases). */
export function nextStep(facts: ChainFacts): Step {
  if (facts.agentId === undefined) {
    if (facts.held > 0n) {
      return {
        kind: 'refused',
        reason: `${facts.identity} already holds ${facts.held} agent identit${facts.held === 1n ? 'y' : 'ies'}: set AGENT_ID to its id (BscScan lists the wallet's AGENT token); registering again would make a second agent`,
      };
    }
    return { kind: 'register' };
  }
  const agentId = BigInt(facts.agentId);
  if (!facts.owner) return { kind: 'refused', reason: `the registry has no agent ${agentId}` };
  if (facts.owner.toLowerCase() !== facts.identity.toLowerCase()) {
    return {
      kind: 'refused',
      reason: `agent ${agentId} belongs to ${facts.owner}, not to the identity wallet ${facts.identity}`,
    };
  }
  return facts.onChainUri === facts.uri
    ? { kind: 'current', agentId }
    : { kind: 'set-uri', agentId };
}

export interface SendFacts {
  /** siteProblem(site, true). */
  siteProblem: string | undefined;
  /** The Transaction API simulation's status; 'skipped' without API credentials. */
  simulation: 'SUCCESS' | 'FAILED' | 'skipped';
  /** The padded gas limit and the gas price the transaction would be signed with. */
  gas: bigint;
  gasPrice: bigint;
  /** The identity wallet's BNB, in wei. */
  balance: bigint;
  /** Its transaction count at the latest block and with pending ones. */
  latestNonce: number;
  pendingNonce: number;
}

/** Every reason --broadcast must not sign, so one run names them all; empty when it may. */
export function broadcastRefusals(facts: SendFacts): string[] {
  const refusals: string[] = [];
  if (facts.siteProblem) refusals.push(facts.siteProblem);
  if (facts.simulation === 'skipped') {
    refusals.push(
      'the Transaction API simulation did not run (BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET are needed)',
    );
  } else if (facts.simulation === 'FAILED') {
    refusals.push('the Transaction API simulation failed');
  }
  if (facts.gas > MAX_GAS_LIMIT)
    refusals.push(`gas ${facts.gas} is above the ${MAX_GAS_LIMIT} bound`);
  if (facts.gasPrice > MAX_GAS_PRICE_WEI) {
    refusals.push(`gas price ${facts.gasPrice} wei is above the ${MAX_GAS_PRICE_WEI} wei bound`);
  }
  const fee = facts.gas * facts.gasPrice;
  if (fee > IDENTITY_MAX_FEE_WEI) {
    refusals.push(`gas of up to ${bnb(fee)} is above the ${bnb(IDENTITY_MAX_FEE_WEI)} bound`);
  }
  if (facts.balance < fee) {
    refusals.push(
      `the identity wallet holds ${bnb(facts.balance)}; the gas needs up to ${bnb(fee)}`,
    );
  }
  if (facts.pendingNonce > facts.latestNonce) {
    refusals.push(
      `a transaction of the identity wallet is still pending (nonce ${facts.latestNonce}): wait for it to settle, then run again`,
    );
  }
  return refusals;
}

/** Why a mined `register` did not give this wallet its agent; undefined when it did. */
export function registeredProblem(
  found: { agentId: bigint; owner: string } | null,
  identity: string,
): string | undefined {
  if (!found) return 'the receipt has no Registered log from the registry';
  if (found.owner.toLowerCase() !== identity.toLowerCase()) {
    return `agent ${found.agentId} was registered to ${found.owner}, not to ${identity}`;
  }
  return undefined;
}
