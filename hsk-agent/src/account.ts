// The account: a wallet that logged in. Logging in is one free signature (no transaction); the server answers with
// a token that goes on every vault request, so a vault only ever acts for its own owner.
// Deposits and withdrawals are sent by the user's own wallet from here; the server never moves funds in or out.
import { useSyncExternalStore } from 'react';
import { encodeFunctionData, parseUnits, stringToHex } from 'viem';

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

/* ---------- which wallet ---------- */
// A browser can hold several wallets (MetaMask, OKX, Binance…), and they fight over `window.ethereum`: whichever
// loaded last wins. So wallets are found the standard way instead (EIP-6963: each one announces itself with a name
// and an icon), the user picks one when there are several, and the pick is remembered for deposits and withdrawals.
export interface WalletChoice { id: string; name: string; icon?: string }
interface Announced { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 }
const announced: Announced[] = [];
const WALLET_KEY = 'moa.wallet.v1';
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = (e as CustomEvent<Announced>).detail;
    if (d?.info?.rdns && d.provider && !announced.some((a) => a.info.rdns === d.info.rdns)) announced.push(d);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
/** The wallet that took `window.ethereum`, for browsers whose wallets do not announce themselves. */
const legacy = (): Eip1193 | null => (typeof window !== 'undefined' && (window as unknown as { ethereum?: Eip1193 }).ethereum) || null;
const LEGACY_ID = 'injected';

/** The wallets found in this browser. Empty means none is installed. */
export function wallets(): WalletChoice[] {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('eip6963:requestProvider'));   // late-loading wallets answer too
  if (announced.length) return announced.map((a) => ({ id: a.info.rdns, name: a.info.name, icon: a.info.icon }));
  return legacy() ? [{ id: LEGACY_ID, name: 'Browser wallet' }] : [];
}
const providerOf = (id: string | null | undefined): Eip1193 | null => announced.find((a) => a.info.rdns === id)?.provider ?? (id === LEGACY_ID || !announced.length ? legacy() : null);
const remembered = () => { try { return localStorage.getItem(WALLET_KEY); } catch { return null; } };
/** The wallet this session logged in with: the one that signs its deposits and withdrawals. */
export const walletProvider = (): Eip1193 | null => providerOf(remembered()) ?? (announced.length === 1 ? announced[0].provider : null) ?? legacy();

export interface Session { address: string; token: string; expiresAt: number }
export interface Net { chainId: number; explorer: string; usdt: string; tokens: { symbol: string; address: string; decimals: number }[] }

const KEY = 'moa.session.v1';
const listeners = new Set<() => void>();
let current: Session | null = load();
const watched = new WeakSet<object>();

function load(): Session | null {
  try {
    const v = typeof localStorage === 'undefined' ? null : (JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null);
    return v && typeof v.address === 'string' && typeof v.token === 'string' && v.expiresAt > Date.now() ? v : null;
  } catch { return null; }
}
function set(next: Session | null) {
  current = next;
  try { if (next) localStorage.setItem(KEY, JSON.stringify(next)); else localStorage.removeItem(KEY); } catch { /* this visit only */ }
  listeners.forEach((f) => f());
}

export const session = () => current;
/** Whose data this browser is showing: the logged-in wallet, or "guest". */
export const owner = () => current?.address.toLowerCase() ?? 'guest';
/** Called when someone logs in or out, so the stores kept per owner can switch. */
export function onOwnerChange(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }
export const useSession = () => useSyncExternalStore(onOwnerChange, session, () => null);
export const authHeaders = (): Record<string, string> => (current ? { authorization: `Bearer ${current.token}` } : {});
export const logOut = () => set(null);

const code = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? Number((e as { code: unknown }).code) : 0);
const text = (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) });

export type LoginResult = { ok: true } | { ok: false; why: 'nowallet' | 'choose' | 'rejected' | 'failed'; detail?: string };
/** Connect the chosen wallet, sign the server's message, keep the session. With several wallets and no choice: 'choose'. */
export async function logIn(walletId?: string): Promise<LoginResult> {
  const found = wallets();
  if (!found.length) return { ok: false, why: 'nowallet' };
  if (!walletId && found.length > 1) return { ok: false, why: 'choose' };
  const id = walletId ?? found[0].id;
  const p = providerOf(id);
  if (!p) return { ok: false, why: 'nowallet' };
  try {
    const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
    const address = accounts?.[0];
    if (!address) return { ok: false, why: 'rejected' };
    const c = await post('/api/login/challenge', { address });
    if (!c.ok) return { ok: false, why: 'failed', detail: `HTTP ${c.status}` };
    const { message, issuedAt } = (await c.json()) as { message: string; issuedAt: number };
    const signature = (await p.request({ method: 'personal_sign', params: [stringToHex(message), address] })) as string;
    const r = await post('/api/login', { address, issuedAt, signature });
    const j = (await r.json().catch(() => null)) as { token?: string; address?: string; expiresAt?: number; error?: string } | null;
    if (!r.ok || !j?.token || !j.address || !j.expiresAt) return { ok: false, why: 'failed', detail: j?.error ?? `HTTP ${r.status}` };
    try { localStorage.setItem(WALLET_KEY, id); } catch { /* this visit only */ }
    set({ address: j.address, token: j.token, expiresAt: j.expiresAt });
    if (!watched.has(p) && p.on) {
      watched.add(p);
      // Switching to another account in the wallet ends this session: the vault on screen belongs to the first one.
      p.on('accountsChanged', (list) => { const now = (list as string[] | undefined)?.[0]; if (current && walletProvider() === p && now?.toLowerCase() !== current.address.toLowerCase()) logOut(); });
    }
    return { ok: true };
  } catch (e) {
    return code(e) === 4001 ? { ok: false, why: 'rejected' } : { ok: false, why: 'failed', detail: text(e) };
  }
}

/* ---------- nickname ---------- */

const NAMES = {
  en: [['Calm', 'Bright', 'Steady', 'Quiet', 'Brave', 'Clever', 'Swift', 'Lucky'], ['Otter', 'Heron', 'Fox', 'Whale', 'Magpie', 'Tiger', 'Crane', 'Deer']],
  ko: [['차분한', '반짝이는', '꾸준한', '조용한', '용감한', '영리한', '날쌘', '운 좋은'], ['수달', '왜가리', '여우', '고래', '까치', '호랑이', '두루미', '사슴']],
} as const;
const nickKey = (address: string) => `moa.nick.v1.${address.toLowerCase()}`;
/** The name someone gave themselves, or a friendly one that always comes out the same for the same wallet. */
export function nickOf(address: string, lang: 'en' | 'ko'): string {
  try { const v = localStorage.getItem(nickKey(address)); if (v) return v; } catch { /* fall through */ }
  const n = parseInt(address.slice(2, 10), 16) || 0;
  const [a, b] = NAMES[lang];
  return `${a[n % a.length]} ${b[Math.floor(n / 256) % b.length]}`;
}
export function saveNick(address: string, name: string) {
  const v = name.trim().slice(0, 20);
  try { if (v) localStorage.setItem(nickKey(address), v); else localStorage.removeItem(nickKey(address)); } catch { /* this visit only */ }
  listeners.forEach((f) => f());
}
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/* ---------- sending from the user's own wallet ---------- */

const HSK_MAINNET = { chainId: '0xb1', chainName: 'HSK Chain', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: ['https://mainnet.hsk.xyz'], blockExplorerUrls: ['https://hsk.blockscout.com'] };
async function onChain(p: Eip1193, net: Net) {
  const want = `0x${net.chainId.toString(16)}`;
  if (String(await p.request({ method: 'eth_chainId' })).toLowerCase() === want) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
  } catch (e) {
    if (code(e) !== 4902 || net.chainId !== 177) throw e;   // 4902: the wallet does not know this chain yet
    await p.request({ method: 'wallet_addEthereumChain', params: [HSK_MAINNET] });
  }
}

export type SendResult = { ok: true; txHash: string } | { ok: false; why: 'nowallet' | 'rejected' | 'failed' | 'reverted' | 'slow'; detail?: string; txHash?: string };
/** One transaction from the logged-in wallet, waited for until it is in a block. */
async function send(net: Net, to: string, data: string): Promise<SendResult> {
  const p = walletProvider();
  if (!p || !current) return { ok: false, why: 'nowallet' };
  try {
    // The wallet must still be on the account that logged in: the vault belongs to that one.
    const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
    if (accounts?.[0]?.toLowerCase() !== current.address.toLowerCase()) return { ok: false, why: 'failed', detail: `the wallet is on another account (${accounts?.[0] ? shortAddress(accounts[0]) : 'none'}); switch back to ${shortAddress(current.address)}` };
    await onChain(p, net);
    const txHash = (await p.request({ method: 'eth_sendTransaction', params: [{ from: current.address, to, data }] })) as string;
    for (let i = 0; i < 90; i++) {
      await new Promise((done) => setTimeout(done, 2000));
      const r = (await p.request({ method: 'eth_getTransactionReceipt', params: [txHash] }).catch(() => null)) as { status?: string } | null;
      if (r) return r.status === '0x1' ? { ok: true, txHash } : { ok: false, why: 'reverted', txHash };
    }
    return { ok: false, why: 'slow', txHash };
  } catch (e) {
    return code(e) === 4001 ? { ok: false, why: 'rejected' } : { ok: false, why: 'failed', detail: text(e) };
  }
}

const TRANSFER = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const WITHDRAW = [{ type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }] as const;
type Hex = `0x${string}`;

/** USDT from my wallet into my vault. */
export const deposit = (net: Net, vault: string, usdt: string) =>
  send(net, net.usdt, encodeFunctionData({ abi: TRANSFER, functionName: 'transfer', args: [vault as Hex, parseUnits(usdt, 6)] }));
/** A token from my vault back to my wallet. Only the owner's wallet can do this; the contract refuses anyone else. */
export const withdraw = (net: Net, vault: string, token: { address: string; decimals: number }, amount: string) =>
  send(net, vault, encodeFunctionData({ abi: WITHDRAW, functionName: 'withdraw', args: [token.address as Hex, parseUnits(amount, token.decimals)] }));
