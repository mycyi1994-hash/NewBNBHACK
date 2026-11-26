// Publishes the contracts' source on the HSK Chain block explorer (Blockscout), so anyone can read what is deployed.
// Needs no key: it uploads the compiler input that produced the deployed bytecode. Run it after deploy-mainnet.mjs.
//
//   node scripts/verify.mjs               the factory: submit, then wait until the explorer shows it as verified
//   node scripts/verify.mjs vault 0x…     the vault of that owner (the explorer often recognises it once one vault is verified)
//   add --check                           only report whether it is verified
//
// If the upload is refused, the same thing can be done by hand: on the contract's explorer page choose
// Contract → Verify & publish → "Solidity (Standard JSON input)", compiler v0.8.26+commit.8a97fa7a, licence MIT,
// and upload out/standard-input.json. The factory's constructor arguments are in deployments/hsk-mainnet.json.
import { existsSync, readFileSync } from 'node:fs';
import { encodeAbiParameters, isAddress, getAddress, zeroAddress } from 'viem';
import { EXPLORER, FORK, artifact, client, record, fail } from './hsk.mjs';

if (FORK) fail('a local fork has no explorer to verify on.');
const rec = record();
if (!rec?.factory) fail('deployments/hsk-mainnet.json is missing: deploy first.');
const input = new URL(`../${rec.verify.standardJsonInput}`, import.meta.url);
if (!existsSync(input)) fail(`${rec.verify.standardJsonInput} is missing: run "node scripts/compile.cjs".`);

const args = process.argv.slice(2).filter((a) => a !== '--check');
let target = { address: rec.factory, name: 'MoaVaultFactory', constructorArgs: rec.verify.factoryConstructorArguments };
if (args[0] === 'vault') {
  if (!isAddress(args[1] ?? '')) fail('usage: verify.mjs vault <owner address>');
  const owner = getAddress(args[1]);
  const pub = client();
  const vault = await pub.readContract({ address: rec.factory, abi: artifact('MoaVaultFactory').abi, functionName: 'vaultOf', args: [owner] });
  if (vault === zeroAddress) fail(`${owner} has no vault yet.`);
  const tokens = Object.values(rec.markets).map((m) => m.token), pools = Object.values(rec.markets).map((m) => m.pool);
  const values = [owner, rec.agent, rec.usdt, rec.router, BigInt(rec.limits.maxTradeUsdt), BigInt(rec.limits.maxDailyUsdt), rec.limits.maxSlippageBps, tokens, pools];
  target = { address: vault, name: 'MoaVault', constructorArgs: encodeAbiParameters(artifact('MoaVault').abi.find((x) => x.type === 'constructor').inputs, values) };
}

const api = `${EXPLORER}/api/v2/smart-contracts/${target.address}`;
const page = `${EXPLORER}/address/${target.address}?tab=contract`;
const verified = async () => {
  const r = await fetch(api);
  return r.ok && (await r.json()).is_verified === true;
};

if (await verified()) { console.log(`${target.name} is already verified: ${page}`); process.exit(0); }
if (process.argv.includes('--check')) { console.log(`${target.name} is not verified yet.`); process.exit(1); }

const form = new FormData();
form.set('compiler_version', rec.verify.compiler);
form.set('contract_name', target.name);
form.set('license_type', 'mit');
form.set('autodetect_constructor_args', 'false');
form.set('constructor_args', target.constructorArgs.replace(/^0x/, ''));
form.set('files[0]', new Blob([readFileSync(input)], { type: 'application/json' }), 'standard-input.json');
const r = await fetch(`${api}/verification/via/standard-input`, { method: 'POST', body: form });
const text = await r.text();
if (!r.ok) fail(`the explorer answered ${r.status}: ${text.slice(0, 300)}\nVerify by hand instead (see the top of this file).`);
console.log(`Submitted ${target.name}. Waiting for the explorer…`);
for (let i = 0; i < 30; i++) {
  await new Promise((done) => setTimeout(done, 4000));
  if (await verified()) { console.log(`Verified: ${page}`); process.exit(0); }
}
fail('the explorer has not marked it verified after two minutes. Look at the contract page, or verify by hand (see the top of this file).');
