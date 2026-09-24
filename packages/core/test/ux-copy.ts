/**
 * Test helper: `key → placeholders` from the UX_COPY §4 "why" table, so tests can hold the engine
 * to the copy (no invented keys, no unknown or missing params). KR and EN must agree.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function uxCopyWhyTable(): Map<string, Set<string>> {
  const path = fileURLToPath(new URL('../../../docs/UX_COPY.md', import.meta.url));
  const text = readFileSync(path, 'utf8');
  const section = text.slice(text.indexOf('## 4.'), text.indexOf('## 5.'));
  const placeholders = (cell: string) =>
    new Set([...cell.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ''));
  const table = new Map<string, Set<string>>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const key = /^`(why\.[a-z_.]+)`$/.exec(cells[1] ?? '')?.[1];
    if (!key) continue;
    const kr = placeholders(cells[2] ?? '');
    const en = placeholders(cells[3] ?? '');
    if ([...kr].sort().join() !== [...en].sort().join()) {
      const list = (set: Set<string>) => [...set].join(', ');
      throw new Error(`UX_COPY ${key}: KR {${list(kr)}} and EN {${list(en)}} placeholders differ`);
    }
    table.set(key, kr);
  }
  return table;
}
