import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { challenge, fromHeader, issue, login, sessionSecret, whoIs } from './session.ts';

// Hardhat's public test keys: never funded on a real chain.
const alice = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const bob = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const secret = 'test-secret', host = 'moa.example', now = 1_800_000_000_000;

test('a wallet that signs the challenge gets a token that names it', async () => {
  const c = challenge(secret, alice.address, host, now)!;
  assert.match(c.message, /^moa\.example wants you to sign in with your Ethereum account:\n0x[0-9a-fA-F]{40}\n\n/);
  assert.match(c.message, /\nURI: https:\/\/moa\.example\nVersion: 1\nChain ID: 177\nNonce: [0-9a-f]{16}\nIssued At: /);
  assert.match(c.message, /sends no transaction/);
  const signature = await alice.signMessage({ message: c.message });
  const r = await login(secret, { address: alice.address.toLowerCase(), issuedAt: c.issuedAt, signature }, host, now + 5_000);
  assert.ok(r.ok);
  assert.equal(whoIs(secret, r.token, now + 60_000), alice.address);
  assert.equal(fromHeader(secret, `Bearer ${r.token}`, now + 60_000), alice.address);
});

test('a signature from another wallet, another site or an old request is refused', async () => {
  const c = challenge(secret, alice.address, host, now)!;
  const byBob = await bob.signMessage({ message: c.message });
  assert.equal((await login(secret, { address: alice.address, issuedAt: c.issuedAt, signature: byBob }, host, now)).ok, false);
  const byAlice = await alice.signMessage({ message: c.message });
  assert.equal((await login(secret, { address: alice.address, issuedAt: c.issuedAt, signature: byAlice }, 'evil.example', now)).ok, false);
  assert.equal((await login(secret, { address: alice.address, issuedAt: c.issuedAt, signature: byAlice }, host, now + 11 * 60_000)).ok, false);
  assert.equal((await login(secret, { address: bob.address, issuedAt: c.issuedAt, signature: byAlice }, host, now)).ok, false);
  assert.equal(challenge(secret, 'not-an-address', host, now), null);
});

test('a token that was altered, signed with another secret or has expired names nobody', () => {
  const token = issue(secret, alice.address, now + 1000);
  assert.equal(whoIs(secret, token, now), alice.address);
  assert.equal(whoIs(secret, token, now + 2000), null);
  assert.equal(whoIs('other-secret', token, now), null);
  const forged = `${Buffer.from(JSON.stringify({ a: bob.address, e: now + 1000 })).toString('base64url')}.${token.split('.')[1]}`;
  assert.equal(whoIs(secret, forged, now), null);
  assert.equal(whoIs(secret, undefined, now), null);
  assert.equal(fromHeader(secret, token, now), null);
});

test('the secret is stable when the agent key is set and never equals it', () => {
  const env = { MOA_AGENT_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' };
  assert.equal(sessionSecret(env), sessionSecret(env));
  assert.notEqual(sessionSecret(env), env.MOA_AGENT_PRIVATE_KEY);
  assert.equal(sessionSecret({ MOA_SESSION_SECRET: 'x' }), 'x');
});
