// The gap history: every RECORD_EVERY_MS the server reads each coin's HSKSwap pool (price and depth), HashKey Global
// and Gate, and keeps the record (src/spread.ts GapPoint). One JSON file in MOA_DATA_DIR, written the same way as
// the other stores (in memory, then a temporary file renamed over the old one). Bounded: KEEP_DAYS per coin, older
// records are dropped. Only what was read is kept: a source that did not answer is left out of that record.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ASSETS, type Asset } from '../src/intent.ts';
import { KEEP_DAYS, RECORD_EVERY_MS, readNow, type GapPoint } from '../src/spread.ts';

export interface SpreadStore {
  /** Records of the last `days` days, oldest first. */
  read(asset: Asset, days: number, now?: number): GapPoint[];
  add(asset: Asset, p: GapPoint, now?: number): void;
}
type Data = Partial<Record<Asset, GapPoint[]>>;

export const spreadsFile = (env: Record<string, string | undefined>) => join(env.MOA_DATA_DIR || './data', 'spread.json');
const DAY = 86_400_000;

export function openSpreads(file?: string): SpreadStore {
  let data: Data = {};
  if (file && existsSync(file)) {
    try { const v = JSON.parse(readFileSync(file, 'utf8')) as unknown; if (v && typeof v === 'object') data = v as Data; } catch { console.error(`[moa] could not read ${file}; starting the gap history empty`); }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  };
  return {
    read: (asset, days, now = Date.now()) => (data[asset] ?? []).filter((p) => p.t >= now - Math.min(KEEP_DAYS, Math.max(0, days)) * DAY),
    add: (asset, p, now = Date.now()) => {
      const keep = (data[asset] ?? []).filter((x) => x.t >= now - KEEP_DAYS * DAY && x.t < p.t);
      data[asset] = [...keep, p];
      save();
    },
  };
}

/** Read and record every coin now, then every `every` ms. Returns a function that stops it. */
export function startRecorder(store: SpreadStore, every = RECORD_EVERY_MS, read = readNow): () => void {
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const a of ASSETS) {
        // A read that hangs (the chain's RPC has no timeout of its own) is given up, so one stuck call never stops the recorder.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const r = await Promise.race([read(a).catch(() => null), new Promise<null>((res) => { timer = setTimeout(() => res(null), 45_000); })]);
        clearTimeout(timer);
        if (r && (r.point.hk !== undefined || r.point.gate !== undefined)) store.add(a, r.point);
      }
    } finally { busy = false; }
  };
  const first = setTimeout(pass, 5_000);
  const timer = setInterval(pass, Math.max(60_000, every));
  return () => { clearTimeout(first); clearInterval(timer); };
}
