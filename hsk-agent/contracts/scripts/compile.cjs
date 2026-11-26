// Compile the contracts with solc-js (no network download needed).
// Writes out/MoaVault.json and out/MoaVaultFactory.json (abi + bytecode) and out/standard-input.json: the exact
// compiler input, for verifying the source on the block explorer ("Solidity (Standard JSON input)").
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const root = path.join(__dirname, '..');
const files = ['MoaVault.sol', 'MoaVaultFactory.sol'];
const input = {
  language: 'Solidity',
  sources: Object.fromEntries(files.map((f) => [f, { content: fs.readFileSync(path.join(root, 'src', f), 'utf8') }])),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
// "./MoaVault.sol" inside the factory resolves to the source named "MoaVault.sol" above.
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
for (const f of files) {
  const name = f.replace('.sol', '');
  const c = out.contracts[f][name];
  fs.writeFileSync(path.join(root, `out/${name}.json`), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2) + '\n');
  console.log(`compiled ${name} with ${solc.version()} - deployed size ${c.evm.deployedBytecode.object.length / 2} bytes`);
}
fs.writeFileSync(path.join(root, 'out/standard-input.json'), JSON.stringify(input, null, 2) + '\n');
