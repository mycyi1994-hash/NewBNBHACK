/** pnpm agent:register's decisions (DECISIONS D-33): what it registers, and when it refuses. */
import {
  ERC8004_AGENT_REGISTRY,
  MAX_GAS_LIMIT,
  MAX_GAS_PRICE_WEI,
  REGISTRATION_TYPE,
  type RegistrationFile,
} from '@yieldvest/chain';
import { describe, expect, it } from 'vitest';
import {
  broadcastRefusals,
  fileProblem,
  IDENTITY_MAX_FEE_WEI,
  nextStep,
  paddedGas,
  registeredProblem,
  siteProblem,
  type SendFacts,
} from './agent-register-rules.js';

const SITE = 'https://yieldvest.example';
const IDENTITY = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const file = (over: Partial<RegistrationFile> = {}): RegistrationFile => ({
  type: REGISTRATION_TYPE,
  name: 'Yieldvest',
  description: 'Buys tokenized US stocks with interest.',
  image: `${SITE}/icon.svg`,
  services: [
    { name: 'MCP', endpoint: `${SITE}/api/mcp`, version: '2025-11-25' },
    { name: 'web', endpoint: `${SITE}/` },
  ],
  registrations: [],
  ...over,
});

describe('siteProblem', () => {
  it('lets a dry run read any http(s) site, a local one included', () => {
    expect(siteProblem('http://localhost:3000', false)).toBeUndefined();
    expect(siteProblem(SITE, false)).toBeUndefined();
    expect(siteProblem('ftp://example.com', false)).toMatch(/http\(s\)/);
    expect(siteProblem('not a url', false)).toMatch(/not a URL/);
  });

  it('puts only a public https site on chain', () => {
    expect(siteProblem(SITE, true)).toBeUndefined();
    expect(siteProblem('http://yieldvest.example', true)).toMatch(/https/);
    for (const host of [
      'localhost:3000',
      'app.localhost',
      '127.0.0.1',
      '10.0.0.8',
      '192.168.1.2',
      '172.20.0.1',
      '[::1]',
      'box.local',
    ]) {
      expect(siteProblem(`https://${host}`, true), host).toMatch(/public/);
    }
    expect(siteProblem('https://172.32.0.1', true)).toBeUndefined();
  });
});

describe('fileProblem', () => {
  it('takes the site’s own file with no registry entry before the id exists', () => {
    expect(fileProblem(file(), SITE, undefined)).toBeUndefined();
  });

  it('refuses a file that points away from the site', () => {
    const away = file({ services: [{ name: 'MCP', endpoint: 'https://elsewhere.example/mcp' }] });
    expect(fileProblem(away, SITE, undefined)).toMatch(/points away.*elsewhere/);
    expect(fileProblem(file({ image: 'https://cdn.example/x.svg' }), SITE, undefined)).toMatch(
      /cdn\.example/,
    );
  });

  it('refuses a registry entry before the id is set here', () => {
    const named = file({ registrations: [{ agentId: 7, agentRegistry: ERC8004_AGENT_REGISTRY }] });
    expect(fileProblem(named, SITE, undefined)).toMatch(/already names agent 7/);
  });

  it('wants exactly AGENT_ID’s entry once the id is set', () => {
    const named = file({ registrations: [{ agentId: 7, agentRegistry: ERC8004_AGENT_REGISTRY }] });
    expect(fileProblem(named, SITE, '7')).toBeUndefined();
    expect(fileProblem(named, SITE, '007')).toBeUndefined();
    expect(fileProblem(file(), SITE, '7')).toMatch(/set AGENT_ID=7 on the web deploy/);
    expect(fileProblem(named, SITE, '8')).toMatch(/not agent 8/);
    const elsewhere = file({ registrations: [{ agentId: 7, agentRegistry: 'eip155:97:0xabc' }] });
    expect(fileProblem(elsewhere, SITE, '7')).toMatch(/not agent 7 of eip155:56/);
  });
});

describe('nextStep', () => {
  const uri = 'data:application/json;base64,e30=';

  it('registers when the wallet holds no identity and no id is set', () => {
    expect(nextStep({ identity: IDENTITY, agentId: undefined, held: 0n, uri })).toEqual({
      kind: 'register',
    });
  });

  it('never registers a second agent for the same wallet', () => {
    const step = nextStep({ identity: IDENTITY, agentId: undefined, held: 1n, uri });
    expect(step).toMatchObject({ kind: 'refused' });
    expect(step.kind === 'refused' && step.reason).toMatch(/already holds 1 agent identity/);
  });

  it('writes the site’s file into the id this wallet owns, once', () => {
    const facts = { identity: IDENTITY, agentId: '7', held: 1n, owner: IDENTITY, uri };
    expect(nextStep({ ...facts, onChainUri: 'data:old' })).toEqual({
      kind: 'set-uri',
      agentId: 7n,
    });
    expect(nextStep({ ...facts, onChainUri: uri })).toEqual({ kind: 'current', agentId: 7n });
  });

  it('refuses an id that does not exist or is not this wallet’s', () => {
    const base = { identity: IDENTITY, agentId: '7', held: 0n, uri };
    expect(nextStep({ ...base, owner: null })).toEqual({
      kind: 'refused',
      reason: 'the registry has no agent 7',
    });
    expect(nextStep({ ...base, owner: OTHER })).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/belongs to 0x2222/) as unknown,
    });
  });
});

describe('broadcastRefusals', () => {
  const ok: SendFacts = {
    siteProblem: undefined,
    simulation: 'SUCCESS',
    gas: 700_000n,
    gasPrice: 50_000_000n,
    balance: 10n ** 16n,
    latestNonce: 3,
    pendingNonce: 3,
  };

  it('signs nothing unless every condition holds', () => {
    expect(broadcastRefusals(ok)).toEqual([]);
  });

  it.each([
    ['a local site', { siteProblem: 'the site on chain must be public' }, /public/],
    ['no Transaction API simulation', { simulation: 'skipped' as const }, /did not run/],
    ['a failed simulation', { simulation: 'FAILED' as const }, /simulation failed/],
    ['gas past the bound', { gas: MAX_GAS_LIMIT + 1n }, /above the 1500000 bound/],
    ['a gas price past the bound', { gasPrice: MAX_GAS_PRICE_WEI + 1n }, /gas price/],
    ['a wallet that cannot pay', { balance: 1n }, /holds 0\.000000000000000001 BNB/],
    ['a pending transaction', { pendingNonce: 4 }, /still pending \(nonce 3\)/],
  ])('refuses %s', (_label, change, reason) => {
    const refusals = broadcastRefusals({ ...ok, ...change });
    expect(refusals.join('; ')).toMatch(reason);
  });

  it('bounds the fee itself, whatever the gas and price', () => {
    // 1.5M gas at 0.7 gwei is within both bounds, and 0.00105 BNB — past the fee bound.
    const refusals = broadcastRefusals({ ...ok, gas: 1_500_000n, gasPrice: 700_000_000n });
    expect(refusals).toEqual([`gas of up to 0.00105 BNB is above the 0.001 BNB bound`]);
    expect(IDENTITY_MAX_FEE_WEI).toBe(10n ** 15n);
  });

  it('names every refusal at once', () => {
    expect(broadcastRefusals({ ...ok, simulation: 'skipped', balance: 0n })).toHaveLength(2);
  });
});

describe('paddedGas and registeredProblem', () => {
  it('pads the estimate by a fifth, rounding up', () => {
    expect(paddedGas(100_000n)).toBe(120_000n);
    expect(paddedGas(163_268n)).toBe(195_922n);
  });

  it('wants a Registered log naming this wallet', () => {
    expect(registeredProblem({ agentId: 7n, owner: IDENTITY }, IDENTITY)).toBeUndefined();
    expect(registeredProblem(null, IDENTITY)).toMatch(/no Registered log/);
    expect(registeredProblem({ agentId: 7n, owner: OTHER }, IDENTITY)).toMatch(/registered to 0x2/);
  });
});
