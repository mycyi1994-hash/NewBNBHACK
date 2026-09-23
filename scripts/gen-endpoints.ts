/**
 * Regenerates the tables in docs/vendor/ENDPOINTS.md (between the GENERATED markers).
 *
 * Sources, joined by Operation ID:
 *  1. docs/vendor/llms-full.txt, section "API Reference" — group, method, path, title, operationId.
 *  2. @binance-web3/wallet request builders (dist/index.mjs) — where each parameter is placed on
 *     the wire (path/query/body/header). We call the connector's own builders with sentinel values
 *     instead of re-reading its source by eye.
 *  3. @binance-web3/wallet type declarations (dist/index.d.mts) — required/optional request fields
 *     and the fields of each response's `data`.
 *
 * Nothing in the tables is typed by hand. Run: pnpm endpoints (after scripts/fetch-docs.sh).
 */
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Web3Wallet } from '@binance-web3/wallet';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LLMS_FULL = path.join(ROOT, 'docs/vendor/llms-full.txt');
const ENDPOINTS_MD = path.join(ROOT, 'docs/vendor/ENDPOINTS.md');
const BEGIN = '<!-- BEGIN GENERATED: pnpm endpoints -->';
const END = '<!-- END GENERATED -->';
/** Sent on every operation as headers; documented once in the Authentication section. */
const COMMON_PARAMS = new Set(['recvWindow', 'nonce']);

interface DocOperation {
  group: string;
  method: string;
  path: string;
  title: string;
  operationId: string;
  line: number;
}

type Placement = 'path' | 'query' | 'body' | 'header';

interface ConnectorOperation {
  api: string;
  operationId: string;
  method: string;
  path: string;
  placements: Map<string, Placement[]>;
}

interface Member {
  name: string;
  optional: boolean;
  typeText: string;
}

function parseApiReference(text: string): DocOperation[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('### Binance Web3 API ('));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('### Binance Web3 WebSocket'));
  if (start < 0 || end < 0) throw new Error('llms-full.txt: "API Reference" section not found');
  const ops: DocOperation[] = [];
  let group = '';
  let current: Omit<DocOperation, 'operationId'> | undefined;
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? '';
    const groupMatch = /^#### (.+)$/.exec(line);
    if (groupMatch?.[1]) {
      group = groupMatch[1].trim();
      continue;
    }
    const opMatch = /^##### `([A-Z]+) (\S+)`$/.exec(line);
    if (opMatch?.[1] && opMatch[2]) {
      current = { group, method: opMatch[1], path: opMatch[2], title: '', line: i + 1 };
      continue;
    }
    if (!current) continue;
    const idMatch = /^Operation ID: `(\w+)`$/.exec(line);
    if (idMatch?.[1]) {
      ops.push({ ...current, operationId: idMatch[1] });
      current = undefined;
    } else if (!current.title && line.trim()) {
      current.title = line.trim();
    }
  }
  return ops;
}

interface BuiltRequest {
  endpoint: string;
  method: string;
  queryParams: Record<string, unknown>;
  bodyParams: Record<string, unknown>;
  headerParams: Record<string, unknown>;
}
type Builder = (...args: unknown[]) => Promise<BuiltRequest>;

async function introspectConnector(): Promise<Map<string, ConnectorOperation>> {
  const wallet = new Web3Wallet({
    configurationRestAPI: { apiKey: 'introspection-only', apiSecret: 'introspection-only' },
  });
  const rest = wallet.restAPI as unknown as Record<string, unknown>;
  const out = new Map<string, ConnectorOperation>();
  for (const [api, value] of Object.entries(rest)) {
    if (typeof value !== 'object' || value === null || !('localVarAxiosParamCreator' in value)) {
      continue;
    }
    const builders = (value as { localVarAxiosParamCreator: Record<string, Builder> })
      .localVarAxiosParamCreator;
    for (const [operationId, build] of Object.entries(builders)) {
      const header = /^async\s*\(([^)]*)\)/.exec(build.toString());
      if (!header) throw new Error(`cannot read parameters of ${api}.${operationId}`);
      const params = (header[1] ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const sentinel = (p: string) => `__ijaro_${p}__`;
      const built = await build(...params.map(sentinel));
      const placements = new Map<string, Placement[]>();
      const place = (p: string, where: Placement) =>
        placements.set(p, [...(placements.get(p) ?? []), where]);
      for (const p of params) {
        if (built.endpoint.includes(sentinel(p))) place(p, 'path');
        const sections: [Placement, Record<string, unknown>][] = [
          ['query', built.queryParams],
          ['body', built.bodyParams],
          ['header', built.headerParams],
        ];
        for (const [where, section] of sections) {
          for (const [key, v] of Object.entries(section)) {
            if (v === sentinel(p)) place(key === p ? p : `${p}→${key}`, where);
          }
        }
      }
      let pathTemplate = built.endpoint;
      for (const p of params) pathTemplate = pathTemplate.replace(sentinel(p), `{${p}}`);
      out.set(operationId, {
        api,
        operationId,
        method: built.method,
        path: pathTemplate,
        placements,
      });
    }
  }
  return out;
}

function loadDeclarations(dtsPath: string) {
  const program = ts.createProgram([dtsPath], { noEmit: true, skipLibCheck: true, types: [] });
  const sf = program.getSourceFile(dtsPath);
  if (!sf) throw new Error(`cannot load ${dtsPath}`);
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  const unions = new Map<string, string[]>();
  ts.forEachChild(sf, (node) => {
    if (ts.isInterfaceDeclaration(node)) interfaces.set(node.name.text, node);
    if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)) {
      unions.set(
        node.name.text,
        node.type.types.filter(ts.isTypeReferenceNode).map((t) => t.typeName.getText(sf)),
      );
    }
  });
  const members = (name: string): Member[] | undefined => {
    const decl = interfaces.get(name);
    if (!decl) return undefined;
    return decl.members.filter(ts.isPropertySignature).map((m) => ({
      name: m.name.getText(sf),
      optional: m.questionToken !== undefined,
      typeText: m.type?.getText(sf) ?? 'unknown',
    }));
  };
  return {
    members,
    has: (name: string) => interfaces.has(name),
    unionOf: (name: string) => unions.get(name) ?? [],
  };
}

type Declarations = ReturnType<typeof loadDeclarations>;

function unwrap(typeText: string): { array: boolean; name: string } {
  const m = /^Array<(\w+)>$/.exec(typeText) ?? /^(\w+)\[\]$/.exec(typeText);
  return m?.[1] ? { array: true, name: m[1] } : { array: false, name: typeText };
}

/** `name`, `name{}` (object) or `name[]` (array), plus one level of object fields for requests. */
function describe(member: Member, decls: Declarations, expand: boolean): string {
  const { array, name } = unwrap(member.typeText);
  const suffix = array ? '[]' : decls.has(name) ? '{}' : '';
  let text = `\`${member.name}${suffix}\``;
  if (expand && decls.has(name)) {
    const inner = decls.members(name) ?? [];
    text += ` (${inner.map((m) => `${m.name}${m.optional ? '' : '*'}`).join(', ')})`;
  }
  return text;
}

function responseFields(operationId: string, decls: Declarations): string {
  const typeName = `${operationId[0]?.toUpperCase()}${operationId.slice(1)}Response`;
  // Most responses are one interface; b402 responses are `Response1 | Response2` aliases whose
  // members use a different envelope ({status, type, code: string, errorData, data, subData}).
  const candidates = decls.has(typeName) ? [typeName] : decls.unionOf(typeName);
  for (const candidate of candidates) {
    const envelope = decls.members(candidate) ?? [];
    const data = envelope.find((m) => m.name === 'data');
    if (!data) continue;
    const { array, name } = unwrap(data.typeText);
    const fields = decls.members(name);
    if (!fields) continue;
    const prefix =
      candidates.length > 1 ? `(envelope: ${envelope.map((m) => m.name).join(', ')}) ` : '';
    return (
      prefix + (array ? '`[]` of: ' : '') + fields.map((f) => describe(f, decls, false)).join(', ')
    );
  }
  return 'not typed in connector';
}

function cell(values: string[]): string {
  return values.length ? values.join(', ') : '—';
}

async function main() {
  const text = await readFile(LLMS_FULL, 'utf8');
  const fetchedAt = (await stat(LLMS_FULL)).mtime.toISOString();
  const sha = createHash('sha256').update(text).digest('hex').slice(0, 12);
  const lineCount = text.split('\n').length;
  const docOps = parseApiReference(text);

  const require = createRequire(import.meta.url);
  const connectorEntry = require.resolve('@binance-web3/wallet');
  const pkgJson = JSON.parse(
    await readFile(path.join(path.dirname(connectorEntry), '..', 'package.json'), 'utf8'),
  ) as { version: string };
  const decls = loadDeclarations(path.join(path.dirname(connectorEntry), 'index.d.mts'));
  const connector = await introspectConnector();

  const anomalies: string[] = [];
  const groups = new Map<string, string[]>();
  for (const op of docOps) {
    const c = connector.get(op.operationId);
    const rows = groups.get(op.group) ?? [];
    groups.set(op.group, rows);
    const source = `§ API Reference › ${op.group} › "${op.title}" (L${op.line})`;
    if (!c) {
      anomalies.push(`\`${op.operationId}\` is in llms-full.txt but not in the connector.`);
      rows.push(
        `| ${op.method} | \`${op.path}\` | — | — | not in connector | ${source}, op \`${op.operationId}\` |`,
      );
      continue;
    }
    if (c.method !== op.method || c.path !== op.path) {
      anomalies.push(
        `\`${op.operationId}\`: llms-full.txt says \`${op.method} ${op.path}\`, connector builds \`${c.method} ${c.path}\`.`,
      );
    }
    const requestType = `${op.operationId[0]?.toUpperCase()}${op.operationId.slice(1)}Request`;
    const members = (decls.members(requestType) ?? []).filter((m) => !COMMON_PARAMS.has(m.name));
    const where = (name: string) => {
      const places = [...c.placements.entries()]
        .filter(([key]) => key === name || key.startsWith(`${name}→`))
        .flatMap(([key, ps]) => ps.map((p) => (key === name ? p : `${p} as ${key.split('→')[1]}`)));
      return places.length ? places.join('+') : 'unused';
    };
    const fmt = (m: Member) => `${describe(m, decls, true)} _${where(m.name)}_`;
    const required = members.filter((m) => !m.optional).map(fmt);
    const optional = members.filter((m) => m.optional).map(fmt);
    rows.push(
      `| ${op.method} | \`${op.path}\` | ${cell(required)} | ${cell(optional)} | ${responseFields(op.operationId, decls)} | ${source}, op \`${op.operationId}\` |`,
    );

    const bodyKeys = [...c.placements.values()].flat().filter((p) => p === 'body').length;
    if (op.method === 'GET' && bodyKeys > 0) {
      anomalies.push(
        `\`${op.operationId}\` (${op.method} ${op.path}): the connector also puts ${[
          ...c.placements.entries(),
        ]
          .filter(([, ps]) => ps.includes('body'))
          .map(([k]) => `\`${k}\``)
          .join(
            ', ',
          )} in a JSON body and signs it, while Authentication says GET bodies sign as "".`,
      );
    }
    if (op.method === 'POST' && bodyKeys === 0) {
      anomalies.push(
        `\`${op.operationId}\` (${op.method} ${op.path}): the connector has no body parameters, so its typed method always sends an empty body.`,
      );
    }
  }
  for (const id of connector.keys()) {
    if (!docOps.some((op) => op.operationId === id)) {
      anomalies.push(`\`${id}\` is in the connector but not in the llms-full.txt API Reference.`);
    }
  }

  const out: string[] = [
    BEGIN,
    '',
    `Generated ${new Date().toISOString()} from \`docs/vendor/llms-full.txt\` (fetched ${fetchedAt}, ${lineCount} lines, sha256 \`${sha}…\`) and \`@binance-web3/wallet@${pkgJson.version}\`.`,
    `Operations: ${docOps.length} in the llms-full.txt API Reference, ${connector.size} in the connector.`,
    '',
    'Legend: `*` marks a required sub-field; _path/query/body/header_ is where the connector puts the parameter on the wire; `x{}` object, `x[]` array. `recvWindow` and `nonce` (optional on every operation) are omitted — see Authentication.',
    '',
  ];
  for (const [group, rows] of groups) {
    out.push(
      `### ${group}`,
      '',
      '| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows,
      '',
    );
  }
  out.push('### Doc ↔ connector anomalies (auto-detected)', '');
  out.push(...(anomalies.length ? anomalies.map((a) => `- ${a}`) : ['- none']), '', END);

  const current = await readFile(ENDPOINTS_MD, 'utf8').catch(() => `${BEGIN}\n${END}\n`);
  const from = current.indexOf(BEGIN);
  const to = current.indexOf(END);
  if (from < 0 || to < 0) throw new Error(`${ENDPOINTS_MD}: GENERATED markers missing`);
  await writeFile(
    ENDPOINTS_MD,
    current.slice(0, from) + out.join('\n') + current.slice(to + END.length),
  );
  console.log(
    `ENDPOINTS.md: ${docOps.length} doc operations, ${connector.size} connector operations, ${anomalies.length} anomalies`,
  );
}

await main();
