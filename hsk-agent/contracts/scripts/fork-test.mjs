// End-to-end test on a local fork of HSK Chain mainnet: deploy the factory, let the server make each user's vault,
// fund one, trade through the real HSKSwap pools with the server executor, and check every guard.
// No real funds are used.
// Usage: node --experimental-strip-types scripts/fork-test.mjs   (from hsk-agent/contracts)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeTrade, vaultStatus, createVault, vaultOf, forOwner, TOKENS, USDT } from '../../server/executor.ts';

const RPC = 'http://127.0.0.1:8546';
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
const node = spawn('npx', ['hardhat', 'node', '--port', '8546'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
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

  // the factory: every vault starts with $50 per trade, $120 per day, 1.5% slippage floor and the three markets
  const assets = ['HSK', 'ETH', 'BTC'];
  const deployHash = await ownerW.deployContract({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode, args: [agent.address, USDT, ROUTER, 50_000_000n, 120_000_000n, 150, assets.map((a) => TOKENS[a].address), assets.map((a) => POOLS[a])] });
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
