// The agents that work on their own, kept on the server so they keep working with the app closed.
// One JSON file: each owner (a wallet address) and the agents that owner put on "auto". The owner's browser keeps
// a copy for display; this file is the one that counts. Nothing secret is stored here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HiredAgent } from '../src/runner.ts';

export interface AutoStore {
  /** Every owner this server has seen log in, so stop-losses are watched even for vaults with no auto agent. */
  owners(): string[];
  seen(owner: string): void;
  list(owner: string): HiredAgent[];
  put(owner: string, agent: HiredAgent): void;
  remove(owner: string, id: string): HiredAgent | undefined;
}

type Data = Record<string, HiredAgent[]>;
const key = (owner: string) => owner.toLowerCase();

/** A store in memory, written to `file` after every change when a file is given. */
export function openStore(file?: string): AutoStore {
  let data: Data = {};
  if (file && existsSync(file)) {
    try { const v = JSON.parse(readFileSync(file, 'utf8')) as unknown; if (v && typeof v === 'object') data = v as Data; } catch { console.error(`[moa] could not read ${file}; starting with no auto agents`); }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);   // a crash mid-write leaves the old file, never half of a new one
  };
  return {
    owners: () => Object.keys(data),
    seen(owner) { if (!data[key(owner)]) { data[key(owner)] = []; save(); } },
    list: (owner) => data[key(owner)] ?? [],
    put(owner, agent) { const k = key(owner); data[k] = [agent, ...(data[k] ?? []).filter((a) => a.id !== agent.id)]; save(); },
    remove(owner, id) { const k = key(owner); const had = (data[k] ?? []).find((a) => a.id === id); if (had) { data[k] = data[k].filter((a) => a.id !== id); save(); } return had; },
  };
}

export const storeFile = (env: Record<string, string | undefined>) => join(env.MOA_DATA_DIR || './data', 'auto.json');
