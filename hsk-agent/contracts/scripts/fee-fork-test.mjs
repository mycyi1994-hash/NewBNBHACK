// Creator fees, on a local fork of HSK Chain mainnet: a vault of version 3 pays the maker of a shared agent only
// what its owner approved (never above 1%), the agent key cannot raise it or pay anyone else, the limits and the
// stop-loss behave as before, and the server sends the plain trade to a vault of version 2 (the one on mainnet).
// No real funds are used.
// Usage: node --experimental-strip-types scripts/fee-fork-test.mjs   (from contracts/; FORK_PORT, default 8557)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, encodeFunctionData, formatUnits, http, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createVault, executeTrade, feesReceived, forOwner, vaultStatus, vaultVersion, TOKENS, USDT } from '../../server/executor.ts';

const PORT = process.env.FORK_PORT || '8557';
const RPC = `http://127.0.0.1:${PORT}`;
const ROUTER = '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3';
const POOLS = { HSK: '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc', ETH: '0xb92b79ed6b370d5cfee2e14b1d0983c258304c16', BTC: '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a' };
// Hardhat's well-known local test keys (public, never funded on any real chain)
const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  creator: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  stranger: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  oldOwner: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
};
const art = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const v3 = { factory: art('../out/MoaVaultFactory.json'), vault: art('../out/MoaVault.json') };
// Version 2, as deployed on mainnet (factory 0xd6bF…6546): the compiled output of the source before creator fees.
const v2 = { factory: art('../legacy/v2/MoaVaultFactory.json'), vault: art('../legacy/v2/MoaVault.json') };
const abi = v3.vault.abi;
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const chain = { id: 177, name: 'HSK fork', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const NO_LIMIT = 2n ** 256n - 1n;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const node = spawn('npx', ['hardhat', 'node', '--port', PORT], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
let nodeLog = '';
node.stdout.on('data', (d) => (nodeLog += d));
node.stderr.on('data', (d) => (nodeLog += d));
const stop = () => { try { if (process.platform === 'win32') node.kill('SIGTERM'); else process.kill(-node.pid, 'SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);

try {
  for (let i = 0; i < 120 && !/Started HTTP/.test(nodeLog); i++) await new Promise((r) => setTimeout(r, 500));
  if (!/Started HTTP/.test(nodeLog)) throw new Error('fork node did not start:\n' + nodeLog.slice(-2000));
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const test = createTestClient({ chain, mode: 'hardhat', transport: http(RPC) });
  const acc = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]));
  const W = Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, createWalletClient({ account: a, chain, transport: http(RPC) })]));
  const mined = async (hash) => pub.waitForTransactionReceipt({ hash });
  const assets = ['HSK', 'ETH', 'BTC'];
  const deploy = async (f) => (await mined(await W.owner.deployContract({ abi: f.abi, bytecode: f.bytecode, args: [acc.agent.address, USDT, ROUTER, NO_LIMIT, NO_LIMIT, 150, 0, assets.map((a) => TOKENS[a].address), assets.map((a) => POOLS[a])] }))).contractAddress;
  const oldFactory = await deploy(v2.factory);
  const factory = await deploy(v3.factory);
  console.log('fork block', await pub.getBlockNumber(), 'factory v3', factory, 'factory v2', oldFactory);
  const base = { rpcUrl: RPC, chainId: 177, factory, legacyFactories: [oldFactory], agentKey: KEYS.agent, explorer: 'https://hsk.blockscout.com', minOutBufferBps: 100, maxVaultsPerDay: 5 };

  // a wallet with a vault from the earlier factory keeps it; a new wallet gets a vault of version 3
  await mined(await W.oldOwner.writeContract({ address: oldFactory, abi: v2.factory.abi, functionName: 'createVault', args: [acc.oldOwner.address] }));
  const oldVault = await pub.readContract({ address: oldFactory, abi: v2.factory.abi, functionName: 'vaultOf', args: [acc.oldOwner.address] });
  const kept = await createVault(base, acc.oldOwner.address);
  check('a wallet whose vault the earlier factory made keeps it: no new vault is made', kept.ok && kept.vault === oldVault && !kept.txHash);
  const made = await createVault(base, acc.owner.address);
  if (!made.ok) throw new Error(made.reason);
  const vault = made.vault;
  check('the server tells the versions apart: 3 for the new vault, 2 for the one on the earlier factory', (await vaultVersion(base, vault)) === 3 && (await vaultVersion(base, oldVault)) === 2);
  check('the vault status reports the version', (await vaultStatus(await forOwner(base, acc.owner.address))).version === 3 && (await vaultStatus(await forOwner(base, acc.oldOwner.address))).version === 2);

  // fund both vaults with USDT from the WHSK/USDT pool's balance (fork only)
  await test.impersonateAccount({ address: POOLS.HSK });
  await test.setBalance({ address: POOLS.HSK, value: 10n ** 21n });
  const poolW = createWalletClient({ account: POOLS.HSK, chain, transport: http(RPC) });
  for (const v of [vault, oldVault]) await mined(await poolW.sendTransaction({ to: USDT, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [v, 200_000_000n] }) }));
  const usdt = (who) => pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [who] });
  const read = (fn, args = []) => pub.readContract({ address: vault, abi, functionName: fn, args });
  const refusal = async (account, fn, args, address = vault) => { try { await pub.simulateContract({ address, abi, functionName: fn, args, account }); return 'went through'; } catch (e) { return /(NotOwner|NotAgent|FeeTooHigh|BadCreator|TradeTooLarge|DailyCapExceeded|StopNotReached|SlippageTooLoose|PriceMoving|NothingToSell)/.exec(String(e.message))?.[1] ?? String(e.message).slice(0, 100); } };
  const creator = acc.creator.address;

  // who may approve a creator, and how much
  check('a stranger cannot approve a creator fee', (await refusal(acc.stranger, 'setCreatorFee', [creator, 50])) === 'NotOwner');
  check('the agent key cannot approve a creator fee', (await refusal(acc.agent, 'setCreatorFee', [creator, 50])) === 'NotOwner');
  check('the owner cannot approve more than 1% (101 bps is refused)', (await refusal(acc.owner, 'setCreatorFee', [creator, 101])) === 'FeeTooHigh');
  check('the agent key itself cannot be approved as a creator', (await refusal(acc.owner, 'setCreatorFee', [acc.agent.address, 50])) === 'BadCreator');
  const setFee = async (who, bps) => mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setCreatorFee', args: [who, bps] }));
  const approval = await setFee(creator, 50);
  const ev = approval.logs.map((l) => { try { return decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'CreatorFeeSet');
  check('the owner approves the creator at 0.5%, with an event', (await read('creatorFeeBps', [creator])) === 50 && ev?.args.bps === 50 && ev.args.creator === creator);

  // a buy through the server pays the creator 0.5% of the USDT going in, and the limits count all of it
  const cfg = await forOwner(base, acc.owner.address);
  const day = () => pub.getBlock().then((b) => b.timestamp / 86_400n);
  const c0 = await usdt(creator), v0 = await usdt(vault);
  const buy = await executeTrade(cfg, { asset: 'BTC', side: 'buy', amount: 20, note: 'shared agent buy', creator: { address: creator, feeBps: 50 } });
  const c1 = await usdt(creator);
  check('a $20 buy for a shared agent pays the creator exactly $0.10 (0.5%) in USDT', buy.ok && c1 - c0 === 100_000n && buy.creatorFeeUsdt === '0.1', buy.ok ? `fee ${buy.creatorFeeUsdt}, tx ${buy.txHash}` : buy.reason);
  check('the vault spent exactly $20 in all, the fee included', v0 - (await usdt(vault)) === 20_000_000n);
  check('the day\'s spending counts the whole $20, fee included', (await read('spentOnDay', [await day()])) === 20_000_000n);
  check('the holding cost what went into the pool ($19.90), not the fee', (await read('costUsdt', [TOKENS.BTC.address])) === 19_900_000n);

  // a sell pays 0.5% of the USDT coming out; the vault keeps the rest
  const wbtc = await pub.readContract({ address: TOKENS.BTC.address, abi: erc20, functionName: 'balanceOf', args: [vault] });
  const vBefore = await usdt(vault), cBefore = await usdt(creator);
  const sell = await executeTrade(cfg, { asset: 'BTC', side: 'sell', amount: Number(formatUnits(wbtc / 2n, 8)), note: 'shared agent sell', creator: { address: creator, feeBps: 50 } });
  const got = (await usdt(vault)) - vBefore, paid = (await usdt(creator)) - cBefore;
  check('a sell pays the creator 0.5% of the USDT that came out, and the vault keeps the rest', sell.ok && paid > 0n && paid === ((got + paid) * 50n) / 10_000n && sell.amountOut === formatUnits(got, 6), sell.ok ? `vault +${formatUnits(got, 6)}, creator +${formatUnits(paid, 6)}` : sell.reason);

  // the agent key asks for more than approved: it gets the approved rate, no more
  const agentTrade = async (args) => mined(await W.agent.writeContract({ address: vault, abi, functionName: 'tradeFor', args }));
  const quote = await read('quote', [TOKENS.HSK.address, true, 9_950_000n]);
  const cA = await usdt(creator);
  await agentTrade([TOKENS.HSK.address, true, 10_000_000n, (quote * 9_900n) / 10_000n, 'asks 1%', creator, 100]);
  check('the agent asks for 1% where 0.5% was approved: the creator gets 0.5%, not more', (await usdt(creator)) - cA === 50_000n);

  // nobody else can be paid
  const s0 = await usdt(acc.stranger.address), a0 = await usdt(acc.agent.address);
  const other = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'unapproved creator', creator: { address: acc.stranger.address, feeBps: 100 } });
  check('an unapproved creator gets nothing; the trade itself goes through', other.ok && (await usdt(acc.stranger.address)) === s0 && other.creatorFeeUsdt === '0' && other.feeNote === 'notApproved', other.ok ? other.feeNote : other.reason);
  const q2 = await read('quote', [TOKENS.HSK.address, true, 5_000_000n]);
  await agentTrade([TOKENS.HSK.address, true, 5_000_000n, (q2 * 9_900n) / 10_000n, 'pay myself', acc.agent.address, 100]);
  check('the agent key naming itself as the creator is paid nothing', (await usdt(acc.agent.address)) === a0);
  check('the agent key cannot take USDT out any other way', (await refusal(acc.agent, 'withdraw', [USDT, 1n])) === 'NotOwner');
  await setFee(creator, 0);
  const cZ = await usdt(creator);
  const revoked = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'after revoking', creator: { address: creator, feeBps: 50 } });
  check('after the owner withdraws the approval, the creator is paid nothing', revoked.ok && (await usdt(creator)) === cZ);
  await setFee(creator, 50);

  // the owner's limits hold exactly as before, the fee inside them
  await test.increaseTime({ seconds: 86_400 });
  await test.mine({ blocks: 1 });
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setLimits', args: [10_000_000n, 25_000_000n, 150] }));
  const fee = { address: creator, feeBps: 50 };
  const over = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 10.01, note: 'over', creator: fee });
  check('a $10.01 buy is refused by the $10 per-trade limit, fee or not', !over.ok && /TradeTooLarge/.test(over.reason), over.ok ? 'executed!' : over.reason.slice(0, 80));
  const in1 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 10, note: 'at the limit', creator: fee });
  const in2 = await executeTrade(cfg, { asset: 'ETH', side: 'buy', amount: 10, note: 'at the limit', creator: fee });
  check('two $10 buys at the limit go through and pay the fee', in1.ok && in2.ok && in1.creatorFeeUsdt === '0.05' && in2.creatorFeeUsdt === '0.05');
  const third = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 10, note: 'over the day', creator: fee });
  check('a third is refused by the $25 daily limit: $20 already went today, fees included', !third.ok && /DailyCapExceeded\(30000000, 25000000\)/.test(third.reason), third.ok ? 'executed!' : third.reason.slice(0, 80));

  // the stop-loss reads what the holding cost in the pool: a 1% fee does not bring a 1% stop-loss forward
  await setFee(creator, 100);
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setLimits', args: [NO_LIMIT, NO_LIMIT, 150] }));
  const ethHeld = await pub.readContract({ address: TOKENS.ETH.address, abi: erc20, functionName: 'balanceOf', args: [vault] });
  await executeTrade(cfg, { asset: 'ETH', side: 'sell', amount: Number(formatUnits(ethHeld, 18)), note: 'clear ETH', creator: fee });
  const fresh = await executeTrade(cfg, { asset: 'ETH', side: 'buy', amount: 30, note: '1% fee buy', creator: { address: creator, feeBps: 100 } });
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setStopLoss', args: [100] }));
  const [, cost, value, stopAt] = await read('position', [TOKENS.ETH.address]);
  check('after a buy that paid 1%, the holding cost $29.70 (what went into the pool)', fresh.ok && cost === 29_700_000n, `cost ${formatUnits(cost, 6)}, worth ${formatUnits(value, 6)}, stop under ${formatUnits(stopAt, 6)}`);
  check('so a 1% stop-loss is not set off by the fee: a stranger\'s stopOut is refused', (await refusal(acc.stranger, 'stopOut', [TOKENS.ETH.address])) === 'StopNotReached' && value < 30_000_000n * 99n / 100n);

  // the server never sends the new call to an old vault
  const oldCfg = await forOwner(base, acc.oldOwner.address);
  const cO = await usdt(creator);
  const old = await executeTrade(oldCfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'shared agent, old vault', creator: { address: creator, feeBps: 50 } });
  const sent = old.ok ? (await pub.getTransaction({ hash: old.txHash })).input.slice(0, 10) : '';
  check('on a version-2 vault the server sends the plain trade (no creator fee call) and it goes through', old.ok && sent === toFunctionSelector('trade(address,bool,uint256,uint256,string)') && old.feeNote === 'oldVault', old.ok ? `selector ${sent}` : old.reason);
  check('and the creator is paid nothing by the old vault', (await usdt(creator)) === cO);
  check('the version-2 vault has no tradeFor at all', (await refusal(acc.agent, 'tradeFor', [TOKENS.HSK.address, true, 1_000_000n, 1n, 'x', creator, 50], oldVault)) !== 'went through');

  // what the creator view reads: every CreatorPaid event of a Moa vault, since the factory was deployed
  const total = (await usdt(creator)) - c0;
  const fr = await feesReceived(base, creator);
  check('the fees received, read from the vault events, add up to what the creator\'s wallet got', fr.state === 'ok' && fr.totalUsdt === formatUnits(total, 6) && fr.vaults === 1, JSON.stringify(fr));
  check('a creator nobody paid has received nothing', (await feesReceived(base, acc.stranger.address)).totalUsdt === '0');
} catch (e) {
  fail++;
  console.error('ERROR', e);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  stop();
  process.exit(fail ? 1 : 0);
}
