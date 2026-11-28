// Moa AI's decisions (src/aiPilot.ts), kept in one JSON file in MOA_DATA_DIR and written like the other stores
// (a temporary file, then renamed). Bounded: the last KEEP decisions per coin, about a year and a half at one every
// four hours. Nothing in it is secret; the API serves it read-only.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Asset } from '../src/intent.ts';
import { AI_EVERY_MS, COINS, paperTrack, type AiDecision, type AiFeed, type AiState } from '../src/aiPilot.ts';

export const KEEP = 3000;
export const aiFile = (env: Record<string, string | undefined>) => join(env.MOA_DATA_DIR || './data', 'ai-decisions.json');

export interface AiStore {
  list(asset: Asset): AiDecision[];
  add(d: AiDecision): void;
  /** One coin's feed for the API and the agent: the last `n` decisions, newest last, and the paper result over all. */
  feed(asset: Asset, state: AiState, model: string | null, n?: number): AiFeed;
}

export function openAiStore(file?: string): AiStore {
  let data: Partial<Record<Asset, AiDecision[]>> = {};
  if (file && existsSync(file)) {
    try { const v = JSON.parse(readFileSync(file, 'utf8')) as typeof data; if (v && typeof v === 'object') data = v; } catch { console.error(`[moa] could not read ${file}; Moa AI starts a new record`); }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  };
  const list = (asset: Asset) => (COINS.includes(asset) && Array.isArray(data[asset]) ? data[asset]! : []);
  return {
    list,
    add: (d) => { data[d.asset] = [...list(d.asset), d].slice(-KEEP); save(); },
    feed: (asset, state, model, n = 30) => {
      const all = list(asset);
      return { asset, state, every: AI_EVERY_MS, model, decisions: all.slice(-Math.max(1, Math.min(200, n))), paper: paperTrack(all), count: all.length };
    },
  };
}
