/**
 * Test helper: `key → placeholders` from the UX_COPY §4 "why" table and the §7 draft why lines, so
 * tests can hold the engine to the copy (no invented keys, no unknown or missing params).
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
    if (key) table.set(key, placeholders(cells[2] ?? ''));
  }
  // §7 holds agent drafts pending human review (DECISIONS D-20), one per line: `key`: text.
  const drafts = text.slice(text.indexOf('## 7.'));
  for (const line of drafts.split('\n')) {
    const match = /^- `(why\.[a-z_.]+)`: (.*)$/.exec(line);
    if (match) table.set(match[1] ?? '', placeholders(match[2] ?? ''));
  }
  return table;
}
