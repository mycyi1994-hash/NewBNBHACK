// Deploys MoaVault to HSK Chain mainnet and lists the three HSKSwap markets on it.
//
//   node scripts/deploy-mainnet.mjs --owner 0x…   dry run: checks everything and shows the plan and its gas cost. Sends nothing.
//   node scripts/deploy-mainnet.mjs --send        the same checks, then asks you to type "deploy", then sends 4 transactions.
//
// Options (each also has an environment variable):
//   --owner 0x…          MOA_OWNER_ADDRESS      the owner's address, for a dry run. With --send the address comes from the key.
//   --agent 0x…          MOA_AGENT_ADDRESS      the agent wallet's address. Left out: taken from the agent key in ../.env.local
//                                               (scripts/agent-key.mjs makes it). The agent's key itself is never needed here.
//   --max-trade 10       MOA_MAX_TRADE_USDT     per-trade limit in USDT (default 10)
//   --max-daily 30       MOA_MAX_DAILY_USDT     per-day limit in USDT (default 30)
//   --slippage-bps 150   MOA_MAX_SLIPPAGE_BPS   slippage ceiling, 150 = 1.5% (default 150)
// The owner's key (--send only) is read from MOA_OWNER_PRIVATE_KEY, or asked for with the typing hidden. It is never
// written to a file and never printed. The owner deploys, sets limits and is the only address that can withdraw.
// The owner cannot be changed after deployment. Funding the vault is a separate step (scripts/vault.mjs fund).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createWalletClient, http, isAddress, getAddress, parseUnits, formatEther, encodeDeployData, encodeFunctionData, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN, RPC, ROUTER, USDT, MARKETS, FORK, RECORD, artifact, client, checkAddresses, confirm, option, ownerKey, usd, same, txUrl, EXPLORER } from './hsk.mjs';

const send = process.argv.includes('--send');
const where = FORK ? 'a LOCAL FORK' : 'HSK Chain mainnet';
const fail = (msg) => { console.error(`\nCannot continue: ${msg}`); process.exit(1); };
const address = (text, what) => {
  if (!text || !isAddress(text)) fail(`${what} is missing or is not a valid address. An address with a wrong capital letter is refused: paste it exactly.`);
  return getAddress(text);
};

// the agent's address: given, or derived from the key agent-key.mjs wrote (the key stays in that file)
const envLocal = new URL('../../.env.local', import.meta.url);
const agentKey = existsSync(envLocal) ? /^MOA_AGENT_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(envLocal, 'utf8'))?.[1] : undefined;
const agent = address(option('agent', 'MOA_AGENT_ADDRESS') ?? (agentKey ? privateKeyToAccount(agentKey).address : undefined), 'The agent address (run scripts/agent-key.mjs first, or pass --agent)');

const key = send ? await ownerKey() : null;
if (send && !key) fail('the owner key is missing or is not a 64-hex private key.');
const account = key ? privateKeyToAccount(key) : null;
const owner = account?.address ?? address(option('owner', 'MOA_OWNER_ADDRESS'), 'The owner address (--owner 0x…)');
if (same(owner, agent)) fail('the owner and the agent must be different wallets: the agent\'s key sits on a server.');

const amount = (text) => { try { return parseUnits(text, 6); } catch { return 0n; } };
const maxTrade = amount(option('max-trade', 'MOA_MAX_TRADE_USDT') ?? '10');
const maxDaily = amount(option('max-daily', 'MOA_MAX_DAILY_USDT') ?? '30');
const slip = Number(option('slippage-bps', 'MOA_MAX_SLIPPAGE_BPS') ?? 150);
if (maxTrade <= 0n || maxDaily < maxTrade || !(Number.isInteger(slip) && slip > 0 && slip <= 1000)) fail('limits: per-trade must be above 0, per-day at least per-trade, slippage 1 to 1000 bps.');

const pub = client();
const { abi, bytecode } = artifact();
const args = [owner, agent, USDT, ROUTER, maxTrade, maxDaily, slip];

console.log(`\nMoaVault → ${where} (${RPC})\n`);
const problems = await checkAddresses(pub);
if (problems.length) fail(`address checks failed:\n  - ${problems.join('\n  - ')}`);
console.log('Checked on-chain: chain id 177, USDT is a 6-decimal token called USDT, and the WHSK, WETH and WBTC pools each hold');
console.log('their token and USDT, have liquidity, charge 0.3%, and come from the same factory as the router.\n');

const [balance, gasPrice, agentBalance, agentCode] = await Promise.all([pub.getBalance({ address: owner }), pub.getGasPrice(), pub.getBalance({ address: agent }), pub.getCode({ address: agent })]);
if (agentCode && agentCode !== '0x') fail('the agent address is a contract, not a wallet.');
const deployGas = await pub.estimateGas({ account: owner, data: encodeDeployData({ abi, bytecode, args }) }).catch(() => 1_600_000n);
const totalGas = deployGas + 3n * 120_000n;   // three setMarket calls, estimated generously (they need the vault to exist)
const cost = totalGas * gasPrice;
const tenTrades = 10n * 300_000n * gasPrice;   // a swap through the vault uses roughly 200–300k gas

console.log(`  owner (deploys, sets limits, only one who can withdraw)  ${owner}`);
console.log(`  agent (can only trade, inside the limits)                ${agent}`);
console.log(`  limits                                                   $${usd(maxTrade)} per trade · $${usd(maxDaily)} per day · ${slip / 100}% slippage ceiling`);
console.log(`  markets                                                  ${Object.keys(MARKETS).join(', ')} against USDT on HSKSwap`);
console.log('  transactions                                             4 (deploy, then one per market)');
console.log(`  estimated gas                                            ${totalGas} × ${Number(gasPrice) / 1e9} gwei ≈ ${Number(formatEther(cost)).toFixed(4)} HSK`);
console.log(`  owner balance                                            ${Number(formatEther(balance)).toFixed(4)} HSK${balance < cost * 2n ? '   ← too little: keep at least twice the estimate' : ''}`);
console.log(`  agent balance                                            ${Number(formatEther(agentBalance)).toFixed(4)} HSK${agentBalance < tenTrades ? `   ← send it HSK for gas: about ${Number(formatEther(tenTrades)).toFixed(1)} HSK covers ten trades` : ''}`);
console.log('\n  The owner cannot be changed later. The vault starts empty: no funds move in this step.\n');

if (!send) { console.log('Dry run: nothing was sent. Run again with --send to deploy.\n'); process.exit(0); }
if (balance < cost) fail('the owner does not have enough HSK for gas.');
await confirm('deploy', `This sends 4 transactions from ${owner} on ${where}.`);

const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
const wait = async (hash, what) => { console.log(`  ${what}: ${txUrl(hash)}`); const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') fail(`${what} reverted.`); return r; };

// The record is written as soon as the vault exists, so a failure half-way never loses its address. No secrets in it.
const record = {
  chainId: 177, vault: null, owner, agent, usdt: USDT, router: ROUTER, markets: MARKETS,
  limits: { maxTradeUsdt: maxTrade.toString(), maxDailyUsdt: maxDaily.toString(), maxSlippageBps: slip },
  transactions: {}, deployedAt: new Date().toISOString(),
  verify: {
    compiler: 'v0.8.26+commit.8a97fa7a', contract: 'MoaVault.sol:MoaVault', optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun',
    standardJsonInput: 'out/MoaVault.standard-input.json',
    constructorArguments: encodeAbiParameters(abi.find((x) => x.type === 'constructor').inputs, args),
  },
};
const save = () => { mkdirSync(new URL('./', RECORD), { recursive: true }); writeFileSync(RECORD, JSON.stringify(record, null, 2) + '\n'); };

record.transactions.deploy = await wallet.deployContract({ abi, bytecode, args });
const vault = (await wait(record.transactions.deploy, 'deploy')).contractAddress;
record.vault = vault;
save();
for (const [name, m] of Object.entries(MARKETS)) {
  record.transactions[name] = await wallet.sendTransaction({ to: vault, data: encodeFunctionData({ abi, functionName: 'setMarket', args: [m.token, m.pool, true] }) });
  await wait(record.transactions[name], `list ${name}`);
  save();
}

console.log(`\nDeployed. Vault: ${vault}\n  ${EXPLORER}/address/${vault}`);
console.log('\nNext:\n  1. Add this line to hsk-agent/.env.local, then restart the app:');
console.log(`       MOA_VAULT_ADDRESS=${vault}`);
console.log('  2. Publish the source on the explorer:   node scripts/verify.mjs');
console.log('  3. Fund the vault:                       node scripts/vault.mjs fund 20      (USDT from the owner wallet)');
console.log('  4. Check it:                             node scripts/vault.mjs status');
console.log(`  Wrote ${FORK ? 'deployments/local-fork.json' : 'deployments/hsk-mainnet.json'} (addresses and verification settings; no keys).\n`);
