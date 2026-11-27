// Deploys MoaVaultFactory to HSK Chain mainnet: the contract that makes one MoaVault per user.
//
//   node scripts/deploy-mainnet.mjs --from 0x…    dry run: checks everything and shows the plan and its gas cost. Sends nothing.
//   node scripts/deploy-mainnet.mjs --send        the same checks, then asks you to type "deploy", then sends 1 transaction.
//
// Options (each also has an environment variable):
//   --from 0x…           MOA_DEPLOYER_ADDRESS   the deploying wallet's address, for a dry run. With --send it comes from the key.
//   --agent 0x…          MOA_AGENT_ADDRESS      the agent wallet's address. Left out: taken from the agent key in ../.env.local
//                                               (scripts/agent-key.mjs makes it). The agent's key itself is never needed here.
//   --max-trade 50       MOA_MAX_TRADE_USDT     what every new vault starts with as its per-trade limit in USDT (default 50)
//   --max-daily 100      MOA_MAX_DAILY_USDT     what every new vault starts with as its per-day limit in USDT (default 100)
//   --slippage-bps 150   MOA_MAX_SLIPPAGE_BPS   what every new vault starts with as its slippage ceiling, 150 = 1.5% (default 150)
//   --stop-loss-bps 1500 MOA_STOP_LOSS_BPS      what every new vault starts with as its stop-loss, 1500 = 15% (default 1500)
//   --guardian 0x…       MOA_GUARDIAN_ADDRESS   may halt agent trading on every vault at once (default: the deploying wallet)
// Version 3: the factory refuses to start vaults with no limit or no stop-loss (at most 10,000 USDT a day, a stop-loss of
// 1% to 50%, slippage up to 3%). Each owner may change or remove them afterwards in the app's account menu (or
// scripts/vault.mjs limits / stop), so the default protects someone who never looks.
//
// The deploying wallet pays the gas and gets nothing else. The guardian can halt and resume agent trading on all vaults
// (if the agent key may have leaked) and nothing more: no funds, no limits, no withdrawals, never the stop-loss.
// Keep the guardian key off the server. Each vault belongs to its own user, who can change its limits and agent.
// The key (--send only) is read from MOA_OWNER_PRIVATE_KEY, or asked for with the typing hidden; it is never stored.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createWalletClient, http, isAddress, getAddress, formatEther, encodeDeployData, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN, RPC, ROUTER, USDT, MARKETS, FORK, WHERE, RECORD, artifact, client, checkAddresses, confirm, option, ownerKey, cap, limitOf, same, txUrl, fail, EXPLORER } from './hsk.mjs';

const send = process.argv.includes('--send');
const address = (text, what) => {
  if (!text || !isAddress(text)) fail(`${what} is missing or is not a valid address. An address with a wrong capital letter is refused: paste it exactly.`);
  return getAddress(text);
};

// the agent's address: given, or derived from the key agent-key.mjs wrote (the key stays in that file)
const envLocal = new URL('../../.env.local', import.meta.url);
const agentKey = existsSync(envLocal) ? /^MOA_AGENT_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(envLocal, 'utf8'))?.[1] : undefined;
const agent = address(option('agent', 'MOA_AGENT_ADDRESS') ?? (agentKey ? privateKeyToAccount(agentKey).address : undefined), 'The agent address (run scripts/agent-key.mjs first, or pass --agent)');

const key = send ? await ownerKey('the deploying wallet') : null;
if (send && !key) fail('the key is missing or is not a 64-hex private key.');
const account = key ? privateKeyToAccount(key) : null;
const from = account?.address ?? address(option('from', 'MOA_DEPLOYER_ADDRESS') ?? option('owner', 'MOA_OWNER_ADDRESS'), 'The deploying wallet\'s address (--from 0x…)');
if (same(from, agent)) fail('deploy from your own wallet, not from the agent wallet: the agent\'s key sits on a server.');

const maxDaily = limitOf(option('max-daily', 'MOA_MAX_DAILY_USDT') ?? '100');
const maxTradeAsked = limitOf(option('max-trade', 'MOA_MAX_TRADE_USDT') ?? '50');
const maxTrade = maxTradeAsked > maxDaily ? maxDaily : maxTradeAsked;   // no per-trade limit under a daily limit = the daily limit
const slip = Number(option('slippage-bps', 'MOA_MAX_SLIPPAGE_BPS') ?? 150);
const stop = Number(option('stop-loss-bps', 'MOA_STOP_LOSS_BPS') ?? 1500);
if (!(Number.isInteger(stop) && stop >= 100 && stop <= 5000)) fail('stop-loss: 100 to 5000 bps (the factory refuses to start vaults without one).');
if (maxTrade <= 0n || maxDaily <= 0n || maxDaily > 10_000_000_000n || !(Number.isInteger(slip) && slip > 0 && slip <= 300)) fail('starting limits: above 0, at most 10,000 USDT a day, and slippage 1 to 300 bps.');
const guardianAsked = option('guardian', 'MOA_GUARDIAN_ADDRESS');

const pub = client();
const { abi, bytecode } = artifact('MoaVaultFactory');
const tokens = Object.values(MARKETS).map((m) => m.token), pools = Object.values(MARKETS).map((m) => m.pool);
const guardian = guardianAsked ? address(guardianAsked, 'The guardian address') : from;
if (same(guardian, agent)) fail('the guardian must not be the agent wallet: it is the switch for when the agent key is in doubt.');
const args = [agent, USDT, ROUTER, maxTrade, maxDaily, slip, stop, tokens, pools, guardian];

console.log(`\nMoaVaultFactory → ${WHERE} (${RPC})\n`);
const problems = await checkAddresses(pub);
if (problems.length) fail(`address checks failed:\n  - ${problems.join('\n  - ')}`);
console.log('Checked on-chain: chain id 177, USDT is a 6-decimal token called USDT, and the WHSK, WETH and WBTC pools each hold');
console.log('their token and USDT, have liquidity, charge 0.3%, and come from the same factory as the router.\n');

const [balance, gasPrice, agentBalance, agentCode] = await Promise.all([pub.getBalance({ address: from }), pub.getGasPrice(), pub.getBalance({ address: agent }), pub.getCode({ address: agent })]);
if (agentCode && agentCode !== '0x') fail('the agent address is a contract, not a wallet.');
const gas = await pub.estimateGas({ account: from, data: encodeDeployData({ abi, bytecode, args }) }).catch(() => 2_600_000n);
const cost = gas * gasPrice;
const VAULT_GAS = 1_800_000n;   // measured on a fork: making one user's vault uses about 1.76M gas
const hsk = (v) => Number(formatEther(v)).toFixed(2);

console.log(`  deploying wallet (pays the gas, gets no control)   ${from}`);
console.log(`  agent (trades for every vault, inside its limits)  ${agent}`);
console.log(`  each new vault starts with                         per trade: ${cap(maxTrade)} · per day: ${cap(maxDaily)} · ${slip / 100}% slippage ceiling · stop-loss: ${stop ? `${stop / 100}%` : 'off'}`);
console.log('                                                     (each owner sets their own limits and stop-loss afterwards)');
console.log(`  guardian (may halt agent trading on every vault)   ${guardian}`);
console.log(`  markets                                            ${Object.keys(MARKETS).join(', ')} against USDT on HSKSwap`);
console.log('  transactions                                       1 (the factory)');
console.log(`  estimated gas                                      ${gas} × ${Number(gasPrice) / 1e9} gwei ≈ ${hsk(cost)} HSK`);
console.log(`  deploying wallet balance                           ${hsk(balance)} HSK${balance < cost * 2n ? '   ← too little: keep at least twice the estimate' : ''}`);
console.log(`  agent balance                                      ${hsk(agentBalance)} HSK   (making one user's vault costs it about ${hsk(VAULT_GAS * gasPrice)} HSK, one trade about ${hsk(300_000n * gasPrice)})`);
console.log('\n  Nothing in the factory can be changed later, the agent included; the guardian can only halt and resume agent trading. No funds move in this step.\n');

if (!send) { console.log('Dry run: nothing was sent. Run again with --send to deploy.\n'); process.exit(0); }
if (balance < cost) fail('the deploying wallet does not have enough HSK for gas.');
await confirm('deploy', `This sends 1 transaction from ${from} on ${WHERE}.`);

const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
const hash = await wallet.deployContract({ abi, bytecode, args });
console.log(`  deploy: ${txUrl(hash)}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') fail('the deployment reverted.');
const factory = receipt.contractAddress;

// A record of what was deployed, for the README and for verifying the source on the explorer. No secrets in it.
mkdirSync(new URL('./', RECORD), { recursive: true });
writeFileSync(RECORD, JSON.stringify({
  chainId: 177, factory, deployer: from, agent, guardian, usdt: USDT, router: ROUTER, markets: MARKETS,
  limits: { maxTradeUsdt: maxTrade.toString(), maxDailyUsdt: maxDaily.toString(), maxSlippageBps: slip, stopLossBps: stop },
  transactions: { deploy: hash }, deployedAt: new Date().toISOString(),
  verify: {
    compiler: 'v0.8.26+commit.8a97fa7a', optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun',
    standardJsonInput: 'out/standard-input.json',
    factoryConstructorArguments: encodeAbiParameters(abi.find((x) => x.type === 'constructor').inputs, args),
  },
}, null, 2) + '\n');

console.log(`\nDeployed. Factory: ${factory}\n  ${EXPLORER}/address/${factory}`);
console.log('\nNext:\n  1. Add this line to hsk-agent/.env.local, then restart the app:');
console.log(`       MOA_FACTORY_ADDRESS=${factory}`);
console.log('  2. Publish the source on the explorer:   node scripts/verify.mjs');
console.log('  3. In the app: log in with your wallet. Your vault is made for you; deposit USDT from the account menu.');
console.log(`  Wrote ${FORK ? 'deployments/local-fork.json' : 'deployments/hsk-mainnet.json'} (addresses and verification settings; no keys).\n`);
