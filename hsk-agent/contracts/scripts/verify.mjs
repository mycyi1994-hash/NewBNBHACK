// Publishes MoaVault's source on the HSK Chain block explorer (Blockscout), so anyone can read the deployed contract.
// Needs no key: it uploads the compiler input that produced the deployed bytecode. Run it after deploy-mainnet.mjs.
//
//   node scripts/verify.mjs            submit, then wait until the explorer shows the contract as verified
//   node scripts/verify.mjs --check    only report whether it is verified
//
// If the upload is refused, the same thing can be done by hand: on the vault's explorer page choose
// Contract → Verify & publish → "Solidity (Standard JSON input)", compiler v0.8.26+commit.8a97fa7a, licence MIT,
// and upload out/MoaVault.standard-input.json. The constructor arguments are in deployments/hsk-mainnet.json.
import { existsSync, readFileSync } from 'node:fs';
import { EXPLORER, RECORD, FORK } from './hsk.mjs';

const fail = (msg) => { console.error(`Cannot continue: ${msg}`); process.exit(1); };
if (FORK) fail('a local fork has no explorer to verify on.');
if (!existsSync(RECORD)) fail('deployments/hsk-mainnet.json is missing: deploy first.');
const { vault, verify } = JSON.parse(readFileSync(RECORD, 'utf8'));
const input = new URL(`../${verify.standardJsonInput}`, import.meta.url);
if (!existsSync(input)) fail(`${verify.standardJsonInput} is missing: run "node scripts/compile.cjs".`);

const api = `${EXPLORER}/api/v2/smart-contracts/${vault}`;
const verified = async () => {
  const r = await fetch(api);
  return r.ok && (await r.json()).is_verified === true;
};

if (await verified()) { console.log(`Already verified: ${EXPLORER}/address/${vault}?tab=contract`); process.exit(0); }
if (process.argv.includes('--check')) { console.log('Not verified yet.'); process.exit(1); }

const form = new FormData();
form.set('compiler_version', verify.compiler);
form.set('contract_name', 'MoaVault');
form.set('license_type', 'mit');
form.set('autodetect_constructor_args', 'false');
form.set('constructor_args', verify.constructorArguments.replace(/^0x/, ''));
form.set('files[0]', new Blob([readFileSync(input)], { type: 'application/json' }), 'MoaVault.standard-input.json');
const r = await fetch(`${api}/verification/via/standard-input`, { method: 'POST', body: form });
const text = await r.text();
if (!r.ok) fail(`the explorer answered ${r.status}: ${text.slice(0, 300)}\nVerify by hand instead (see the top of this file).`);
console.log('Submitted. Waiting for the explorer…');
for (let i = 0; i < 30; i++) {
  await new Promise((done) => setTimeout(done, 4000));
  if (await verified()) { console.log(`Verified: ${EXPLORER}/address/${vault}?tab=contract`); process.exit(0); }
}
fail('the explorer has not marked it verified after two minutes. Look at the contract page, or verify by hand (see the top of this file).');
