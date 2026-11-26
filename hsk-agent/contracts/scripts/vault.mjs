// The owner's controls for a deployed MoaVault on HSK Chain mainnet.
//
//   node scripts/vault.mjs status                 what the vault holds and its limits (reads only, no key needed)
//   node scripts/vault.mjs fund 20                send 20 USDT from the owner wallet to the vault
//   node scripts/vault.mjs withdraw USDT 20       take 20 USDT back to the owner (also WHSK, WETH, WBTC; "all" for everything)
//   node scripts/vault.mjs pause | unpause        stop or allow the agent's trades
//   node scripts/vault.mjs limits 10 30 150       per-trade USDT, per-day USDT, slippage ceiling in bps
//   node scripts/vault.mjs agent 0x…              replace the agent wallet (e.g. if its key may have leaked)
//
// The vault address comes from MOA_VAULT_ADDRESS, or from deployments/hsk-mainnet.json.
// Everything except `status` needs the owner's key: MOA_OWNER_PRIVATE_KEY if set, otherwise asked for with the typing
// hidden (never written to a file, never printed). Each command shows what it will do and asks you to type a word first.
import { existsSync, readFileSync } from 'node:fs';
import { createWalletClient, http, isAddress, parseUnits, formatUnits, formatEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN, RPC, USDT, MARKETS, ERC20, FORK, RECORD, artifact, client, confirm, ownerKey, txUrl, usd, same, EXPLORER } from './hsk.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const fail = (msg) => { console.error(`Cannot continue: ${msg}`); process.exit(1); };
const vault = process.env.MOA_VAULT_ADDRESS || (existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')).vault : undefined);
if (!vault || !isAddress(vault)) fail('no vault address: set MOA_VAULT_ADDRESS or deploy first.');
const pub = client();
const { abi } = artifact();
const TOKENS = {
  USDT: { token: USDT, decimals: 6 },
  WHSK: { token: MARKETS.WHSK.token, decimals: 18 },
  WETH: { token: MARKETS.WETH.token, decimals: 18 },
  WBTC: { token: MARKETS.WBTC.token, decimals: 8 },
};
const read = (functionName, args = []) => pub.readContract({ address: vault, abi, functionName, args });
const balanceOf = (token, who) => pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
const amountOf = (text, decimals) => { try { return parseUnits(text ?? '', decimals); } catch { return 0n; } };

async function status() {
  const code = await pub.getCode({ address: vault });
  if (!code || code === '0x') fail(`there is no contract at ${vault} on this chain.`);
  const [owner, agent, paused, maxTrade, maxDaily, slip, left] = await Promise.all(['owner', 'agent', 'paused', 'maxTradeUsdt', 'maxDailyUsdt', 'maxSlippageBps', 'remainingToday'].map((f) => read(f)));
  console.log(`\nVault ${vault}\n  ${EXPLORER}/address/${vault}`);
  console.log(`  owner   ${owner}`);
  console.log(`  agent   ${agent}   (${formatEther(await pub.getBalance({ address: agent }))} HSK for gas)`);
  console.log(`  limits  $${usd(maxTrade)} per trade · $${usd(maxDaily)} per day ($${usd(left)} left today) · ${Number(slip) / 100}% slippage ceiling${paused ? '   PAUSED' : ''}`);
  for (const [name, t] of Object.entries(TOKENS)) {
    const bal = await balanceOf(t.token, vault);
    const market = name === 'USDT' ? null : await read('markets', [t.token]);
    console.log(`  ${name.padEnd(5)} ${formatUnits(bal, t.decimals)}${market ? (market[3] ? '   (listed)' : '   (not listed)') : ''}`);
  }
  console.log('');
  return { owner };
}

if (!cmd || cmd === 'status') { await status(); process.exit(0); }

if (!['fund', 'withdraw', 'pause', 'unpause', 'limits', 'agent'].includes(cmd)) fail(`unknown command "${cmd}". See the top of this file.`);
const key = await ownerKey();
if (!key) fail('the owner key is missing or is not a 64-hex private key.');
const account = privateKeyToAccount(key);
const chainId = await pub.getChainId();
if (chainId !== 177 && !FORK) fail(`chain id is ${chainId}, expected 177.`);
const { owner } = await status();
if (!same(owner, account.address)) fail(`this key is ${account.address}, but the vault's owner is ${owner}.`);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
const run = async (what, word, tx) => {
  await confirm(word, `${what}\nFrom ${account.address} on ${FORK ? 'a LOCAL FORK' : 'HSK Chain mainnet'}.`);
  const hash = await wallet.sendTransaction(tx);
  console.log(`  sent: ${txUrl(hash)}`);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(r.status === 'success' ? '  done.' : '  REVERTED.');
  await status();
};
const call = (functionName, args) => ({ to: vault, data: encodeFunctionData({ abi, functionName, args }) });

if (cmd === 'fund') {
  const amount = amountOf(rest[0], 6);
  if (amount <= 0n) fail('usage: fund <USDT amount>');
  const have = await balanceOf(USDT, account.address);
  if (have < amount) fail(`the owner wallet holds ${usd(have)} USDT, less than ${usd(amount)}.`);
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
  await run(`Replace the agent wallet with ${rest[0]}. The old one can no longer trade.`, 'agent', call('setAgent', [rest[0]]));
} else fail(`unknown command "${cmd}". See the top of this file.`);
