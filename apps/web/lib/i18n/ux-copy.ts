/**
 * Reads docs/UX_COPY.md (the only source of UI strings, CLAUDE.md rule 8) into KR/EN dictionaries:
 * §3 and §7 bullets (`key`: KR / EN, several per line joined by " · "), the §4 reason table, the
 * §5 risk disclosure, and the §6 banned words. Anything it cannot read exactly is an error, so a
 * change to the document either regenerates cleanly or fails loudly.
 */

export interface UxCopy {
  ko: Record<string, string>;
  en: Record<string, string>;
  banned: string[];
}

function sections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const number = /^(\d+)\./.exec(part)?.[1];
    if (number) out.set(number, part);
  }
  return out;
}

function put(copy: UxCopy, key: string, ko: string, en: string) {
  if (key in copy.ko) throw new Error(`UX_COPY: duplicate key ${key}`);
  if (!ko.trim() || !en.trim()) throw new Error(`UX_COPY: ${key} is missing KR or EN`);
  copy.ko[key] = ko.trim();
  copy.en[key] = en.trim();
}

/** `- \`key\`: KR / EN · \`key2\`: KR / EN` — and `key.{a|b}`: KR1 / KR2 — EN1 / EN2. */
function bullets(copy: UxCopy, text: string) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('- `')) continue;
    const keys = [...line.matchAll(/`([^`]+)`:\s*/g)];
    keys.forEach((match, i) => {
      const key = match[1] ?? '';
      const start = (match.index ?? 0) + match[0].length;
      const end = keys[i + 1]?.index ?? line.length;
      const value = line.slice(start, end).replace(/\s*·\s*$/, '');
      const variants = /^(.*)\{([a-z_|]+)\}$/.exec(key);
      if (variants && variants[2]?.includes('|')) {
        const names = variants[2].split('|');
        const [ko = '', en = ''] = value.split(' — ');
        const kos = ko.split(' / ');
        const ens = en.split(' / ');
        if (kos.length !== names.length || ens.length !== names.length) {
          throw new Error(`UX_COPY: ${key} needs ${names.length} KR and EN variants`);
        }
        names.forEach((name, n) => put(copy, `${variants[1]}${name}`, kos[n] ?? '', ens[n] ?? ''));
        return;
      }
      const halves = value.split(' / ');
      if (halves.length !== 2) throw new Error(`UX_COPY: ${key} must read "KR / EN": ${value}`);
      put(copy, key, halves[0] ?? '', halves[1] ?? '');
    });
  }
}

function reasons(copy: UxCopy, text: string) {
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const key = /^`(why\.[^`]+)`$/.exec(cells[1] ?? '')?.[1];
    if (key) put(copy, key, cells[2] ?? '', cells[3] ?? '');
  }
}

function risk(copy: UxCopy, text: string) {
  const block = (label: string) => {
    const from = text.indexOf(`**${label}**`);
    if (from < 0) throw new Error(`UX_COPY §5: no **${label}** block`);
    const lines: string[] = [];
    for (const line of text.slice(from).split('\n').slice(1)) {
      if (line.startsWith('> ')) lines.push(line.slice(2).trim());
      else if (lines.length > 0) break;
    }
    return lines;
  };
  const parse = (lines: string[]) => {
    const out: Record<string, string> = {};
    lines.forEach((line, i) => {
      const item = /^(\d)\.\s+(.*)$/.exec(line);
      const cta = /^(.*)\s+\[([^\]]+)\]$/.exec(line);
      if (item) out[`risk.${item[1]}`] = item[2] ?? '';
      else if (cta) {
        out['risk.agree'] = cta[1] ?? '';
        out['risk.cta'] = cta[2] ?? '';
      } else if (i === 0) out['risk.intro'] = line;
      else throw new Error(`UX_COPY §5: unexpected line ${line}`);
    });
    return out;
  };
  const ko = parse(block('KR'));
  const en = parse(block('EN'));
  const keys = Object.keys(ko);
  if (keys.join() !== Object.keys(en).join()) throw new Error('UX_COPY §5: KR and EN differ');
  for (const key of keys) put(copy, key, ko[key] ?? '', en[key] ?? '');
}

function banned(text: string): string[] {
  const line = text
    .split('\n')
    .slice(1)
    .find((l) => l.trim() !== '');
  if (!line) throw new Error('UX_COPY §6: no banned words');
  return line
    .split(' · ')
    .map((word) => word.replace(/\s*\(.*$/, '').trim())
    .filter(Boolean);
}

export function parseUxCopy(markdown: string): UxCopy {
  const parts = sections(markdown);
  const need = (n: string) => {
    const part = parts.get(n);
    if (part === undefined) throw new Error(`UX_COPY: no section ${n}`);
    return part;
  };
  const copy: UxCopy = { ko: {}, en: {}, banned: [] };
  bullets(copy, need('3'));
  reasons(copy, need('4'));
  risk(copy, need('5'));
  copy.banned = banned(need('6'));
  if (parts.has('7')) bullets(copy, need('7'));
  return copy;
}

/** Placeholder names in a string: `{ticker}` and `${usd}` both name `ticker` / `usd`. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1] ?? '').sort();
}
