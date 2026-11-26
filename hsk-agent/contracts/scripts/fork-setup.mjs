// For local demos: deploy the MoaVaultFactory on a running HSK mainnet fork (npx hardhat node --port 8546), give a
// test wallet some USDT, and write ../.env.fork.local so `vite --mode fork` points the app at it.
// In the app, log in with that test wallet: its vault is made for it, and it can deposit. No real funds are used.
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8546';
const ROUTER = '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3';
const USDT = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029';
const MARKETS = {
  '0xB210D2120d57b758EE163cFfb43e73728c471Cf1': '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc', // WHSK
  '0xefd4bC9afD210517803f293ABABd701CaeeCdfd0': '0xb92b79ed6b370d5cfee2e14b1d0983c258304c16', // WETH
  '0x6119ca49a79f5825c8b345f8d7ac36b272565b14': '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a', // WBTC
};
// Hardhat's public test keys: only meaningful on a local fork
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const chain = { id: 177, name: 'HSK fork', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: 'hardhat', transport: http(RPC) });
const owner = privateKeyToAccount(OWNER_KEY);
const ownerW = createWalletClient({ account: owner, chain, transport: http(RPC) });

const factoryArtifact = JSON.parse(readFileSync(new URL('../out/MoaVaultFactory.json', import.meta.url)));
const agent = privateKeyToAccount(AGENT_KEY).address;
const factory = (await pub.waitForTransactionReceipt({ hash: await ownerW.deployContract({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode, args: [agent, USDT, ROUTER, 2n ** 256n - 1n, 2n ** 256n - 1n, 150, Object.keys(MARKETS), Object.values(MARKETS)] }) })).contractAddress;
// Give the first Hardhat test account 500 USDT (taken from the WHSK pool's balance) so it can log in and deposit.
const whale = MARKETS['0xB210D2120d57b758EE163cFfb43e73728c471Cf1'];
await test.impersonateAccount({ address: whale });
await test.setBalance({ address: whale, value: 10n ** 21n });
const transfer = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] }];
await pub.waitForTransactionReceipt({ hash: await createWalletClient({ account: whale, chain, transport: http(RPC) }).sendTransaction({ to: USDT, data: encodeFunctionData({ abi: transfer, functionName: 'transfer', args: [owner.address, 500_000_000n] }) }) });

writeFileSync(new URL('../../.env.fork.local', import.meta.url), [
  '# Local HSK mainnet fork (written by contracts/scripts/fork-setup.mjs). Test keys only.',
  `MOA_RPC_URL=${RPC}`, 'MOA_CHAIN_ID=177', `MOA_FACTORY_ADDRESS=${factory}`, `MOA_AGENT_PRIVATE_KEY=${AGENT_KEY}`, 'MOA_EXPLORER=https://hsk.blockscout.com', '',
].join('\n'));
console.log(`fork factory ${factory}: each vault starts with no limits and a 1.5% slippage ceiling. ${owner.address} holds 500 USDT. Wrote .env.fork.local`);
