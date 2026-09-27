/**
 * Reads docs/UX_COPY.md (the only source of UI strings, CLAUDE.md rule 8) into the English
 * dictionary (DECISIONS D-26, D-27): §3 and §7 bullets (`key`: text, several per line joined by
 * " · "), the §4 reason table, the §5 risk disclosure, and the §6 banned words. Anything it cannot
 * read exactly is an error, so a change to the document either regenerates cleanly or fails loudly.
 */

export interface UxCopy {
  en: Record<string, string>;
  banned: string[];
}

const HANGUL = /\p{Script=Hangul}/u;

function sections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const number = /^(\d+)\./.exec(part)?.[1];
    if (number) out.set(number, part);
  }
  return out;
}

function put(copy: UxCopy, key: string, text: string) {
  if (key in copy.en) throw new Error(`UX_COPY: duplicate key ${key}`);
  if (!text.trim()) throw new Error(`UX_COPY: ${key} has no text`);
  if (HANGUL.test(text)) throw new Error(`UX_COPY: ${key} is not English (D-26)`);
  copy.en[key] = text.trim();
}

/** `- \`key\`: text · \`key2\`: text` — and `key.{a|b}`: text A / text B. */
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
        const texts = value.split(' / ');
        if (texts.length !== names.length) {
          throw new Error(`UX_COPY: ${key} needs ${names.length} variants`);
        }
        names.forEach((name, n) => put(copy, `${variants[1]}${name}`, texts[n] ?? ''));
        return;
      }
      put(copy, key, value);
    });
  }
}

function reasons(copy: UxCopy, text: string) {
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const key = /^`(why\.[^`]+)`$/.exec(cells[1] ?? '')?.[1];
    if (key) put(copy, key, cells[2] ?? '');
  }
}

/** The §5 quote: an intro line, the numbered risks, then the agreement with its [button]. */
function risk(copy: UxCopy, text: string) {
  const lines = text
    .split('\n')
    .filter((line) => line.startsWith('> '))
    .map((line) => line.slice(2).trim());
  if (lines.length === 0) throw new Error('UX_COPY §5: no risk disclosure');
  lines.forEach((line, i) => {
    const item = /^(\d)\.\s+(.*)$/.exec(line);
    const cta = /^(.*)\s+\[([^\]]+)\]$/.exec(line);
    if (item) put(copy, `risk.${item[1]}`, item[2] ?? '');
    else if (cta) {
      put(copy, 'risk.agree', cta[1] ?? '');
      put(copy, 'risk.cta', cta[2] ?? '');
    } else if (i === 0) put(copy, 'risk.intro', line);
    else throw new Error(`UX_COPY §5: unexpected line ${line}`);
  });
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
  const copy: UxCopy = { en: {}, banned: [] };
  bullets(copy, need('3'));
  reasons(copy, need('4'));
  risk(copy, need('5'));
  copy.banned = banned(need('6'));
  if (parts.has('7')) bullets(copy, need('7'));
  return copy;
}
