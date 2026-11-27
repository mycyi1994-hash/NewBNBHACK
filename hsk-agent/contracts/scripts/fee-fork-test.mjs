// Creator fees, on a local fork of HSK Chain mainnet: a vault of version 3 pays the maker of a shared agent only
// what its owner approved (never above 1%), the agent key cannot raise it or pay anyone else, the limits and the
// stop-loss behave as before, and the server sends the plain trade to a vault of version 2 (the one on mainnet).
// No real funds are used.
// Usage: node --experimental-strip-types scripts/fee-fork-test.mjs   (from contracts/; FORK_PORT, default 8557)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, encodeFunctionData, formatUnits, http, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { agentIdOf, createVault, executeTrade, feesReceived, forOwner, platformFee, vaultStatus, vaultVersion, TOKENS, USDT } from '../../server/executor.ts';

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
  guardian: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  treasury: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
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
  const markets = [assets.map((a) => TOKENS[a].address), assets.map((a) => POOLS[a])];
  const deploy = async (f, args) => (await mined(await W.owner.deployContract({ abi: f.abi, bytecode: f.bytecode, args }))).contractAddress;
  const oldFactory = await deploy(v2.factory, [acc.agent.address, USDT, ROUTER, NO_LIMIT, NO_LIMIT, 150, 0, ...markets]);
  // version 3 starts every vault with safe limits ($50 / $100 a day, 15% stop-loss); no guardian here
  const factory = await deploy(v3.factory, [acc.agent.address, USDT, ROUTER, 50_000_000n, 100_000_000n, 150, 1500, ...markets, acc.guardian.address]);
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
  const refusal = async (account, fn, args, address = vault) => { try { await pub.simulateContract({ address, abi, functionName: fn, args, account }); return 'went through'; } catch (e) { return /(NotOwner|NotAgent|FeeTooHigh|BadCreator|OverBudget|TradeTooLarge|DailyCapExceeded|StopNotReached|SlippageTooLoose|PriceMoving|NothingToSell)/.exec(String(e.message))?.[1] ?? String(e.message).slice(0, 100); } };
  const creator = acc.creator.address;
  // the app's ids of two hired agents: A was made and shared by `creator`, B is the owner's own
  const A = agentIdOf('hire-a'), B = agentIdOf('hire-b');
  check('the vault starts with the factory\'s safe limits ($50, $100 a day, 15% stop-loss)', (await read('maxTradeUsdt')) === 50_000_000n && (await read('maxDailyUsdt')) === 100_000_000n && (await read('stopLossBps')) === 1500);
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setLimits', args: [NO_LIMIT, NO_LIMIT, 150] }));
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setStopLoss', args: [0] }));
  check('the owner can remove them', (await read('maxTradeUsdt')) === NO_LIMIT && (await read('stopLossBps')) === 0);

  // who may approve a creator, and how much
  check('a stranger cannot approve a creator fee', (await refusal(acc.stranger, 'setCreatorFee', [A, creator, 50])) === 'NotOwner');
  check('the agent key cannot approve a creator fee', (await refusal(acc.agent, 'setCreatorFee', [A, creator, 50])) === 'NotOwner');
  check('the owner cannot approve more than 1% (101 bps is refused)', (await refusal(acc.owner, 'setCreatorFee', [A, creator, 101])) === 'FeeTooHigh');
  check('the agent key itself cannot be approved as a creator', (await refusal(acc.owner, 'setCreatorFee', [A, acc.agent.address, 50])) === 'BadCreator');
  const setFee = async (id, who, bps) => mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setCreatorFee', args: [id, who, bps] }));
  const approval = await setFee(A, creator, 50);
  const ev = approval.logs.map((l) => { try { return decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'CreatorFeeSet');
  const ap = await read('creatorOf', [A]);
  check('the owner approves the creator for agent A only, at 0.5%, with an event', ap[0] === creator && ap[1] === 50 && ev?.args.bps === 50 && ev.args.agentId === A && (await read('creatorOf', [B]))[1] === 0);

  // a buy through the server pays the creator 0.5% of the USDT going in, and the limits count all of it
  const cfg = await forOwner(base, acc.owner.address);
  const day = () => pub.getBlock().then((b) => b.timestamp / 86_400n);
  const c0 = await usdt(creator), v0 = await usdt(vault);
  const buy = await executeTrade(cfg, { asset: 'BTC', side: 'buy', amount: 20, note: 'shared agent buy', creator: { address: creator, feeBps: 50 }, agent: 'hire-a' });
  const c1 = await usdt(creator);
  check('a $20 buy for a shared agent pays the creator exactly $0.10 (0.5%) in USDT', buy.ok && c1 - c0 === 100_000n && buy.creatorFeeUsdt === '0.1', buy.ok ? `fee ${buy.creatorFeeUsdt}, tx ${buy.txHash}` : buy.reason);
  check('the vault spent exactly $20 in all, the fee included', v0 - (await usdt(vault)) === 20_000_000n);
  check('the day\'s spending counts the whole $20, fee included', (await read('spentOnDay', [await day()])) === 20_000_000n);
  check('the holding cost what went into the pool ($19.90), not the fee', (await read('costUsdt', [TOKENS.BTC.address])) === 19_900_000n);

  // a sell pays 0.5% of the USDT coming out; the vault keeps the rest
  const wbtc = await pub.readContract({ address: TOKENS.BTC.address, abi: erc20, functionName: 'balanceOf', args: [vault] });
  const vBefore = await usdt(vault), cBefore = await usdt(creator);
  const sell = await executeTrade(cfg, { asset: 'BTC', side: 'sell', amount: Number(formatUnits(wbtc / 2n, 8)), note: 'shared agent sell', creator: { address: creator, feeBps: 50 }, agent: 'hire-a' });
  const got = (await usdt(vault)) - vBefore, paid = (await usdt(creator)) - cBefore;
  check('a sell pays the creator 0.5% of the USDT that came out, and the vault keeps the rest', sell.ok && paid > 0n && paid === ((got + paid) * 50n) / 10_000n && sell.amountOut === formatUnits(got, 6), sell.ok ? `vault +${formatUnits(got, 6)}, creator +${formatUnits(paid, 6)}` : sell.reason);

  // the agent key asks for more than approved: it gets the approved rate, no more
  const agentTrade = async (args) => mined(await W.agent.writeContract({ address: vault, abi, functionName: 'tradeFor', args }));
  const quote = await read('quote', [TOKENS.HSK.address, true, 9_950_000n]);
  const cA = await usdt(creator);
  await agentTrade([TOKENS.HSK.address, true, 10_000_000n, (quote * 9_900n) / 10_000n, 'asks 1%', A, 100]);
  check('the agent asks for 1% where 0.5% was approved: the creator gets 0.5%, not more', (await usdt(creator)) - cA === 50_000n);

  // nobody else can be paid
  const s0 = await usdt(acc.stranger.address), a0 = await usdt(acc.agent.address);
  const cOther = await usdt(creator);
  const other = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'unapproved creator', creator: { address: acc.stranger.address, feeBps: 100 }, agent: 'hire-b' });
  check('an agent with no approved creator pays nobody; the trade itself goes through', other.ok && (await usdt(acc.stranger.address)) === s0 && (await usdt(creator)) === cOther && other.creatorFeeUsdt === '0' && other.feeNote === 'notApproved', other.ok ? other.feeNote : other.reason);
  const wrong = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'someone else named', creator: { address: acc.stranger.address, feeBps: 100 }, agent: 'hire-a' });
  check('the server naming another creator for agent A asks for no fee, and nobody is paid', wrong.ok && (await usdt(acc.stranger.address)) === s0 && (await usdt(creator)) === cOther);
  const q2 = await read('quote', [TOKENS.HSK.address, true, 5_000_000n]);
  await agentTrade([TOKENS.HSK.address, true, 5_000_000n, (q2 * 9_900n) / 10_000n, 'agent B asks for a fee', B, 100]);
  check('the agent key cannot name a creator: a trade for agent B pays nobody', (await usdt(creator)) === cOther && (await usdt(acc.agent.address)) === a0);
  check('the agent key cannot take USDT out any other way', (await refusal(acc.agent, 'withdraw', [USDT, 1n])) === 'NotOwner');
  await setFee(A, creator, 0);
  const cZ = await usdt(creator);
  const revoked = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'after revoking', creator: { address: creator, feeBps: 50 }, agent: 'hire-a' });
  check('after the owner withdraws the approval, the creator is paid nothing', revoked.ok && (await usdt(creator)) === cZ);
  await setFee(A, creator, 50);

  // per-agent budgets: once on, every buy spends from the budget the owner gave that agent, and the creator of A can
  // be credited with no more than A's own budget (the agent key cannot move B's trades onto A beyond it)
  check('a stranger cannot set a budget or turn budgets on', (await refusal(acc.stranger, 'setBudget', [A, 1n])) === 'NotOwner' && (await refusal(acc.agent, 'setBudgetsOn', [true])) === 'NotOwner');
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setBudget', args: [A, 15_000_000n] }));
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setBudget', args: [B, 50_000_000n] }));
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setBudgetsOn', args: [true] }));
  check('the vault status reports budgets on', (await vaultStatus(cfg)).budgetsOn === true);
  const cB = await usdt(creator);
  const a1 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 10, note: 'A in budget', creator: { address: creator, feeBps: 50 }, agent: 'hire-a' });
  check('a $10 buy for agent A spends $10 of its $15 budget', a1.ok && (await read('budgetLeft', [A])) === 5_000_000n, a1.ok ? '' : a1.reason);
  const a2 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 10, note: 'A over budget', creator: { address: creator, feeBps: 50 }, agent: 'hire-a' });
  check('a second $10 for A is refused: only $5 of its budget is left', !a2.ok && /OverBudget/.test(a2.reason), a2.ok ? 'executed!' : a2.reason.slice(0, 90));
  const bq = await read('quote', [TOKENS.HSK.address, true, 19_900_000n]);
  let moved = 'went through';
  try { await pub.simulateContract({ address: vault, abi, functionName: 'tradeFor', args: [TOKENS.HSK.address, true, 20_000_000n, (bq * 9_900n) / 10_000n, 'B credited to A', A, 50], account: acc.agent }); } catch (e) { moved = /OverBudget/.test(String(e.message)) ? 'OverBudget' : String(e.message).slice(0, 80); }
  check('the agent key crediting $20 of B\'s trading to A is refused: it is over A\'s budget', moved === 'OverBudget');
  check('so A\'s creator was paid on A\'s budget only (0.5% of $10)', (await usdt(creator)) - cB === 50_000n);
  const b1 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 20, note: 'B in budget', agent: 'hire-b' });
  check('agent B spends from its own budget', b1.ok && (await read('budgetLeft', [B])) === 30_000_000n, b1.ok ? '' : b1.reason);
  const chat = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 2, note: 'a chat order' });
  check('with budgets on, a buy for no agent (budget 0) is refused', !chat.ok && /OverBudget/.test(chat.reason), chat.ok ? 'executed!' : chat.reason.slice(0, 80));
  const sellA = await executeTrade(cfg, { asset: 'BTC', side: 'sell', amount: Number(formatUnits((await pub.readContract({ address: TOKENS.BTC.address, abi: erc20, functionName: 'balanceOf', args: [vault] })) / 2n, 8)), note: 'selling needs no budget', agent: 'hire-a' });
  check('selling needs no budget', sellA.ok, sellA.ok ? '' : sellA.reason);
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setBudgetsOn', args: [false] }));

  // the owner's limits hold exactly as before, the fee inside them
  await test.increaseTime({ seconds: 86_400 });
  await test.mine({ blocks: 1 });
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setLimits', args: [10_000_000n, 25_000_000n, 150] }));
  const fee = { address: creator, feeBps: 50 };
  const over = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 10.01, note: 'over', creator: fee, agent: 'hire-a' });
  check('a $10.01 buy is refused by the $10 per-trade limit, fee or not', !over.ok && /TradeTooLarge/.test(over.reason), over.ok ? 'executed!' : over.reason.slice(0, 80));
  const in1 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 10, note: 'at the limit', creator: fee, agent: 'hire-a' });
  const in2 = await executeTrade(cfg, { asset: 'ETH', side: 'buy', amount: 10, note: 'at the limit', creator: fee, agent: 'hire-a' });
  check('two $10 buys at the limit go through and pay the fee', in1.ok && in2.ok && in1.creatorFeeUsdt === '0.05' && in2.creatorFeeUsdt === '0.05');
  const third = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 10, note: 'over the day', creator: fee, agent: 'hire-a' });
  check('a third is refused by the $25 daily limit: $20 already went today, fees included', !third.ok && /DailyCapExceeded\(30000000, 25000000\)/.test(third.reason), third.ok ? 'executed!' : third.reason.slice(0, 80));

  // the stop-loss reads what the holding cost in the pool: a 1% fee does not bring a 1% stop-loss forward
  await setFee(A, creator, 100);
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setLimits', args: [NO_LIMIT, NO_LIMIT, 150] }));
  const ethHeld = await pub.readContract({ address: TOKENS.ETH.address, abi: erc20, functionName: 'balanceOf', args: [vault] });
  await executeTrade(cfg, { asset: 'ETH', side: 'sell', amount: Number(formatUnits(ethHeld, 18)), note: 'clear ETH', creator: fee, agent: 'hire-a' });
  const fresh = await executeTrade(cfg, { asset: 'ETH', side: 'buy', amount: 30, note: '1% fee buy', creator: { address: creator, feeBps: 100 }, agent: 'hire-a' });
  await mined(await W.owner.writeContract({ address: vault, abi, functionName: 'setStopLoss', args: [100] }));
  const [, cost, value, stopAt] = await read('position', [TOKENS.ETH.address]);
  check('after a buy that paid 1%, the holding cost $29.70 (what went into the pool)', fresh.ok && cost === 29_700_000n, `cost ${formatUnits(cost, 6)}, worth ${formatUnits(value, 6)}, stop under ${formatUnits(stopAt, 6)}`);
  check('so a 1% stop-loss is not set off by the fee: a stranger\'s stopOut is refused', (await refusal(acc.stranger, 'stopOut', [TOKENS.ETH.address])) === 'StopNotReached' && value < 30_000_000n * 99n / 100n);

  // the platform fee switch: 0 by default, set only by the factory's guardian, never above 0.2%, inside the limits
  check('the platform fee starts at 0 and the server reports 0', (await platformFee(base)) === 0 && (await vaultStatus(cfg)).platformFeeBps === 0);
  const fAbi = v3.factory.abi;
  const feeRefusal = async (account, args) => { try { await pub.simulateContract({ address: factory, abi: fAbi, functionName: 'setPlatformFee', args, account }); return 'went through'; } catch (e) { return /(not guardian|fee too high|no treasury)/.exec(String(e.message))?.[1] ?? String(e.message).slice(0, 60); } };
  check('a stranger, the agent key and a vault owner cannot set a platform fee', (await feeRefusal(acc.stranger, [20, acc.treasury.address])) === 'not guardian' && (await feeRefusal(acc.agent, [20, acc.treasury.address])) === 'not guardian' && (await feeRefusal(acc.owner, [20, acc.treasury.address])) === 'not guardian');
  check('the guardian cannot set more than 0.2%, nor a fee with no treasury', (await feeRefusal(acc.guardian, [21, acc.treasury.address])) === 'fee too high' && (await feeRefusal(acc.guardian, [10, '0x0000000000000000000000000000000000000000'])) === 'no treasury');
  await test.setBalance({ address: acc.guardian.address, value: 10n ** 20n });
  await mined(await W.guardian.writeContract({ address: factory, abi: fAbi, functionName: 'setPlatformFee', args: [20, acc.treasury.address] }));
  check('at 0.2% the server and the vault status report it', (await platformFee(base)) === 20 && (await vaultStatus(cfg)).platformFeeBps === 20);
  await setFee(A, creator, 50);
  const pT0 = await usdt(acc.treasury.address), pC0 = await usdt(creator), pV0 = await usdt(vault), pDay = await day(), pSpent = await read('spentOnDay', [pDay]), pCost = await read('costUsdt', [TOKENS.HSK.address]);
  const pBuy = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 10, note: 'platform fee on', creator: { address: creator, feeBps: 50 }, agent: 'hire-a' });
  check('a $10 buy pays the treasury exactly $0.02 and the creator $0.05; the vault spends exactly $10', pBuy.ok && (await usdt(acc.treasury.address)) - pT0 === 20_000n && (await usdt(creator)) - pC0 === 50_000n && pV0 - (await usdt(vault)) === 10_000_000n, pBuy.ok ? '' : pBuy.reason);
  check('the platform fee counts toward the day\'s spending; the cost booked is what went into the pool ($9.93)', (await read('spentOnDay', [pDay])) - pSpent === 10_000_000n && (await read('costUsdt', [TOKENS.HSK.address])) - pCost === 9_930_000n);
  const hskHeld = await pub.readContract({ address: TOKENS.HSK.address, abi: erc20, functionName: 'balanceOf', args: [vault] });
  const pT1 = await usdt(acc.treasury.address), pC1 = await usdt(creator), pV1 = await usdt(vault);
  const pSell = await executeTrade(cfg, { asset: 'HSK', side: 'sell', amount: Number(formatUnits((hskHeld * 999n) / 1000n, 18)), note: 'sell with fees', creator: { address: creator, feeBps: 50 }, agent: 'hire-a' });
  const tGot = (await usdt(acc.treasury.address)) - pT1, cGot = (await usdt(creator)) - pC1, vGot = (await usdt(vault)) - pV1, gross = tGot + cGot + vGot;
  check('a sell pays the treasury floor(0.2% of what came out) and the creator floor(0.5%)', pSell.ok && tGot === (gross * 20n) / 10_000n && cGot === (gross * 50n) / 10_000n, pSell.ok ? `gross ${gross}` : pSell.reason);
  await mined(await W.guardian.writeContract({ address: factory, abi: fAbi, functionName: 'setPlatformFee', args: [0, '0x0000000000000000000000000000000000000000'] }));
  const pT2 = await usdt(acc.treasury.address);
  const pOff = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'platform fee off', agent: 'hire-b' });
  check('back at 0, the treasury gets nothing', pOff.ok && (await usdt(acc.treasury.address)) === pT2);

  // the server never sends the new call to an old vault
  const oldCfg = await forOwner(base, acc.oldOwner.address);
  const cO = await usdt(creator);
  const old = await executeTrade(oldCfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'shared agent, old vault', creator: { address: creator, feeBps: 50 }, agent: 'hire-a' });
  const sent = old.ok ? (await pub.getTransaction({ hash: old.txHash })).input.slice(0, 10) : '';
  check('on a version-2 vault the server sends the plain trade (no creator fee call) and it goes through', old.ok && sent === toFunctionSelector('trade(address,bool,uint256,uint256,string)') && old.feeNote === 'oldVault', old.ok ? `selector ${sent}` : old.reason);
  check('and the creator is paid nothing by the old vault', (await usdt(creator)) === cO);
  check('the version-2 vault has no tradeFor at all', (await refusal(acc.agent, 'tradeFor', [TOKENS.HSK.address, true, 1_000_000n, 1n, 'x', A, 50], oldVault)) !== 'went through');

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
