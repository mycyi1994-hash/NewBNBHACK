// Finds CSS selectors in src/styles.css that can never match, because a class they need is not used anywhere in
// src/ or index.html. A class counts as used when its name appears as a word in the source, or when it is built from
// a prefix in a template (`st-${status}`, 'r-' + rule). Classes inside :not(), :is() and :where() are not counted.
//   node scripts/css-unused.mjs          list unused selectors; exit 1 if there are any
//   node scripts/css-unused.mjs --fix    remove them (a rule whose selectors are all unused goes; empty @media too)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const cssPath = join(root, 'src/styles.css');
const css = readFileSync(cssPath, 'utf8');
const files = readdirSync(join(root, 'src')).filter((f) => /\.(tsx?|html)$/.test(f) && !f.endsWith('.test.ts'));
const src = [...files.map((f) => readFileSync(join(root, 'src', f), 'utf8')), readFileSync(join(root, 'index.html'), 'utf8')].join('\n');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cache = new Map();
export function classUsed(c) {
  if (cache.has(c)) return cache.get(c);
  let ok = new RegExp(`(^|[^\\w-])${esc(c)}($|[^\\w-])`).test(src);
  // built in code from a prefix: `st-${x}`, 'r-' + x, "g-" + x
  for (let i = c.indexOf('-'); !ok && i > 0; i = c.indexOf('-', i + 1)) {
    const p = c.slice(0, i + 1);
    ok = src.includes(`${p}\${`) || src.includes(`'${p}' +`) || src.includes(`"${p}" +`) || src.includes(`\`${p}\``);
  }
  cache.set(c, ok);
  return ok;
}

/** The classes a selector needs: those outside :not(), :is() and :where(). */
function needed(sel) {
  let s = sel, prev;
  do { prev = s; s = s.replace(/:(not|is|where)\((?:[^()]|\([^()]*\))*\)/g, ''); } while (s !== prev);
  return [...s.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}
const dead = (sel) => needed(sel).some((c) => !classUsed(c));

function splitTop(prelude) {
  const out = []; let d = 0, start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (ch === '(' || ch === '[') d++; else if (ch === ')' || ch === ']') d--;
    else if (ch === ',' && d === 0) { out.push(prelude.slice(start, i)); start = i + 1; }
  }
  out.push(prelude.slice(start));
  return out;
}

const removed = [];
function walk(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const ws = /^(\s+|\/\*[\s\S]*?\*\/)/.exec(text.slice(i));
    if (ws) { out += ws[0]; i += ws[0].length; continue; }
    let j = i;
    while (j < text.length && text[j] !== '{' && text[j] !== ';') { if (text.startsWith('/*', j)) { j = text.indexOf('*/', j) + 2; continue; } j++; }
    if (j >= text.length) { out += text.slice(i); break; }
    if (text[j] === ';') { out += text.slice(i, j + 1); i = j + 1; continue; }
    let d = 0, k = j;
    for (; k < text.length; k++) {
      if (text.startsWith('/*', k)) { k = text.indexOf('*/', k) + 1; continue; }
      if (text[k] === '{') d++; else if (text[k] === '}' && --d === 0) break;
    }
    const prelude = text.slice(i, j), body = text.slice(j + 1, k), head = prelude.trim();
    if (head.startsWith('@')) {
      if (/^@(media|container|supports|layer)\b/.test(head)) { const inner = walk(body); if (inner.trim()) out += `${prelude}{${inner}}`; }
      else out += text.slice(i, k + 1);
    } else {
      const sels = splitTop(prelude);
      const keep = sels.filter((s) => !dead(s));
      for (const s of sels) if (dead(s)) removed.push({ selector: s.trim(), missing: needed(s).filter((c) => !classUsed(c)) });
      if (keep.length === sels.length) out += `${prelude}{${body}}`;
      else if (keep.length) out += `${keep.map((s) => s.trim()).join(', ')} {${body}}`;
    }
    i = k + 1;
  }
  return out;
}

const next = walk(css).replace(/\n{3,}/g, '\n\n');
if (process.argv.includes('--fix')) {
  writeFileSync(cssPath, next);
  console.log(`removed ${removed.length} selectors (${css.length - next.length} bytes)`);
  for (const r of removed) console.log(`- ${r.selector}   [not in src: ${r.missing.join(', ')}]`);
} else {
  for (const r of removed) console.log(`unused: ${r.selector}   [not in src: ${r.missing.join(', ')}]`);
  console.log(removed.length ? `${removed.length} unused selectors` : 'no unused selectors');
  process.exit(removed.length ? 1 : 0);
}
