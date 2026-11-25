// End-to-end test on a local fork of HSK Chain mainnet: deploy MoaVault, fund it, trade through the real
// HSKSwap pools with the server executor, and check every guard. No real funds are used.
// Usage: node --experimental-strip-types scripts/fork-test.mjs   (from hsk-agent/contracts)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeTrade, vaultStatus, TOKENS, USDT } from '../../server/executor.ts';

const RPC = 'http://127.0.0.1:8546';
const ROUTER = '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3';
const POOLS = { HSK: '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc', ETH: '0xb92b79ed6b370d5cfee2e14b1d0983c258304c16', BTC: '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a' };
// Hardhat's well-known local test keys (public, never funded on any real chain)
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const { abi, bytecode } = JSON.parse(readFileSync(new URL('../out/MoaVault.json', import.meta.url)));
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const chain = { id: 177, name: 'HSK fork', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const node = spawn('npx', ['hardhat', 'node', '--port', '8546'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
let nodeLog = '';
node.stdout.on('data', (d) => (nodeLog += d));
node.stderr.on('data', (d) => (nodeLog += d));
const stop = () => node.kill('SIGTERM');
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

  // deploy: $50 per trade, $120 per day, 1.5% slippage floor
  const deployHash = await ownerW.deployContract({ abi, bytecode, args: [owner.address, agent.address, USDT, ROUTER, 50_000_000n, 120_000_000n, 150] });
  const vault = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
  console.log('vault', vault);
  for (const a of ['HSK', 'ETH', 'BTC']) {
    const h = await ownerW.writeContract({ address: vault, abi, functionName: 'setMarket', args: [TOKENS[a].address, POOLS[a], true] });
    await pub.waitForTransactionReceipt({ hash: h });
  }

  // fund the vault with 200 USDT taken from the WHSK/USDT pool's balance (fork only)
  await test.impersonateAccount({ address: POOLS.HSK });
  await test.setBalance({ address: POOLS.HSK, value: 10n ** 21n });
  const poolW = createWalletClient({ account: POOLS.HSK, chain, transport: http(RPC) }); // impersonated JSON-RPC account
  const fundHash = await poolW.sendTransaction({ to: USDT, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [vault, 200_000_000n] }) });
  await pub.waitForTransactionReceipt({ hash: fundHash });
  const usdtBal = () => pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [vault] });
  check('vault funded with 200 USDT', (await usdtBal()) === 200_000_000n);

  const cfg = { rpcUrl: RPC, chainId: 177, vault, agentKey: AGENT_KEY, explorer: 'https://hsk.blockscout.com', minOutBufferBps: 100 };
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

  // 7) pause stops the agent
  await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract({ address: vault, abi, functionName: 'setPaused', args: [true] }) });
  const r7 = await executeTrade(cfg, { asset: 'HSK', side: 'buy', amount: 5, note: 'paused' });
  check('trades are refused while paused', !r7.ok && /IsPaused/.test(r7.reason));

  // 8) no vault configured -> executor refuses before touching the chain
  const r8 = await executeTrade({ ...cfg, vault: undefined }, { asset: 'HSK', side: 'buy', amount: 5, note: 'x' });
  check('without a vault the executor refuses', !r8.ok && /not configured/.test(r8.reason));
} catch (e) {
  fail++;
  console.error('ERROR', e);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  stop();
  process.exit(fail ? 1 : 0);
}
