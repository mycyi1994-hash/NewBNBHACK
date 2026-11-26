// Compile src/MoaVault.sol with solc-js (no network download needed). Writes out/MoaVault.json (abi + bytecode).
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/MoaVault.sol'), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'MoaVault.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
const c = out.contracts['MoaVault.sol'].MoaVault;
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'out/MoaVault.json'), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2));
// The exact compiler input, for verifying the source on the block explorer ("Solidity (Standard JSON input)").
fs.writeFileSync(path.join(root, 'out/MoaVault.standard-input.json'), JSON.stringify(input, null, 2) + '\n');
console.log('compiled MoaVault with', solc.version(), '- bytecode', c.evm.bytecode.object.length / 2, 'bytes');
