// A vault owner's controls from the command line. The app's account menu does deposit and withdraw; this is the
// same and more, for when the app is not at hand.
//
//   node scripts/vault.mjs status 0x…             the vault of that owner: what it holds and its limits (reads only, no key)
//   node scripts/vault.mjs create                 make my vault (the app normally does this for you when you log in)
//   node scripts/vault.mjs fund 20                send 20 USDT from my wallet to my vault
//   node scripts/vault.mjs withdraw USDT 20       take 20 USDT back to my wallet (also WHSK, WETH, WBTC; "all" for everything)
//   node scripts/vault.mjs pause | unpause        stop or allow the agent's trades on my vault
//   node scripts/vault.mjs limits 10 30 150       per-trade USDT, per-day USDT, slippage ceiling in bps ("none" for no limit)
//   node scripts/vault.mjs stop 10 | stop off     stop-loss: sell a holding once it is worth 10% less than it cost
//   node scripts/vault.mjs stopout WHSK           carry out a stop that is due (anyone's key works; the USDT stays in the vault)
//   node scripts/vault.mjs agent 0x…              replace my vault's agent wallet (e.g. if its key may have leaked)
//   node scripts/vault.mjs creator <agent> 0x… 0.5  approve the maker of one hired agent at up to 0.5% of its trades (version 3; "0" withdraws)
//   node scripts/vault.mjs budget <agent> 100      what one hired agent may still spend on buys, in USDT (version 3)
//   node scripts/vault.mjs budgets on | off        when on, every buy must fit the budget of the agent it is for (version 3)
//   (<agent> is the hired agent's id in the app; the vault keys it as keccak256 of that id)
//   node scripts/vault.mjs session 0x… 90 50       version 3: let agent key 0x… trade for 90 days, at most $50 a buy, on all
//                                                  three coins (add WHSK/WETH/WBTC names to narrow it)
//   node scripts/vault.mjs revoke                  version 3: end the agent key's session now
//
// The factory address comes from --factory 0x…, else MOA_FACTORY_ADDRESS, else deployments/hsk-mainnet.json.
// A vault made by an earlier factory still answers status, fund, withdraw, pause, limits and agent: add
// `--factory <that factory's address>` to reach it, for example to withdraw what is left in it.
// Everything except `status` needs the vault owner's key: MOA_OWNER_PRIVATE_KEY if set, otherwise asked for with the
// typing hidden (never written to a file, never printed). Each command shows what it will do and asks you to type a word first.
import { createWalletClient, http, isAddress, getAddress, parseUnits, formatUnits, formatEther, encodeFunctionData, zeroAddress, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN, RPC, USDT, MARKETS, ERC20, FORK, WHERE, artifact, client, confirm, option, ownerKey, record, txUrl, usd, cap, limitOf, same, fail, EXPLORER } from './hsk.mjs';

const words = process.argv.slice(2);
const flag = words.indexOf('--factory');
if (flag >= 0) words.splice(flag, 2);
const [cmd = 'status', ...rest] = words;
const factory = option('factory', 'MOA_FACTORY_ADDRESS') || record()?.factory;
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
  // a vault from the first factory has no stop-loss and does not report positions
  const stop = await read('stopLossBps').then(Number, () => null);
  console.log(`\nVault ${vault}\n  ${EXPLORER}/address/${vault}`);
  console.log(`  owner   ${owner}`);
  console.log(`  agent   ${agent}   (${Number(formatEther(await pub.getBalance({ address: agent }))).toFixed(2)} HSK for gas)`);
  console.log(`  limits  per trade: ${cap(maxTrade)} · per day: ${cap(maxDaily)}${cap(maxDaily) === 'no limit' ? '' : ` ($${usd(left)} left today)`} · ${Number(slip) / 100}% slippage ceiling · stop-loss: ${stop === null ? 'not in this version of the vault' : stop ? `${stop / 100}%` : 'off'}${paused ? '   PAUSED' : ''}`);
  for (const [name, t] of Object.entries(TOKENS)) {
    const bal = await balanceOf(t.token, vault);
    const market = name === 'USDT' ? null : await read('markets', [t.token]);
    const pos = market && bal > 0n ? await read('position', [t.token]).catch(() => null) : null;
    console.log(`  ${name.padEnd(5)} ${formatUnits(bal, t.decimals)}${market ? (market[3] ? '   (listed)' : '   (not listed)') : ''}${pos ? `   cost $${usd(pos[1])} · worth $${usd(pos[2])}${pos[3] ? ` · stop under $${usd(pos[3])}` : ''}` : ''}`);
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
if (!['status', 'create', 'fund', 'withdraw', 'pause', 'unpause', 'limits', 'stop', 'agent', 'creator', 'budget', 'budgets', 'session', 'revoke'].includes(cmd)) fail(`unknown command "${cmd}". See the top of this file.`);

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
  const daily = b === undefined ? 0n : limitOf(b), asked = a === undefined ? 0n : limitOf(a), bps = Number(c);
  const trade = asked > daily ? daily : asked;   // no per-trade limit under a daily limit = the daily limit
  if (trade <= 0n || daily <= 0n || !(bps > 0 && bps <= 1000)) fail('usage: limits <per-trade USDT|none> <per-day USDT|none> <slippage bps, 1 to 1000>');
  await run(`Set limits to per trade: ${cap(trade)}, per day: ${cap(daily)}, ${bps / 100}% slippage ceiling.`, 'limits', call('setLimits', [trade, daily, bps]));
} else if (cmd === 'stop') {
  const bps = rest[0] === 'off' ? 0 : Math.round(Number(rest[0]) * 100);
  if (!(bps >= 0 && bps <= 9000)) fail('usage: stop <percent, up to 90> | stop off');
  await run(bps ? `Set the stop-loss: anyone may sell a holding once it is worth ${bps / 100}% less than it cost.` : 'Turn the stop-loss off.', 'stop', call('setStopLoss', [bps]));
} else if (cmd === 'session' || cmd === 'revoke') {
  const version = await pub.readContract({ address: vault, abi, functionName: 'VERSION' }).then(Number, () => 2);
  if (version < 3) fail('this vault is an earlier version: its agent has no session (use "agent" or "pause").');
  if (cmd === 'revoke') {
    await run('End the agent key\'s session now: it can do nothing more on this vault until a new session.', 'revoke', call('revokeSession', []));
  } else {
    const [who, days, max, ...names] = rest;
    const until = Math.floor(Date.now() / 1000) + Math.round(Number(days) * 86_400);
    const perBuy = limitOf(max);
    const coins = names.length ? names.map((n) => MARKETS[n.toUpperCase()]?.token) : Object.values(MARKETS).map((m) => m.token);
    if (!isAddress(who ?? '') || !(Number(days) > 0 && Number(days) <= 365) || perBuy <= 0n || coins.some((c) => !c)) fail('usage: session <agent address> <days, up to 365> <most USDT per buy|none> [WHSK WETH WBTC]');
    await run(`Let ${who} trade on this vault until ${new Date(until * 1000).toISOString().slice(0, 10)}, at most ${cap(perBuy)} a buy, on ${names.length ? names.join(', ') : 'WHSK, WETH and WBTC'}.`, 'session', call('setSession', [getAddress(who), BigInt(until), perBuy, coins]));
  }
} else if (cmd === 'creator' || cmd === 'budget' || cmd === 'budgets') {
  const version = await pub.readContract({ address: vault, abi, functionName: 'VERSION' }).then(Number, () => 2);
  if (version < 3) fail('this vault is an earlier version: it has no per-agent creator fees or budgets.');
  const id = (x) => keccak256(stringToHex(x));
  if (cmd === 'creator') {
    const bps = Math.round(Number(rest[2]) * 100);
    if (!rest[0] || !isAddress(rest[1] ?? '') || !(bps >= 0 && bps <= 100)) fail('usage: creator <hired agent id> <creator address> <percent, 0 to 1>');
    await run(bps ? `Approve ${rest[1]} as the maker of agent ${rest[0]}, at up to ${bps / 100}% of each of its trades, paid in USDT.` : `Withdraw the creator approval of agent ${rest[0]}.`, 'creator', call('setCreatorFee', [id(rest[0]), getAddress(rest[1]), bps]));
  } else if (cmd === 'budget') {
    const amount = amountOf(rest[1], 6);
    if (!rest[0] || amount < 0n || rest[1] === undefined) fail('usage: budget <hired agent id> <USDT>');
    await run(`Agent ${rest[0]} may spend ${usd(amount)} USDT more on buys (counts while budgets are on).`, 'budget', call('setBudget', [id(rest[0]), amount]));
  } else {
    if (rest[0] !== 'on' && rest[0] !== 'off') fail('usage: budgets on | off');
    await run(rest[0] === 'on' ? 'Budgets on: every buy must fit the budget of the agent it is for; a buy for no agent needs a budget for agent id 0.' : 'Budgets off: buys are held only by the per-trade and daily limits.', 'budgets', call('setBudgetsOn', [rest[0] === 'on']));
  }
} else if (cmd === 'agent') {
  if (!isAddress(rest[0] ?? '')) fail('usage: agent <new agent address>');
  if (same(rest[0], owner)) fail('the agent must be a different wallet from the owner.');
  await run(`Replace the agent wallet with ${rest[0]}. The old one can no longer trade.`, 'agent', call('setAgent', [getAddress(rest[0])]));
}
