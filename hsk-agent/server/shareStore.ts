// Shared agents, kept on the server so anyone can find and hire them. One JSON file in MOA_DATA_DIR, written the
// same way as the auto agents (server/autoStore.ts): in memory, then to a temporary file renamed over the old one.
// The creator is always the wallet of the session that published, never something the request says.
// Hires are counted here, one per hiring wallet, the creator's own not included; the count is never set by hand.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_EVER_PER_WALLET, MAX_LIVE_PER_WALLET, MAX_NICK, cleanSpec, plainText, validFee, type SharedAgent } from '../src/share.ts';

interface Row { id: string; sourceId: string; spec: SharedAgent['spec']; creator: string; nick?: string; feeBps: number; createdAt: number; removedAt?: number; hirers: string[] }
interface Data { agents: Row[] }

export type Publish =
  | { ok: true; agent: SharedAgent; again?: boolean }
  | { ok: false; why: 'invalid' | 'fee' | 'tooMany' | 'tooManyEver' };

export interface ShareStore {
  /** What is shared now, newest first. */
  list(): SharedAgent[];
  /** One shared agent, also after its creator stopped sharing it (then with removedAt). */
  get(id: string): SharedAgent | undefined;
  /** Everything this wallet has shared, stopped ones too. */
  mine(creator: string): SharedAgent[];
  publish(creator: string, body: { spec?: unknown; feeBps?: unknown; nick?: unknown }, now?: number): Publish;
  unpublish(creator: string, id: string, now?: number): SharedAgent | undefined;
  /** Count a hire by this wallet. Returns the agent with its count, or undefined when there is no such agent. */
  hire(id: string, by: string): SharedAgent | undefined;
}

const low = (a: string) => a.toLowerCase();
const out = (r: Row): SharedAgent => ({ id: r.id, spec: r.spec, creator: r.creator, ...(r.nick ? { nick: r.nick } : {}), feeBps: r.feeBps, createdAt: r.createdAt, ...(r.removedAt ? { removedAt: r.removedAt } : {}), hires: r.hirers.length });
const newId = () => randomBytes(6).toString('hex').replace(/[^a-z0-9]/g, '').slice(0, 10);

/** @param markets the markets a shared agent may read (those the vaults can trade) */
export function openShares(file: string | undefined, markets: readonly string[]): ShareStore {
  let data: Data = { agents: [] };
  if (file && existsSync(file)) {
    try { const v = JSON.parse(readFileSync(file, 'utf8')) as Data; if (v && Array.isArray(v.agents)) data = v; } catch { console.error(`[moa] could not read ${file}; starting with no shared agents`); }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  };
  const find = (id: string) => data.agents.find((r) => r.id === id);
  return {
    list: () => data.agents.filter((r) => !r.removedAt).sort((a, b) => b.createdAt - a.createdAt).map(out),
    get: (id) => { const r = find(id); return r && out(r); },
    mine: (creator) => data.agents.filter((r) => low(r.creator) === low(creator)).sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ ...out(r), sourceId: r.sourceId })),
    publish(creator, body, now = Date.now()) {
      if (!validFee(body.feeBps)) return { ok: false, why: 'fee' };
      const sourceId = plainText((body.spec as { id?: unknown } | null)?.id, 40);
      const own = data.agents.filter((r) => low(r.creator) === low(creator));
      // Sharing the same agent twice gives the same link back.
      const again = sourceId ? own.find((r) => r.sourceId === sourceId && !r.removedAt) : undefined;
      if (again) return { ok: true, agent: out(again), again: true };
      if (own.filter((r) => !r.removedAt).length >= MAX_LIVE_PER_WALLET) return { ok: false, why: 'tooMany' };
      if (own.length >= MAX_EVER_PER_WALLET) return { ok: false, why: 'tooManyEver' };
      let id = newId();
      while (find(id)) id = newId();
      const spec = cleanSpec(body.spec, markets, id, now);
      if (!spec) return { ok: false, why: 'invalid' };
      const nick = plainText(body.nick, MAX_NICK);
      const row: Row = { id, sourceId, spec, creator, ...(nick ? { nick } : {}), feeBps: body.feeBps, createdAt: now, hirers: [] };
      data.agents.push(row);
      save();
      return { ok: true, agent: out(row) };
    },
    unpublish(creator, id, now = Date.now()) {
      const r = find(id);
      if (!r || low(r.creator) !== low(creator)) return undefined;
      if (!r.removedAt) { r.removedAt = now; save(); }
      return out(r);
    },
    hire(id, by) {
      const r = find(id);
      if (!r) return undefined;
      // A stopped agent takes no new hires; the creator hiring their own agent is not a hire by someone else.
      if (!r.removedAt && low(by) !== low(r.creator) && !r.hirers.includes(low(by))) { r.hirers.push(low(by)); save(); }
      return out(r);
    },
  };
}

export const sharesFile = (env: Record<string, string | undefined>) => join(env.MOA_DATA_DIR || './data', 'shared.json');
