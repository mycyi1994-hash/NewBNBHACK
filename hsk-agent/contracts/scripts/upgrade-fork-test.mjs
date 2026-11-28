// Moving a wallet from a version-2 vault to a version-3 vault, rehearsed on a local fork of HSK Chain mainnet with
// the code the app runs: the server's API (server/api.ts over HTTP, with a login token), the browser's own functions
// (src/move.ts, and src/account.ts signing through a stand-in wallet that holds a fork test key), and the executor.
// It also settles, with evidence, how a version-3 vault treats a coin that arrives by plain transfer.
// No real funds are used; every transaction goes to the fork.
// Usage: node --experimental-strip-types scripts/upgrade-fork-test.mjs   (from contracts/; FORK_PORT, default 8558)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, formatUnits, http, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { issue } from '../../server/session.ts';

const PORT = process.env.FORK_PORT || '8558';
const RPC = `http://127.0.0.1:${PORT}`;
const ROUTER = '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3';
const POOLS = { HSK: '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc', ETH: '0xb92b79ed6b370d5cfee2e14b1d0983c258304c16', BTC: '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a' };
// Hardhat's well-known local test keys (public, never funded on any real chain)
const KEYS = {
  mover: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',     // has a version-2 vault with USDT and a coin
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  fresh: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',     // logs in for the first time after the switch
  nobody: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',    // never had a vault
  coins: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',     // sends a coin into a version-3 vault by plain transfer
  guardian: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  late: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',      // has a version-2 vault; asks to move on a day the cap is used up
  deployer: '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
};
const art = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const v3 = { factory: art('../out/MoaVaultFactory.json'), vault: art('../out/MoaVault.json') };
// Version 2, as deployed on mainnet (factory 0xd6bF…6546)
const v2 = { factory: art('../legacy/v2/MoaVaultFactory.json'), vault: art('../legacy/v2/MoaVault.json') };
const abi = v3.vault.abi;
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const chain = { id: 177, name: 'HSK fork', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const NO_LIMIT = 2n ** 256n - 1n;
const SECRET = 'fork-rehearsal';

// The browser's code runs in this process too: a stand-in wallet (EIP-1193) that signs with the mover's fork key, the
// session the login would have stored, and relative /api/ requests sent to the server started below. These are in
// place before the app's modules load, because src/account.ts reads the stored session once, when it loads.
const token = (who) => issue(SECRET, who, Date.now() + 3_600_000);
const mover = privateKeyToAccount(KEYS.mover).address;
const stand = { signatures: 0, api: '', send: null, rpc: null };
globalThis.window = { addEventListener() {}, dispatchEvent() { return true; }, ethereum: { request: async ({ method, params }) => {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [mover];
  if (method === 'eth_chainId') return '0xb1';
  if (method === 'eth_sendTransaction') { stand.signatures++; return stand.send({ to: params[0].to, data: params[0].data }); }
  return stand.rpc({ method, params });
} } };
const kept = { 'moa.session.v1': JSON.stringify({ address: mover, token: token(mover), expiresAt: Date.now() + 3_600_000 }) };
globalThis.localStorage = { getItem: (k) => kept[k] ?? null, setItem() {}, removeItem() {} };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(typeof url === 'string' && url.startsWith('/') ? stand.api + url : url, init);
const { createVault, executeTrade, factoryVersion, feesLive, forOwner, moveStatus, upgradeVault, vaultOf, vaultStatus, vaultVersion, TOKENS, USDT } = await import('../../server/executor.ts');
const { createApi } = await import('../../server/api.ts');
const { openStore } = await import('../../server/autoStore.ts');
const { liveDeps, newRunnerState, tick } = await import('../../server/autoRunner.ts');
const { fromTemplate } = await import('../../src/spec.ts');
const app = await import('../../src/account.ts');
const move = await import('../../src/move.ts');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const node = spawn('npx', ['hardhat', 'node', '--port', PORT], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
let nodeLog = '';
node.stdout.on('data', (d) => (nodeLog += d));
node.stderr.on('data', (d) => (nodeLog += d));
const stop = () => { try { if (process.platform === 'win32') node.kill('SIGTERM'); else process.kill(-node.pid, 'SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);
let server;

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
  const deploy = async (f, args) => (await mined(await W.deployer.deployContract({ abi: f.abi, bytecode: f.bytecode, args }))).contractAddress;
  // the factory on mainnet today (version 2: no limits, no stop-loss at the start), and the one about to be deployed
  const oldFactory = await deploy(v2.factory, [acc.agent.address, USDT, ROUTER, NO_LIMIT, NO_LIMIT, 150, 0, ...markets]);
  const factory = await deploy(v3.factory, [acc.agent.address, USDT, ROUTER, 50_000_000n, 100_000_000n, 150, 1500, ...markets, acc.guardian.address]);
  console.log('fork block', await pub.getBlockNumber(), 'factory v3', factory, 'factory v2', oldFactory);
  const common = { rpcUrl: RPC, chainId: 177, agentKey: KEYS.agent, explorer: 'https://hsk.blockscout.com', minOutBufferBps: 100, maxVaultsPerDay: 20 };
  const today = { ...common, factory: oldFactory };                              // the server as it runs on mainnet today
  const base = { ...common, factory, legacyFactories: [oldFactory] };           // the server after the owner's switch
  const bal = (token, who) => pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] });
  const usdt = (who) => bal(USDT, who);
  const wbtc = (who) => bal(TOKENS.BTC.address, who);
  const give = async (pool, token, to, amount) => {   // fork only: tokens out of a pool's balance
    await test.impersonateAccount({ address: pool });
    await test.setBalance({ address: pool, value: 10n ** 21n });
    await mined(await createWalletClient({ account: pool, chain, transport: http(RPC) }).sendTransaction({ to: token, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [to, amount] }) }));
  };
  const count = (f) => pub.readContract({ address: f, abi: v3.factory.abi, functionName: 'vaultCount' });
  const agentNonce = () => pub.getTransactionCount({ address: acc.agent.address });
  stand.send = (tx) => W.mover.sendTransaction(tx);
  stand.rpc = (call) => pub.request(call);

  /* ----- before the switch: a version-2 vault with USDT and a coin an agent bought ----- */
  const made2 = await createVault(today, mover);
  if (!made2.ok) throw new Error(made2.reason);
  const oldVault = made2.vault;
  await give(POOLS.HSK, USDT, oldVault, 100_000_000n);
  const bought = await executeTrade(await forOwner(today, mover), { asset: 'BTC', side: 'buy', amount: 20, note: 'bought on the old vault' });
  if (!bought.ok) throw new Error(bought.reason);
  const oldBtc = await wbtc(oldVault);
  check('before: the wallet has a version-2 vault holding 80 USDT and the WBTC its agent bought', (await vaultVersion(today, oldVault)) === 2 && (await usdt(oldVault)) === 80_000_000n && oldBtc > 0n, `${formatUnits(oldBtc, 8)} WBTC`);
  check('the server tells which version a factory makes: 2 for the one on mainnet, 3 for the new one', (await factoryVersion(base, oldFactory)) === 2 && (await factoryVersion(base, factory)) === 3);
  check('creator fees are off while the server makes version-2 vaults, and on once it makes version 3', (await feesLive(today)) === false && (await feesLive(base)) === true);
  check('pointed at the version-2 factory alone, no move is offered (there is nothing newer)', (await moveStatus(await forOwner(today, mover))).upgrade.available === false);
  const lateMade = await createVault(today, acc.late.address);

  /* ----- the server after the switch, over HTTP, and the browser's own code against it ----- */
  const store = openStore();
  const hired = (over = {}) => ({ id: 'a1', createdAt: Date.now() - 86_400_000, asset: 'BTC', perBuyUsd: 10, budgetUsd: 100, mode: 'auto', paused: false, fired: [], fills: [], log: [], source: { type: 'market', agentId: 'trend200:BTCUSDT-PERPETUAL', kind: 'position', rule: 'trend200', base: 'BTC' }, ...over });
  store.put(mover, hired());
  store.put(mover, hired({ id: 'p1', paused: true }));   // one the owner paused long ago
  const dataDir = mkdtempSync(join(tmpdir(), 'moa-upgrade-'));
  const env = { MOA_RPC_URL: RPC, MOA_CHAIN_ID: '177', MOA_FACTORY_ADDRESS: factory, MOA_LEGACY_FACTORY_ADDRESSES: oldFactory, MOA_AGENT_PRIVATE_KEY: KEYS.agent, MOA_SESSION_SECRET: SECRET, MOA_DATA_DIR: dataDir };
  const api = createApi(env, { store });
  server = createServer((req, res) => void api.handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const API = `http://127.0.0.1:${server.address().port}`;
  // the same server pointed at the version-2 factory alone, as on mainnet today: for the creator-fee switch
  const apiToday = createApi({ ...env, MOA_FACTORY_ADDRESS: oldFactory, MOA_LEGACY_FACTORY_ADDRESSES: '', MOA_DATA_DIR: mkdtempSync(join(tmpdir(), 'moa-upgrade-')) }, { store: openStore() });
  const serverToday = createServer((req, res) => void apiToday.handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((done) => serverToday.listen(0, '127.0.0.1', done));
  const API_TODAY = `http://127.0.0.1:${serverToday.address().port}`;
  stand.api = API;
  const auth = (who) => ({ authorization: `Bearer ${token(who)}` });
  const get = async (path, who, at = API) => (await fetch(`${at}${path}`, { headers: who ? auth(who) : {} })).json();
  const post = (path, body, who, headers = {}, at = API) => fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? auth(who) : {}), ...headers }, body: JSON.stringify(body) });

  /* ----- 0) what the app is told before the move ----- */
  const s0 = await get('/api/vault', mover);
  check('GET /api/vault: the active vault is still the version-2 one, and it says so', s0.configured && s0.vault === oldVault && s0.version === 2);
  check('GET /api/vault: a move to a version-3 vault is available', s0.upgrade?.available === true && s0.upgrade.to === 3 && s0.moved === false && s0.old === undefined, JSON.stringify(s0.upgrade));
  check('the app reads step 1 (make the new vault) from that, and that the old vault holds a coin', move.moveStage(s0) === 'make' && move.stepOf('make') === 1 && move.coinsToLeave(s0, 'make').join() === 'WBTC');
  check('GET /api/vault and /api/terms say new shares may carry a creator fee (the server makes version-3 vaults)', s0.creatorFees === true && (await get('/api/terms')).creatorFees === true);
  const termsToday = await get('/api/terms', undefined, API_TODAY);
  const spec = { id: 'made-1', name: 'ETH trend', market: 'ETHUSDT-PERPETUAL', ...fromTemplate('trend200'), createdAt: 1 };
  const feeToday = await post('/api/shared', { spec, feeBps: 50, nick: 'x' }, mover, {}, API_TODAY);
  const freeToday = await post('/api/shared', { spec, feeBps: 0, nick: 'x' }, mover, {}, API_TODAY);
  check('on the server as it is today (version-2 factory) they may not: /api/terms says no, a share asking 0.5% is refused, a free one is published', termsToday.creatorFees === false && feeToday.status === 400 && (await feeToday.json()).why === 'fee' && freeToday.status === 200, `fee ${feeToday.status}, free ${freeToday.status}`);
  const feeNew = await post('/api/shared', { spec, feeBps: 50, nick: 'x' }, mover);
  check('on the version-3 server the same 0.5% share is published', feeNew.status === 200 && (await feeNew.json()).agent?.feeBps === 50, `HTTP ${feeNew.status}`);

  /* ----- 1) make the new vault: Moa does it, the wallet signs nothing ----- */
  check('POST /api/vault/upgrade needs a login', (await post('/api/vault/upgrade', {})).status === 401);
  check('and refuses another website, and anything but JSON', (await post('/api/vault/upgrade', {}, mover, { origin: 'https://evil.example' })).status === 403 && (await post('/api/vault/upgrade', {}, mover, { 'content-type': 'text/plain' })).status === 415);
  const n0 = await agentNonce(), c0 = await count(factory);
  const up = await move.makeNewVault();
  const newVault = await vaultOf(base, mover);
  check('step 1 (the app\'s own call): the new vault is made, the agent key paid, the wallet signed nothing', up.ok && up.made && stand.signatures === 0 && (await agentNonce()) === n0 + 1 && (await count(factory)) === c0 + 1n, JSON.stringify(up));
  check('the wallet now has a version-3 vault of its own, and it is the active one', !!newVault && newVault !== oldVault && (await vaultVersion(base, newVault)) === 3 && (await pub.readContract({ address: newVault, abi, functionName: 'owner' })) === mover);
  check('nothing moved: the old vault holds exactly what it held', (await usdt(oldVault)) === 80_000_000n && (await wbtc(oldVault)) === oldBtc && (await usdt(newVault)) === 0n);
  const s1 = await get('/api/vault', mover);
  check('GET /api/vault: the active vault is the new one (version 3), no further move is offered', s1.vault === newVault && s1.version === 3 && s1.upgrade.available === false && s1.moved === true);
  check('the old vault is still reported: its address, its version and its balances (80 USDT and the WBTC, valued)', s1.old?.vault === oldVault && s1.old.version === 2 && s1.old.usdtBalance === '80' && s1.old.holdings.length === 1 && s1.old.holdings[0].symbol === 'WBTC' && s1.old.holdings[0].amount === formatUnits(oldBtc, 8) && Number(s1.old.holdings[0].valueUsdt) > 15 && Number(s1.old.totalUsdt) > 95, JSON.stringify(s1.old));
  const terms = move.startTerms(s1);
  check('the new vault starts with $50 per trade, $100 a day, a 15% stop-loss and a 30-day agent permission', terms.perTrade === '50' && terms.perDay === '100' && terms.stopPct === 15 && terms.days === 30 && s1.session?.ours === true && s1.session.assets.length === 3, JSON.stringify(terms));
  check('the app reads step 2 (take everything out of the old vault) from the chain alone', move.moveStage(s1) === 'takeOut' && move.stepOf('takeOut') === 2);

  // the wallet's agents on auto
  const a1 = store.list(mover).find((a) => a.id === 'a1'), p1 = store.list(mover).find((a) => a.id === 'p1');
  check('its agent on auto was paused, with the reason; the one its owner had paused is as it was', up.ok && up.paused === 1 && a1.paused && a1.pausedWhy === 'moved' && p1.paused && p1.pausedWhy === undefined);
  const st = await get('/api/auto/status', mover);
  check('GET /api/auto/status says why it rests', st.agents.find((a) => a.id === 'a1')?.why === 'moved' && st.agents.find((a) => a.id === 'p1')?.why === undefined, JSON.stringify(st.agents));
  const runner = newRunnerState();
  const n1 = await agentNonce();
  await tick(store, liveDeps(base), Date.now(), runner);
  check('a pass of the runner sends nothing into the empty new vault, and records the reason', (await agentNonce()) === n1 && runner.agents.get('a1')?.k === 'paused' && runner.agents.get('a1')?.why === 'moved');

  // asking again changes nothing, even after the owner has resumed the agent
  const resumed = await post('/api/auto', { agent: { ...a1, paused: false } }, mover);
  check('the owner resumes the agent: the reason is gone', resumed.status === 200 && store.list(mover).find((a) => a.id === 'a1').paused === false && store.list(mover).find((a) => a.id === 'a1').pausedWhy === undefined);
  const again = await move.makeNewVault();
  check('a second upgrade call changes nothing: the same vault, no transaction, no agent paused again', again.ok && !again.made && again.paused === 0 && (await agentNonce()) === n1 && (await count(factory)) === c0 + 1n && (await vaultOf(base, mover)) === newVault && store.list(mover).find((a) => a.id === 'a1').paused === false);
  const direct = await upgradeVault(base, mover);
  check('the server function says the same', direct.ok && direct.made === false && direct.vault === newVault && direct.from === oldVault && !direct.txHash);

  /* ----- 2) take everything out of the old vault: the owner's wallet, one withdrawal per token ----- */
  const list = move.takeOutList(s1.old, s1.net.usdt);
  check('step 2 is one withdrawal per token the old vault holds: USDT, then WBTC', list.map((x) => x.symbol).join() === 'USDT,WBTC');
  const w0 = await usdt(mover), b0 = await wbtc(mover);
  const out1 = await app.withdraw(s1.net, s1.old.vault, list[0], list[0].amount);
  const mid = await get('/api/vault', mover);
  check('after the USDT alone (the tab closed here), the old vault is still reported with its WBTC and step 2 is still waiting', out1.ok && mid.old?.usdtBalance === '0' && mid.old.holdings[0]?.symbol === 'WBTC' && move.moveStage(mid) === 'takeOut' && move.takeOutList(mid.old, mid.net.usdt).map((x) => x.symbol).join() === 'WBTC', out1.ok ? '' : JSON.stringify(out1));
  const out2 = await app.withdraw(mid.net, mid.old.vault, move.takeOutList(mid.old, mid.net.usdt)[0], move.takeOutList(mid.old, mid.net.usdt)[0].amount);
  const sent = out2.ok ? (await pub.getTransaction({ hash: out2.txHash })) : null;
  check('the withdrawals are the vault\'s withdraw(token, amount), sent by the owner to the old vault', out2.ok && sent.input.slice(0, 10) === toFunctionSelector('withdraw(address,uint256)') && sent.to.toLowerCase() === oldVault.toLowerCase() && sent.from.toLowerCase() === mover.toLowerCase());
  check('the old vault ends empty, to the last unit, and the wallet has it all', (await usdt(oldVault)) === 0n && (await wbtc(oldVault)) === 0n && (await usdt(mover)) - w0 === 80_000_000n && (await wbtc(mover)) - b0 === oldBtc);
  const s2 = await get('/api/vault', mover);
  check('GET /api/vault stops reporting the old vault once it is empty', s2.old === undefined && s2.moved === true && s2.vault === newVault);
  check('someone who comes back now is at step 3 (put it into the new vault), read from the chain alone', move.moveStage(s2) === 'putIn' && move.stepOf('putIn') === 3 && Number(s2.walletUsdt) >= 80);

  /* ----- 3) put it into the new vault ----- */
  const in1 = await app.deposit(s2.net, s2.vault, '80');
  const s3 = await get('/api/vault', mover);
  check('step 3: 80 USDT goes into the new vault, and the move is over (nothing left to show)', in1.ok && (await usdt(newVault)) === 80_000_000n && s3.usdtBalance === '80' && move.moveStage(s3) === null, in1.ok ? '' : JSON.stringify(in1));
  check('the whole move took three wallet confirmations here (two withdrawals, one deposit); with USDT alone it is two', stand.signatures === 3, `${stand.signatures} signatures`);

  /* ----- the agent trades from the new vault, inside its session ----- */
  const t1 = await (await post('/api/agent-trade', { asset: 'BTC', side: 'buy', amount: 10, note: 'first buy on the new vault', agent: 'a1' }, mover)).json();
  const t1tx = t1.ok ? await pub.getTransaction({ hash: t1.txHash }) : null;
  check('an agent buy of $10 from the new vault goes through inside the 30-day session', t1.ok && t1tx.to.toLowerCase() === newVault.toLowerCase() && t1tx.input.slice(0, 10) === toFunctionSelector('tradeFor(address,bool,uint256,uint256,string,bytes32,uint16)') && (await usdt(newVault)) === 70_000_000n, t1.ok ? `tx ${t1.txHash}` : t1.reason);
  const pos = await pub.readContract({ address: newVault, abi, functionName: 'position', args: [TOKENS.BTC.address] });
  check('what the agent bought has its cost on the vault\'s books, so the 15% stop-loss covers it', pos[1] === 10_000_000n && pos[3] === 8_500_000n, `cost ${formatUnits(pos[1], 6)}, stop under ${formatUnits(pos[3], 6)}`);
  const big = await (await post('/api/agent-trade', { asset: 'BTC', side: 'buy', amount: 60, note: 'over the starting limit', agent: 'a1' }, mover)).json();
  check('a $60 buy is refused by the new vault\'s $50 limit', !big.ok && /TradeTooLarge/.test(big.reason), big.ok ? 'traded!' : big.reason.slice(0, 90));

  /* ----- the hire sheet's session renewal ----- */
  await test.increaseTime({ seconds: 31 * 86_400 });
  await test.mine({ blocks: 1 });
  const lateTrade = await (await post('/api/agent-trade', { asset: 'BTC', side: 'buy', amount: 5, note: 'after the session', agent: 'a1' }, mover)).json();
  check('31 days later the session has ended: the server sends nothing and says so', !lateTrade.ok && /session on this vault ended/.test(lateTrade.reason), lateTrade.ok ? 'traded!' : lateTrade.reason);
  const s4 = await get('/api/vault', mover);
  // what the hire sheet sends (HireSheet.tsx): Moa's agent key, 90 days, the larger of the buy and the limits, every coin
  const chainNow = Number((await pub.getBlock()).timestamp);
  const until = Math.floor(Date.now() / 1000) + 90 * 86_400;
  const sesMax = Math.max(10, Number(s4.session?.maxTradeUsdt ?? 0), Number(s4.maxTradeUsdt ?? 0));
  const renew = await app.setSession(s4.net, s4.vault, s4.net.agent, until, sesMax, s4.net.tokens.map((x) => x.address));
  const s5 = await get('/api/vault', mover);
  check('the hire sheet\'s renewal (setSession from the owner\'s wallet: 90 days, every coin) is accepted', renew.ok && s5.session.until === until && s5.session.ours && s5.session.assets.length === 3 && s5.session.maxTradeUsdt === '50' && until > chainNow, renew.ok ? `until ${new Date(until * 1000).toISOString().slice(0, 10)}` : JSON.stringify(renew));
  const t2 = await (await post('/api/agent-trade', { asset: 'BTC', side: 'buy', amount: 5, note: 'after the renewal', agent: 'a1' }, mover)).json();
  check('and the agent trades again', t2.ok, t2.ok ? '' : t2.reason);

  /* ----- money that turns up in the old vault later is never invisible ----- */
  await give(POOLS.HSK, USDT, oldVault, 5_000_000n);
  const s6 = await get('/api/vault', mover);
  check('5 USDT sent to the old vault later is reported again, as the small "still in your old vault" line', s6.old?.vault === oldVault && s6.old.usdtBalance === '5' && s6.old.totalUsdt === '5' && move.moveStage(s6) === 'left');
  const out3 = await app.withdraw(s6.net, s6.old.vault, move.takeOutList(s6.old, s6.net.usdt)[0], '5');
  const s7 = await get('/api/vault', mover);
  check('taken out, the old vault is empty and no longer reported', out3.ok && (await usdt(oldVault)) === 0n && s7.old === undefined && move.moveStage(s7) === null);

  /* ----- wallets with no version-2 vault are unaffected ----- */
  const fresh = acc.fresh.address;
  const madeFresh = await (await post('/api/vault/create', {}, fresh)).json();
  const f1 = await get('/api/vault', fresh);
  check('a wallet that logs in for the first time gets a version-3 vault; no move, no old vault', madeFresh.ok && f1.vault === madeFresh.vault && f1.version === 3 && f1.upgrade.available === false && f1.moved === false && f1.old === undefined && move.moveStage(f1) === null);
  const cF = await count(factory), nF = await agentNonce();
  const upFresh = await (await post('/api/vault/upgrade', {}, fresh)).json();
  check('an upgrade call for it changes nothing', upFresh.ok && upFresh.made === false && upFresh.vault === madeFresh.vault && upFresh.paused === 0 && (await count(factory)) === cF && (await agentNonce()) === nF);
  const upNobody = await post('/api/vault/upgrade', {}, acc.nobody.address);
  const upNobodyBody = await upNobody.json();
  check('a wallet with no vault at all is refused (nothing to move) and gets no vault', upNobody.status === 409 && upNobodyBody.why === 'nothing' && (await vaultOf(base, acc.nobody.address)) === undefined && (await count(factory)) === cF);
  const capped = await upgradeVault({ ...base, maxVaultsPerDay: 1 }, acc.late.address);
  check('the daily cap on vaults covers moving too: over it, no vault is made', lateMade.ok && !capped.ok && capped.why === 'failed' && /No more vaults/.test(capped.reason) && (await count(factory)) === cF, capped.ok ? 'made!' : capped.reason);
  check('a wallet that has not moved keeps its old vault as the active one, and is offered the move', (await vaultOf(base, acc.late.address)) === lateMade.vault && (await moveStatus(await forOwner(base, acc.late.address))).upgrade.available === true);

  /* ----- a coin that arrives by plain transfer in a version-3 vault ----- */
  const co = acc.coins.address;
  const coMade = await createVault(base, co);
  if (!coMade.ok) throw new Error(coMade.reason);
  const cv = coMade.vault;
  const coCfg = await forOwner(base, co);
  await give(POOLS.HSK, USDT, cv, 100_000_000n);
  const read = (fn, args = []) => pub.readContract({ address: cv, abi, functionName: fn, args });
  const sentIn = await read('quote', [TOKENS.BTC.address, true, 40_000_000n]);   // about $40 of WBTC
  await give(POOLS.BTC, TOKENS.BTC.address, co, sentIn);
  await mined(await W.coins.sendTransaction({ to: TOKENS.BTC.address, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [cv, sentIn] }) }));
  const p0 = await read('position', [TOKENS.BTC.address]);
  check('books: a coin the owner sends in is held, but has no cost on the vault\'s books and no stop level', p0[0] === sentIn && p0[1] === 0n && p0[2] > 39_000_000n && p0[3] === 0n, `held ${formatUnits(p0[0], 8)} WBTC worth $${formatUnits(p0[2], 6)}, cost ${p0[1]}, stop ${p0[3]}`);
  const stopTry = await pub.simulateContract({ address: cv, abi, functionName: 'stopOut', args: [TOKENS.BTC.address], account: acc.nobody }).then(() => 'went through', (e) => /(NothingToSell|StopNotReached|PriceMoving|NoStopLoss)/.exec(String(e.message))?.[1] ?? String(e.message).slice(0, 80));
  check('stop-loss: it does not cover that coin at all (stopOut answers NothingToSell, at any price)', stopTry === 'NothingToSell', stopTry);
  const view0 = (await vaultStatus(coCfg)).holdings.find((h) => h.symbol === 'WBTC');
  check('the app is told the same: cost 0, no stop level, never due', view0?.costUsdt === '0' && view0.stopUsdt === undefined && view0.stopDue === false, JSON.stringify(view0));
  const half = Number(formatUnits(sentIn / 2n, 8));
  const sold = await executeTrade(coCfg, { asset: 'BTC', side: 'sell', amount: half, note: 'selling a coin that was sent in' });
  check('agent: the agent key can sell it for USDT inside the session (the sell needs no cost on the books)', sold.ok && Number(sold.amountOut) > 19, sold.ok ? `sold ${sold.amountIn} WBTC for $${sold.amountOut}` : sold.reason);
  const more = await executeTrade(coCfg, { asset: 'BTC', side: 'buy', amount: 20, note: 'the agent buys the same coin' });
  const p1b = await read('position', [TOKENS.BTC.address]);
  const fall = 1 - Number(p1b[3]) / Number(p1b[2]);
  check('books: after the agent buys $20 of the same coin, the vault holds about $40 of it at a cost of $20', more.ok && p1b[1] === 20_000_000n && p1b[2] > 38_000_000n, `worth $${formatUnits(p1b[2], 6)}, cost $${formatUnits(p1b[1], 6)}`);
  check('stop-loss: so the 15% stop on the agent\'s own buy now waits for a fall of about half, not 15%', p1b[3] === 17_000_000n && fall > 0.5, `stop under $${formatUnits(p1b[3], 6)} = a ${(fall * 100).toFixed(1)}% fall`);
  check('the owner can always take a sent-in coin out again', (await pub.simulateContract({ address: cv, abi, functionName: 'withdraw', args: [TOKENS.BTC.address, p1b[0]], account: acc.coins }).then(() => true, () => false)));
  serverToday.close();
} catch (e) {
  fail++;
  console.error('ERROR', e);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  server?.close();
  stop();
  process.exit(fail ? 1 : 0);
}
