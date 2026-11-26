// A vault owner's controls from the command line. The app's account menu does deposit and withdraw; this is the
// same and more, for when the app is not at hand.
//
//   node scripts/vault.mjs status 0x…             the vault of that owner: what it holds and its limits (reads only, no key)
//   node scripts/vault.mjs create                 make my vault (the app normally does this for you when you log in)
//   node scripts/vault.mjs fund 20                send 20 USDT from my wallet to my vault
//   node scripts/vault.mjs withdraw USDT 20       take 20 USDT back to my wallet (also WHSK, WETH, WBTC; "all" for everything)
//   node scripts/vault.mjs pause | unpause        stop or allow the agent's trades on my vault
//   node scripts/vault.mjs limits 10 30 150       per-trade USDT, per-day USDT, slippage ceiling in bps
//   node scripts/vault.mjs agent 0x…              replace my vault's agent wallet (e.g. if its key may have leaked)
//
// The factory address comes from MOA_FACTORY_ADDRESS, or from deployments/hsk-mainnet.json.
// Everything except `status` needs the vault owner's key: MOA_OWNER_PRIVATE_KEY if set, otherwise asked for with the
// typing hidden (never written to a file, never printed). Each command shows what it will do and asks you to type a word first.
import { createWalletClient, http, isAddress, getAddress, parseUnits, formatUnits, formatEther, encodeFunctionData, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN, RPC, USDT, MARKETS, ERC20, FORK, WHERE, artifact, client, confirm, ownerKey, record, txUrl, usd, same, fail, EXPLORER } from './hsk.mjs';

const [cmd = 'status', ...rest] = process.argv.slice(2);
const factory = process.env.MOA_FACTORY_ADDRESS || record()?.factory;
if (!factory || !isAddress(factory)) fail('no factory address: set MOA_FACTORY_ADDRESS or deploy first.');
const pub = client();
const { abi } = artifact('MoaVault');
const factoryAbi = artifact('MoaVaultFactory').abi;
const TOKENS = { USDT: { token: USDT, decimals: 6 }, ...Object.fromEntries(Object.entries(MARKETS).map(([name, m]) => [name, { token: m.token, decimals: m.decimals }])) };
const balanceOf = (token, who) => pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
const amountOf = (text, decimals) => { try { return parseUnits(text ?? '', decimals); } catch { return 0n; } };
const vaultOf = async (owner) => {
  const code = await pub.getCode({ address: factory });
  if (!code || code === '0x') fail(`there is no contract at ${factory} on this chain.`);
  const v = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'vaultOf', args: [owner] });
  return v === zeroAddress ? null : v;
};

async function status(vault) {
  const read = (functionName, args = []) => pub.readContract({ address: vault, abi, functionName, args });
  const [owner, agent, paused, maxTrade, maxDaily, slip, left] = await Promise.all(['owner', 'agent', 'paused', 'maxTradeUsdt', 'maxDailyUsdt', 'maxSlippageBps', 'remainingToday'].map((f) => read(f)));
  console.log(`\nVault ${vault}\n  ${EXPLORER}/address/${vault}`);
  console.log(`  owner   ${owner}`);
  console.log(`  agent   ${agent}   (${Number(formatEther(await pub.getBalance({ address: agent }))).toFixed(2)} HSK for gas)`);
  console.log(`  limits  $${usd(maxTrade)} per trade · $${usd(maxDaily)} per day ($${usd(left)} left today) · ${Number(slip) / 100}% slippage ceiling${paused ? '   PAUSED' : ''}`);
  for (const [name, t] of Object.entries(TOKENS)) {
    const bal = await balanceOf(t.token, vault);
    const market = name === 'USDT' ? null : await read('markets', [t.token]);
    console.log(`  ${name.padEnd(5)} ${formatUnits(bal, t.decimals)}${market ? (market[3] ? '   (listed)' : '   (not listed)') : ''}`);
  }
  console.log('');
}

if (cmd === 'status' && rest[0]) {
  if (!isAddress(rest[0])) fail('usage: status <owner address>');
  const v = await vaultOf(getAddress(rest[0]));
  if (!v) { console.log(`\n${rest[0]} has no vault yet.\n`); process.exit(0); }
  await status(v);
  process.exit(0);
}
if (!['status', 'create', 'fund', 'withdraw', 'pause', 'unpause', 'limits', 'agent'].includes(cmd)) fail(`unknown command "${cmd}". See the top of this file.`);

const key = await ownerKey('the vault owner\'s wallet');
if (!key) fail(cmd === 'status' ? 'usage: status <owner address>' : 'the key is missing or is not a 64-hex private key.');
const account = privateKeyToAccount(key);
const chainId = await pub.getChainId();
if (chainId !== 177 && !FORK) fail(`chain id is ${chainId}, expected 177.`);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
let vault = await vaultOf(account.address);

const run = async (what, word, tx) => {
  await confirm(word, `${what}\nFrom ${account.address} on ${WHERE}.`);
  const hash = await wallet.sendTransaction(tx);
  console.log(`  sent: ${txUrl(hash)}`);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(r.status === 'success' ? '  done.' : '  REVERTED.');
  vault = await vaultOf(account.address);
  if (vault) await status(vault);
};

if (cmd === 'create') {
  if (vault) { console.log(`\n${account.address} already has a vault.`); await status(vault); process.exit(0); }
  await run(`Make the vault of ${account.address}. It starts empty; this costs gas only.`, 'create', { to: factory, data: encodeFunctionData({ abi: factoryAbi, functionName: 'createVault', args: [account.address] }) });
  process.exit(0);
}
if (!vault) fail(`${account.address} has no vault yet. Log in to the app, or run: node scripts/vault.mjs create`);
const owner = await pub.readContract({ address: vault, abi, functionName: 'owner' });
if (!same(owner, account.address)) fail(`this key is ${account.address}, but the vault's owner is ${owner}.`);
await status(vault);
const call = (functionName, args) => ({ to: vault, data: encodeFunctionData({ abi, functionName, args }) });

if (cmd === 'status') process.exit(0);
if (cmd === 'fund') {
  const amount = amountOf(rest[0], 6);
  if (amount <= 0n) fail('usage: fund <USDT amount>');
  const have = await balanceOf(USDT, account.address);
  if (have < amount) fail(`this wallet holds ${usd(have)} USDT, less than ${usd(amount)}.`);
  await run(`Send ${usd(amount)} USDT to the vault. Only the owner can take it back out.`, 'fund', { to: USDT, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [vault, amount] }) });
} else if (cmd === 'withdraw') {
  const name = (rest[0] ?? '').toUpperCase();
  const t = TOKENS[name];
  if (!t) fail('usage: withdraw <USDT|WHSK|WETH|WBTC> <amount|all>');
  const bal = await balanceOf(t.token, vault);
  const amount = rest[1] === 'all' ? bal : amountOf(rest[1], t.decimals);
  if (amount <= 0n || amount > bal) fail(`the vault holds ${formatUnits(bal, t.decimals)} ${name}.`);
  await run(`Withdraw ${formatUnits(amount, t.decimals)} ${name} from the vault to the owner.`, 'withdraw', call('withdraw', [t.token, amount]));
} else if (cmd === 'pause' || cmd === 'unpause') {
  await run(cmd === 'pause' ? 'Pause the vault: the agent cannot trade until you unpause.' : 'Unpause the vault: the agent can trade again.', cmd, call('setPaused', [cmd === 'pause']));
} else if (cmd === 'limits') {
  const [a, b, c] = rest;
  const trade = amountOf(a, 6), daily = amountOf(b, 6), bps = Number(c);
  if (trade <= 0n || daily < trade || !(bps > 0 && bps <= 1000)) fail('usage: limits <per-trade USDT> <per-day USDT> <slippage bps, 1 to 1000>');
  await run(`Set limits to $${usd(trade)} per trade, $${usd(daily)} per day, ${bps / 100}% slippage ceiling.`, 'limits', call('setLimits', [trade, daily, bps]));
} else if (cmd === 'agent') {
  if (!isAddress(rest[0] ?? '')) fail('usage: agent <new agent address>');
  if (same(rest[0], owner)) fail('the agent must be a different wallet from the owner.');
  await run(`Replace the agent wallet with ${rest[0]}. The old one can no longer trade.`, 'agent', call('setAgent', [getAddress(rest[0])]));
}
