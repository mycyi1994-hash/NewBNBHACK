// End-to-end test on a local fork of HSK Chain mainnet: deploy the factory, let the server make each user's vault,
// fund one, trade through the real HSKSwap pools with the server executor, and check every guard.
// No real funds are used.
// Usage: node --experimental-strip-types scripts/fork-test.mjs   (from hsk-agent/contracts)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData, encodeDeployData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeTrade, vaultStatus, createVault, vaultOf, forOwner, stopOut, TOKENS, USDT } from '../../server/executor.ts';

const PORT = process.env.FORK_PORT || '8546';
const RPC = `http://127.0.0.1:${PORT}`;
const ROUTER = '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3';
const POOLS = { HSK: '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc', ETH: '0xb92b79ed6b370d5cfee2e14b1d0983c258304c16', BTC: '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a' };
// Hardhat's well-known local test keys (public, never funded on any real chain)
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CAROL_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const factoryArtifact = JSON.parse(readFileSync(new URL('../out/MoaVaultFactory.json', import.meta.url)));
const { abi } = JSON.parse(readFileSync(new URL('../out/MoaVault.json', import.meta.url)));
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const chain = { id: 177, name: 'HSK fork', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// Its own process group, so stopping it also stops the node that npx starts underneath (otherwise the port stays taken).
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
  const owner = privateKeyToAccount(OWNER_KEY);
  const agent = privateKeyToAccount(AGENT_KEY);
  const ownerW = createWalletClient({ account: owner, chain, transport: http(RPC) });
  const agentW = createWalletClient({ account: agent, chain, transport: http(RPC) });
  console.log('fork block', await pub.getBlockNumber());

  // the factory: every vault starts with $50 per trade, $120 per day, 1.5% slippage floor, a 15% stop-loss and the
  // three markets; a guardian (a separate key) can halt agent trading on every vault
  const assets = ['HSK', 'ETH', 'BTC'];
  const guardian = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
  const factoryArgs = (trade, daily, stop) => [agent.address, USDT, ROUTER, trade, daily, 150, stop, assets.map((a) => TOKENS[a].address), assets.map((a) => POOLS[a]), guardian.address];
  let unsafe = 'deployed';
  try { await pub.estimateGas({ account: owner, data: encodeDeployData({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode, args: factoryArgs(2n ** 256n - 1n, 2n ** 256n - 1n, 0) }) }); } catch (e) { unsafe = /unsafe starting limits/.test(String(e.message)) ? 'refused' : String(e.message).slice(0, 80); }
  check('a factory whose vaults would start with no limit and no stop-loss cannot be deployed', unsafe === 'refused', unsafe);
  const deployHash = await ownerW.deployContract({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode, args: factoryArgs(50_000_000n, 120_000_000n, 1500) });
  const deployed = await pub.waitForTransactionReceipt({ hash: deployHash });
  const factory = deployed.contractAddress;
  console.log('factory', factory, 'gas', deployed.gasUsed);
  const base = { rpcUrl: RPC, chainId: 177, factory, agentKey: AGENT_KEY, explorer: 'https://hsk.blockscout.com', minOutBufferBps: 100, maxVaultsPerDay: 2 };

  // the server makes the owner's vault; the owner signs nothing
  check('a wallet has no vault before it logs in', (await vaultOf(base, owner.address)) === undefined);
  const made = await createVault(base, owner.address);
  const vault = made.ok ? made.vault : undefined;
  if (!vault) throw new Error(`vault was not made: ${made.reason}`);
  const makeGas = (await pub.getTransactionReceipt({ hash: made.txHash })).gasUsed;
  console.log('vault', vault, 'gas', makeGas);
  const read = (address, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
  check('a new vault starts with the factory\'s safe limits: $50 per trade, $120 per day, a 15% stop-loss', (await read(vault, 'maxTradeUsdt')) === 50_000_000n && (await read(vault, 'maxDailyUsdt')) === 120_000_000n && (await read(vault, 'stopLossBps')) === 1500);
  check('the server made the vault and the wallet is its owner', (await read(vault, 'owner')) === owner.address && (await read(vault, 'agent')) === agent.address);
  const listed = await Promise.all(assets.map((a) => read(vault, 'markets', [TOKENS[a].address])));
  check('the vault starts with HSK, ETH and BTC listed, without the owner signing', listed.every((m, i) => m[3] === true && m[0].toLowerCase() === POOLS[assets[i]]));
  const again = await createVault(base, owner.address);
  check('asking again returns the same vault and sends nothing', again.ok && again.vault === vault && !again.txHash);
  check('the agent wallet cannot own a vault', !(await createVault(base, agent.address)).ok);

  // a second user gets their own vault; nobody else can touch the first one
  const carol = privateKeyToAccount(CAROL_KEY);
  const carolMade = await createVault(base, carol.address);
  check('a second wallet gets a different vault', carolMade.ok && carolMade.vault !== vault && (await read(carolMade.vault, 'owner')) === carol.address);
  let carolRefused = false;
  try { await pub.simulateContract({ address: vault, abi, functionName: 'withdraw', args: [USDT, 1n], account: carol }); } catch (e) { carolRefused = /NotOwner/.test(String(e.message)); }
  check('another user cannot withdraw from this vault', carolRefused);
  const third = await createVault(base, privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6').address);
  check('the server stops paying for new vaults at its daily cap (2 here)', !third.ok && /today/.test(third.reason));
  const noFunds = await executeTrade(await forOwner(base, carol.address), { asset: 'HSK', side: 'buy', amount: 5, note: 'empty vault' });
  check('an order on an empty vault is refused before anything is sent', !noFunds.ok && /Deposit USDT first/.test(noFunds.reason), noFunds.ok ? 'executed!' : noFunds.reason);

  // fund the vault with 200 USDT taken from the WHSK/USDT pool's balance (fork only)
  await test.impersonateAccount({ address: POOLS.HSK });
  await test.setBalance({ address: POOLS.HSK, value: 10n ** 21n });
  const poolW = createWalletClient({ account: POOLS.HSK, chain, transport: http(RPC) }); // impersonated JSON-RPC account
  const fundHash = await poolW.sendTransaction({ to: USDT, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [vault, 200_000_000n] }) });
  await pub.waitForTransactionReceipt({ hash: fundHash });
  const usdtBal = () => pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [vault] });
  check('vault funded with 200 USDT', (await usdtBal()) === 200_000_000n);

  const cfg = await forOwner(base, owner.address);
  check('the server finds the logged-in wallet\'s vault', cfg.vault === vault);
  console.log('vault status', JSON.stringify(await vaultStatus(cfg)));

  // 1) executor buys $20 of BTC through HSKSwap
  const r1 = await executeTrade(cfg, { asset: 'BTC', side: 'buy', amount: 20, note: 'Fork test: first DCA buy' });
  const wbtc = await pub.readContract({ address: TOKENS.BTC.address, abi: erc20, functionName: 'balanceOf', args: [vault] });
  check('buy $20 of WBTC through the vault', r1.ok && wbtc > 0n, r1.ok ? `${r1.amountIn} ${r1.tokenIn} -> ${r1.amountOut} ${r1.tokenOut}, tx ${r1.txHash}` : r1.reason);

  // 2) per-trade cap
  const r2 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 60, note: 'too big' });
  check('a $60 buy is refused by the $50 per-trade cap', !r2.ok && /TradeTooLarge/.test(r2.reason), r2.ok ? 'executed!' : r2.reason.slice(0, 120));

  // 3) daily cap: 20 + 40 + 40 = 100 ok, then +30 > 120
  const r3 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 40, note: 'buy HSK' });
  const r4 = await executeTrade(cfg, { asset: 'ETH', side: 'buy', amount: 40, note: 'buy ETH' });
  check('two more $40 buys (HSK, ETH) succeed', r3.ok && r4.ok, [r3, r4].map((r) => (r.ok ? `${r.amountOut} ${r.tokenOut}` : r.reason)).join(' | '));
  const r5 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 30, note: 'over the day' });
  check('a 4th buy over $120/day is refused', !r5.ok && /DailyCapExceeded/.test(r5.reason), r5.ok ? 'executed!' : r5.reason.slice(0, 120));

  // 3b) the day's spending limit is used up, yet selling still works: getting out is never held up by it
  const weth = await pub.readContract({ address: TOKENS.ETH.address, abi: erc20, functionName: 'balanceOf', args: [vault] });
  check('the vault records what each holding cost', (await read(vault, 'costUsdt', [TOKENS.ETH.address])) === 40_000_000n && (await read(vault, 'costUsdt', [TOKENS.BTC.address])) === 20_000_000n);
  const out = await executeTrade(cfg, { asset: 'ETH', side: 'sell', amount: Number(formatUnits(weth / 2n, 18)), note: 'out on a full day' });
  check('with the day\'s limit used up, a sell still goes through', out.ok, out.ok ? `${out.amountIn} ${out.tokenIn} -> ${out.amountOut} ${out.tokenOut}` : out.reason);
  const halfCost = await read(vault, 'costUsdt', [TOKENS.ETH.address]);
  check('selling half leaves half the cost on the books', halfCost >= 19_999_990n && halfCost <= 20_000_010n, String(halfCost));
  const r5b = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 30, note: 'still over the day' });
  check('and the sell did not free up room to buy more', !r5b.ok && /DailyCapExceeded/.test(r5b.reason));

  // 4) slippage floor: agent tries minOut = 0 directly
  let slipReverted = false;
  try { await pub.simulateContract({ address: vault, abi, functionName: 'trade', args: [TOKENS.HSK.address, true, 1_000_000n, 0n, 'no floor'], account: agent }); } catch (e) { slipReverted = /SlippageTooLoose/.test(String(e.message)); }
  check('minOut = 0 is refused by the slippage floor', slipReverted);

  // 5) agent cannot withdraw; owner can
  let agentWithdrawReverted = false;
  try { await pub.simulateContract({ address: vault, abi, functionName: 'withdraw', args: [USDT, 1n], account: agent }); } catch (e) { agentWithdrawReverted = /NotOwner/.test(String(e.message)); }
  check('the agent key cannot withdraw', agentWithdrawReverted);
  const before = await usdtBal();
  const wh = await ownerW.writeContract({ address: vault, abi, functionName: 'withdraw', args: [USDT, 10_000_000n] });
  await pub.waitForTransactionReceipt({ hash: wh });
  check('the owner can withdraw 10 USDT', before - (await usdtBal()) === 10_000_000n);

  // 6) sell the WBTC back next day (new day budget)
  await test.increaseTime({ seconds: 86_400 });
  await test.mine({ blocks: 1 });
  const r6 = await executeTrade(cfg, { asset: 'BTC', side: 'sell', amount: Number(formatUnits(wbtc, 8)), note: 'Fork test: take profit' });
  check('sell the WBTC back for USDT', r6.ok, r6.ok ? `${r6.amountIn} ${r6.tokenIn} -> ${r6.amountOut} ${r6.tokenOut}` : r6.reason);

  // 6b) limits are the owner's to set: with none, a bigger order goes through; the agent cannot change them
  const NO_LIMIT = 2n ** 256n - 1n;
  let agentLimitsRefused = false;
  try { await pub.simulateContract({ address: vault, abi, functionName: 'setLimits', args: [NO_LIMIT, NO_LIMIT, 150], account: agent }); } catch (e) { agentLimitsRefused = /NotOwner/.test(String(e.message)); }
  check('the agent key cannot change the limits', agentLimitsRefused);
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setLimits', args: [NO_LIMIT, NO_LIMIT, 150] }) });
  // version 3: the agent's session has its own per-buy cap ($50 from the start); the owner lifts it with the limits
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setSession', args: [agent.address, BigInt(Number((await pub.getBlock()).timestamp) + 300 * 86_400), NO_LIMIT, assets.map((a) => TOKENS[a].address)] }) });
  const open = await vaultStatus(cfg);
  check('after the owner removes the limits, the server reports none', open.maxTradeUsdt === undefined && open.maxDailyUsdt === undefined && open.remainingTodayUsdt === undefined);
  const big = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 100, note: 'no limits set' });
  check('a $100 buy (above the old $50 cap) goes through with no limits', big.ok, big.ok ? `${big.amountOut} ${big.tokenOut}` : big.reason);
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setLimits', args: [5_000_000n, 500_000_000n, 100] }) });
  const tight = await vaultStatus(cfg);
  check('the owner sets new limits and the server reports them', tight.maxTradeUsdt === '5' && tight.maxDailyUsdt === '500' && tight.maxSlippageBps === 100);
  const over = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 6, note: 'over my own limit' });
  check('an order above the owner\'s new limit is refused', !over.ok && /TradeTooLarge/.test(over.reason), over.ok ? 'executed!' : over.reason.slice(0, 100));
  const snug = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'tighter price floor' });
  check('with the owner\'s 1% price floor, an order inside the limit still goes through', snug.ok, snug.ok ? `${snug.amountOut} ${snug.tokenOut}` : snug.reason);

  // 7) pause stops the agent
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setPaused', args: [true] }) });
  const r7 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 2, note: 'paused' });
  check('trades are refused while paused', !r7.ok && /IsPaused/.test(r7.reason), r7.ok ? 'executed!' : r7.reason.slice(0, 100));

  // 7b) the stop-loss: set by the owner, carried out by anyone, and not fooled by a price pushed for one block
  const hskToken = TOKENS.HSK.address;
  const stopCall = (account) => pub.simulateContract({ address: vault, abi, functionName: 'stopOut', args: [hskToken], account });
  const refusal = async (account) => { try { await stopCall(account); return 'went through'; } catch (e) { return /(NoStopLoss|StopNotReached|PriceMoving|NothingToSell)/.exec(String(e.message))?.[1] ?? String(e.message).slice(0, 80); } };
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setStopLoss', args: [0] }) });
  check('the owner can turn the starting stop-loss off; with none, nobody can sell the holding', (await read(vault, 'stopLossBps')) === 0 && (await refusal(carol)) === 'NoStopLoss');
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setLimits', args: [NO_LIMIT, NO_LIMIT, 300] }) });
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setStopLoss', args: [1000] }) });
  const before7 = await read(vault, 'position', [hskToken]);
  console.log('WHSK position: held', formatUnits(before7[0], 18), 'cost', formatUnits(before7[1], 6), 'worth', formatUnits(before7[2], 6), 'stop under', formatUnits(before7[3], 6));
  check('a 10% stop-loss does not fire while the holding is worth about what it cost', (await refusal(carol)) === 'StopNotReached');
  let agentStopRefused = false;
  try { await pub.simulateContract({ address: vault, abi, functionName: 'setStopLoss', args: [0], account: agent }); } catch (e) { agentStopRefused = /NotOwner/.test(String(e.message)); }
  check('the agent key cannot change the stop-loss', agentStopRefused);

  // someone dumps WHSK into the pool until the holding is down more than 10%
  const dumper = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');
  const dumperW = createWalletClient({ account: dumper, chain, transport: http(RPC) });
  await test.setBalance({ address: dumper.address, value: 10n ** 25n });
  const whskAbi = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }, { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] }];
  const routerAbi = [{ type: 'function', name: 'exactInputSingle', stateMutability: 'payable', inputs: [{ name: 'p', type: 'tuple', components: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] }], outputs: [{ type: 'uint256' }] }];
  await pub.waitForTransactionReceipt({ hash: await dumperW.writeContract({ address: hskToken, abi: whskAbi, functionName: 'deposit', value: 5n * 10n ** 24n }) });
  await pub.waitForTransactionReceipt({ hash: await dumperW.writeContract({ address: hskToken, abi: whskAbi, functionName: 'approve', args: [ROUTER, 5n * 10n ** 24n] }) });
  let pos = before7;
  for (let i = 0; i < 40 && pos[2] * 100n >= pos[1] * 86n; i++) {
    await pub.waitForTransactionReceipt({ hash: await dumperW.writeContract({ address: ROUTER, abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: hskToken, tokenOut: USDT, fee: 3000, recipient: dumper.address, amountIn: 10n ** 23n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) });
    pos = await read(vault, 'position', [hskToken]);
  }
  console.log('after the dump: worth', formatUnits(pos[2], 6), 'against a stop under', formatUnits(pos[3], 6));
  check('the holding is now worth less than the stop allows', pos[2] < pos[3]);
  check('right after the price was pushed, the stop is refused: the price is away from its 10-minute average', (await refusal(carol)) === 'PriceMoving');
  await test.increaseTime({ seconds: 660 });
  await test.mine({ blocks: 1 });
  check('the vault is still paused for the agent', (await read(vault, 'paused')) === true);
  const usdtBefore = await usdtBal();
  const carolW = createWalletClient({ account: carol, chain, transport: http(RPC) });
  await test.setBalance({ address: carol.address, value: 10n ** 20n });
  const stopReceipt = await pub.waitForTransactionReceipt({ hash: await carolW.writeContract({ address: vault, abi, functionName: 'stopOut', args: [hskToken] }) });
  const afterStop = await read(vault, 'position', [hskToken]);
  const got = (await usdtBal()) - usdtBefore;
  check('once the price has held for 10 minutes, a stranger carries out the stop and the USDT stays in the vault', stopReceipt.status === 'success' && afterStop[0] === 0n && afterStop[1] === 0n && got > 0n, `sold ${formatUnits(pos[0], 18)} WHSK for ${formatUnits(got, 6)} USDT (cost ${formatUnits(pos[1], 6)})`);
  const carolGot = await pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [carol.address] });
  check('the stranger got nothing out of it', carolGot === 0n);
  check('with the holding gone there is nothing left to stop out', (await refusal(carol)) === 'NothingToSell');
  const serverStop = await stopOut(cfg, 'HSK');
  check('the server\'s own stop-loss check reports the vault\'s refusal instead of sending', !serverStop.ok && /NothingToSell/.test(serverStop.reason), serverStop.ok ? 'sent!' : serverStop.reason);

  // 9) version 3 hardening: the price floor is the pool's 10-minute average, the guardian's halt, revoking the agent
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setPaused', args: [false] }) });
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setLimits', args: [NO_LIMIT, NO_LIMIT, 150] }) });
  const before9 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'calm pool' });
  check('in a calm pool the agent buys HSK at the average price', before9.ok, before9.ok ? before9.amountOut : before9.reason);
  // someone pushes the HSK price down in one block, then the agent is sent to sell into it
  for (let i = 0; i < 3; i++) await pub.waitForTransactionReceipt({ hash: await dumperW.writeContract({ address: ROUTER, abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: hskToken, tokenOut: USDT, fee: 3000, recipient: dumper.address, amountIn: 10n ** 23n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) });
  const heldHsk = await pub.readContract({ address: hskToken, abi: erc20, functionName: 'balanceOf', args: [vault] });
  const pushedSell = await executeTrade(cfg, { asset: 'HSK', side: 'sell', amount: Number(formatUnits((heldHsk * 999n) / 1000n, 18)), note: 'into a pushed price' });
  check('right after the price was pushed down, the agent cannot sell into it: the floor is the 10-minute average', !pushedSell.ok && /PriceMoving/.test(pushedSell.reason), pushedSell.ok ? 'sold!' : pushedSell.reason.slice(0, 100));
  const spotQ = await read(vault, 'quote', [hskToken, false, heldHsk]);
  let rawSell = 'went through';
  try { await pub.simulateContract({ address: vault, abi, functionName: 'trade', args: [hskToken, false, heldHsk, (spotQ * 9_990n) / 10_000n, 'floor from spot'], account: agent }); } catch (e) { rawSell = /(SlippageTooLoose|PriceMoving)/.exec(String(e.message))?.[1] ?? String(e.message).slice(0, 80); }
  check('a key that asks for a floor from the pushed price is refused too', rawSell === 'SlippageTooLoose', rawSell);
  await test.increaseTime({ seconds: 660 });
  await test.mine({ blocks: 1 });
  const laterSell = await executeTrade(cfg, { asset: 'HSK', side: 'sell', amount: Number(formatUnits((heldHsk * 999n) / 1000n, 18)), note: 'after the price held' });
  check('once the price has held for 10 minutes the same sell goes through', laterSell.ok, laterSell.ok ? laterSell.amountOut : laterSell.reason);

  const factoryAbi = factoryArtifact.abi;
  let strangerHalt = 'went through';
  try { await pub.simulateContract({ address: factory, abi: factoryAbi, functionName: 'setHalted', args: [true], account: carol }); } catch (e) { strangerHalt = /not guardian/.test(String(e.message)) ? 'refused' : String(e.message).slice(0, 60); }
  check('only the guardian can halt agent trading', strangerHalt === 'refused');
  const guardianW = createWalletClient({ account: guardian, chain, transport: http(RPC) });
  await test.setBalance({ address: guardian.address, value: 10n ** 20n });
  await pub.waitForTransactionReceipt({ hash: await guardianW.writeContract({ address: factory, abi: factoryAbi, functionName: 'setHalted', args: [true] }) });
  const halted = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 2, note: 'halted' });
  check('with the guardian\'s halt on, the agent cannot trade on any vault', !halted.ok && /Halted/.test(halted.reason), halted.ok ? 'traded!' : halted.reason.slice(0, 80));
  check('the vault status reports the halt', (await vaultStatus(cfg)).halted === true);
  const wBefore = await usdtBal();
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'withdraw', args: [USDT, 1_000_000n] }) });
  check('while halted the owner still withdraws', wBefore - (await usdtBal()) === 1_000_000n);
  await pub.waitForTransactionReceipt({ hash: await guardianW.writeContract({ address: factory, abi: factoryAbi, functionName: 'setHalted', args: [false] }) });
  const resumed = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 2, note: 'resumed' });
  check('after the guardian lifts the halt, trading works again', resumed.ok, resumed.ok ? '' : resumed.reason);

  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setAgent', args: [carol.address] }) });
  const revoked = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 2, note: 'revoked key' });
  check('after the owner replaces the agent key on the vault, the server holds no key for it and sends nothing', !revoked.ok && /another agent key/.test(revoked.reason), revoked.ok ? 'traded!' : revoked.reason.slice(0, 80));
  let agentSetAgent = 'went through';
  try { await pub.simulateContract({ address: vault, abi, functionName: 'setAgent', args: [agent.address], account: agent }); } catch (e) { agentSetAgent = /NotOwner/.test(String(e.message)) ? 'refused' : 'other'; }
  check('the old key cannot put itself back', agentSetAgent === 'refused');
  let oldKeyRaw = 'went through';
  try { await pub.simulateContract({ address: vault, abi, functionName: 'trade', args: [hskToken, true, 1_000_000n, NO_LIMIT, 'old key'], account: agent }); } catch (e) { oldKeyRaw = /NotAgent/.test(String(e.message)) ? 'NotAgent' : String(e.message).slice(0, 60); }
  check('and the vault itself refuses the old key', oldKeyRaw === 'NotAgent');
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setAgent', args: [agent.address] }) });

  // 10) the agent key's session: until when, which coins, most per buy; revocable; another key the owner authorises
  const now = async () => Number((await pub.getBlock()).timestamp);
  // the second user's vault has not been touched since it was made
  const ses0 = (await vaultStatus(await forOwner(base, carol.address))).session;
  const made0 = Number((await pub.getBlock({ blockNumber: (await pub.getTransactionReceipt({ hash: carolMade.txHash })).blockNumber })).timestamp);
  check('a new vault starts with a session for the agent: 30 days from its making, all three coins, at the starting per-trade limit', ses0?.agent === agent.address && ses0.ours && ses0.assets.length === 3 && ses0.until === made0 + 30 * 86_400 && ses0.maxTradeUsdt === '50', JSON.stringify(ses0));
  const sessionRefusal = async (account, args) => { try { await pub.simulateContract({ address: vault, abi, functionName: 'setSession', args, account }); return 'went through'; } catch (e) { return /(NotOwner|BadSession|MarketDisabled)/.exec(String(e.message))?.[1] ?? String(e.message).slice(0, 60); } };
  const t0 = await now();
  check('only the owner can set a session; the agent key cannot extend its own', (await sessionRefusal(carol, [carol.address, BigInt(t0 + 3600), 1_000_000n, [TOKENS.HSK.address]])) === 'NotOwner' && (await sessionRefusal(agent, [agent.address, BigInt(t0 + 86_400 * 300), NO_LIMIT, [TOKENS.HSK.address]])) === 'NotOwner');
  check('a session longer than a year, already over, or for the owner\'s own key is refused', (await sessionRefusal(owner, [agent.address, BigInt(t0 + 400 * 86_400), 1n, []])) === 'BadSession' && (await sessionRefusal(owner, [agent.address, BigInt(t0 - 1), 1n, []])) === 'BadSession' && (await sessionRefusal(owner, [owner.address, BigInt(t0 + 3600), 1n, []])) === 'BadSession');
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setSession', args: [agent.address, BigInt(t0 + 86_400), 5_000_000n, [TOKENS.BTC.address]] }) });
  const notHsk = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 2, note: 'outside the session' });
  check('a coin outside the session is refused by the server before sending', !notHsk.ok && /does not cover HSK/.test(notHsk.reason), notHsk.ok ? 'traded!' : notHsk.reason);
  let rawHsk = 'went through';
  try { await pub.simulateContract({ address: vault, abi, functionName: 'trade', args: [TOKENS.HSK.address, true, 1_000_000n, NO_LIMIT, 'x'], account: agent }); } catch (e) { rawHsk = /NotInSession/.test(String(e.message)) ? 'NotInSession' : String(e.message).slice(0, 60); }
  check('and by the vault itself if sent anyway', rawHsk === 'NotInSession');
  const bigBtc = await executeTrade(cfg, { asset: 'BTC', side: 'buy', amount: 6, note: 'over the session cap' });
  check('a $6 buy is refused by the session\'s $5 cap, though the vault itself has no limit', !bigBtc.ok && /TradeTooLarge\(6000000, 5000000\)/.test(bigBtc.reason), bigBtc.ok ? 'traded!' : bigBtc.reason.slice(0, 80));
  const okBtc = await executeTrade(cfg, { asset: 'BTC', side: 'buy', amount: 5, note: 'inside the session' });
  check('a $5 BTC buy inside the session goes through', okBtc.ok, okBtc.ok ? '' : okBtc.reason);
  await test.increaseTime({ seconds: 86_401 });
  await test.mine({ blocks: 1 });
  const late = await executeTrade(cfg, { asset: 'BTC', side: 'buy', amount: 1, note: 'after the session' });
  check('once the session has ended, the server sends nothing and says so', !late.ok && /session on this vault ended/.test(late.reason), late.ok ? 'traded!' : late.reason);
  let rawLate = 'went through';
  try { await pub.simulateContract({ address: vault, abi, functionName: 'trade', args: [TOKENS.BTC.address, true, 1_000_000n, NO_LIMIT, 'x'], account: agent }); } catch (e) { rawLate = /SessionOver/.test(String(e.message)) ? 'SessionOver' : String(e.message).slice(0, 60); }
  check('and the vault refuses the key after its session', rawLate === 'SessionOver');
  // the owner authorises another key the server holds (key rotation): the server uses it, and the old key is out
  const newKey = '0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e';
  const rotated = { ...cfg, agentKeys: [newKey] };
  const t1 = await now();
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setSession', args: [privateKeyToAccount(newKey).address, BigInt(t1 + 7 * 86_400), 20_000_000n, assets.map((a) => TOKENS[a].address)] }) });
  await test.setBalance({ address: privateKeyToAccount(newKey).address, value: 10n ** 20n });
  const viaNew = await executeTrade(rotated, { asset: 'HSK', side: 'buy', amount: 3, note: 'with the new key' });
  check('with a session for another key the server holds, it trades with that key', viaNew.ok && (await pub.getTransaction({ hash: viaNew.txHash })).from.toLowerCase() === privateKeyToAccount(newKey).address.toLowerCase(), viaNew.ok ? '' : viaNew.reason);
  const viaOld = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 3, note: 'old key only' });
  check('a server without that key refuses to send, and the old key is no longer the vault\'s agent', !viaOld.ok && /another agent key/.test(viaOld.reason), viaOld.ok ? 'traded!' : viaOld.reason);
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'revokeSession' }) });
  const revokedS = await executeTrade(rotated, { asset: 'HSK', side: 'buy', amount: 3, note: 'after revoking' });
  check('after the owner revokes the session, nothing is sent', !revokedS.ok && /session on this vault ended/.test(revokedS.reason), revokedS.ok ? 'traded!' : revokedS.reason);
  check('the stop-loss is never tied to the session: stopOut stays open to anyone', !/SessionOver|NotAgent/.test(await (async () => { try { await pub.simulateContract({ address: vault, abi, functionName: 'stopOut', args: [TOKENS.BTC.address], account: carol }); return 'ok'; } catch (e) { return String(e.message); } })()));

  // 8) no vault configured -> executor refuses before touching the chain
  const r8 = await executeTrade({ ...cfg, vault: undefined }, { asset: 'HSK', side: 'buy', amount: 5, note: 'x' });
  check('without a vault the executor refuses', !r8.ok && /No vault/.test(r8.reason));
  const carolUsdt = await pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [carolMade.vault] });
  check('the other user\'s vault was never touched', carolUsdt === 0n);
} catch (e) {
  fail++;
  console.error('ERROR', e);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  stop();
  process.exit(fail ? 1 : 0);
}
