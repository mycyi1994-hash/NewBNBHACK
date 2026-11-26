// Shared by the mainnet scripts: the HSK Chain addresses Moa uses, read-only checks that they belong together,
// and small helpers. Nothing here sends a transaction.
import { readFileSync, existsSync } from 'node:fs';
import { createPublicClient, http, parseAbi, formatUnits, parseUnits } from 'viem';

export const RPC = process.env.MOA_RPC_URL || 'https://mainnet.hsk.xyz';
export const EXPLORER = 'https://hsk.blockscout.com';
/** Set MOA_ALLOW_FORK=1 only when MOA_RPC_URL points at a local fork: records then go to a separate, ignored file. */
export const FORK = Boolean(process.env.MOA_ALLOW_FORK);
export const WHERE = FORK ? 'a LOCAL FORK' : 'HSK Chain mainnet';
export const RECORD = new URL(FORK ? '../deployments/local-fork.json' : '../deployments/hsk-mainnet.json', import.meta.url);
export const CHAIN = { id: 177, name: 'HSK Chain', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
/** HSKSwap's router and the USDT every vault holds. */
export const ROUTER = '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3';
export const USDT = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029';
/** token → its HSKSwap pool against USDT (0.3% fee). */
export const MARKETS = {
  WHSK: { token: '0xB210D2120d57b758EE163cFfb43e73728c471Cf1', pool: '0x4ff515761864e7838b0adb8b5b2b8b7a068905dc', decimals: 18 },
  WETH: { token: '0xefd4bC9afD210517803f293ABABd701CaeeCdfd0', pool: '0xb92b79ed6b370d5cfee2e14b1d0983c258304c16', decimals: 18 },
  WBTC: { token: '0x6119ca49a79f5825c8b345f8d7ac36b272565b14', pool: '0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a', decimals: 8 },
};
export const ERC20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const POOL = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)', 'function factory() view returns (address)', 'function liquidity() view returns (uint128)']);
const ROUTER_ABI = parseAbi(['function factory() view returns (address)']);

/** abi + bytecode of a compiled contract: 'MoaVault' or 'MoaVaultFactory'. */
export const artifact = (name) => JSON.parse(readFileSync(new URL(`../out/${name}.json`, import.meta.url)));
export const client = () => createPublicClient({ chain: CHAIN, transport: http(RPC) });
export const usd = (v) => formatUnits(v, 6);
/** The contract has no "off" for a limit, so "no limit" is the largest number it can hold. */
export const NO_LIMIT = 2n ** 256n - 1n;
/** A limit in words: "$10", or "no limit". */
export const cap = (v) => (v >= 2n ** 200n ? 'no limit' : `$${usd(v)}`);
/** "none" (or nothing) → no limit; otherwise a USDT amount. Returns 0n for text that is neither. */
export const limitOf = (text) => {
  if (text === undefined || /^(none|no|unlimited)$/i.test(text)) return NO_LIMIT;
  return /^\d+(\.\d{1,6})?$/.test(text) ? parseUnits(text, 6) : 0n;
};
export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
export const fail = (msg) => { console.error(`\nCannot continue: ${msg}`); process.exit(1); };
/** What deploy-mainnet.mjs wrote, or null before the first deployment. */
export const record = () => (existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : null);

/**
 * Before any money is involved: is this really HSK Chain, is the USDT a 6-decimal token called USDT, and does
 * every pool hold exactly its token and USDT, have liquidity, and come from the same factory as the router?
 * Returns the problems found (empty when all is well).
 */
export async function checkAddresses(pub) {
  const bad = [];
  const id = await pub.getChainId();
  if (id !== 177 && !FORK) bad.push(`chain id is ${id}, expected 177`);
  const [sym, dec, factory] = await Promise.all([
    pub.readContract({ address: USDT, abi: ERC20, functionName: 'symbol' }),
    pub.readContract({ address: USDT, abi: ERC20, functionName: 'decimals' }),
    pub.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'factory' }),
  ]);
  if (sym !== 'USDT' || dec !== 6) bad.push(`USDT at ${USDT} reads ${sym} with ${dec} decimals`);
  for (const [name, m] of Object.entries(MARKETS)) {
    const [t0, t1, fee, fac, liq, tokenDec] = await Promise.all([
      ...['token0', 'token1', 'fee', 'factory', 'liquidity'].map((functionName) => pub.readContract({ address: m.pool, abi: POOL, functionName })),
      pub.readContract({ address: m.token, abi: ERC20, functionName: 'decimals' }),
    ]);
    const pair = [t0, t1];
    if (!(pair.some((x) => same(x, m.token)) && pair.some((x) => same(x, USDT)))) bad.push(`${name} pool does not hold ${name} and USDT`);
    if (!same(fac, factory)) bad.push(`${name} pool is not from the router's factory`);
    if (liq === 0n) bad.push(`${name} pool has no liquidity`);
    if (fee !== 3000) bad.push(`${name} pool fee is ${fee}, expected 3000`);
    if (tokenDec !== m.decimals) bad.push(`${name} has ${tokenDec} decimals, expected ${m.decimals}`);
  }
  return bad;
}

/** `--name value` from the command line, else the environment variable, else undefined. */
export const option = (name, envName) => {
  const i = process.argv.indexOf(`--${name}`);
  return (i > 0 ? process.argv[i + 1] : undefined) || (envName ? process.env[envName] : undefined) || undefined;
};

/** Read one line from the terminal without showing what is typed or pasted. */
function hidden(question) {
  const input = process.stdin;
  process.stdout.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve) => {
    let text = '';
    const stop = () => { input.setRawMode(false); input.pause(); input.off('data', onData); process.stdout.write('\n'); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { stop(); return resolve(text); }
        if (ch === '\u0003') { stop(); console.log('Stopped. Nothing was sent.'); process.exit(0); }   // Ctrl+C
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ') text += ch;
      }
    };
    input.on('data', onData);
  });
}

/**
 * A wallet's key for sending: MOA_OWNER_PRIVATE_KEY if set, otherwise asked for here with the typing hidden, so it
 * never lands in a file, in the shell history or on the screen. Accepts a key with or without the leading 0x.
 * Returns null when there is no usable key.
 */
export async function ownerKey(whose = 'your wallet') {
  let key = process.env.MOA_OWNER_PRIVATE_KEY;
  if (!key) {
    if (!process.stdin.isTTY) return null;
    console.log(`\nThis step sends from ${whose}, so it needs that wallet's private key.`);
    console.log('Paste it below and press Enter. Nothing appears while you paste: that is intended. Ctrl+C stops.');
    key = await hidden('Private key: ');
  }
  key = key.trim();
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null;
}

/** Type the word to go on. Anything else stops. */
export async function confirm(word, question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question}\nType "${word}" to continue: `)).trim();
  rl.close();
  if (answer !== word) { console.log('Stopped. Nothing was sent.'); process.exit(0); }
}
