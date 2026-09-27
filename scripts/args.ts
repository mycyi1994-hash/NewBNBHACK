/**
 * Flag parsing for the operator scripts (audit S20). A flag is `--name <value>` or a bare
 * `--switch`. Anything else is a usage error that the script answers with its usage line and
 * exit code 2, never with a guess: an unknown flag, a stray argument, a flag given twice, a value
 * flag without its value, a value that is empty or starts with `--` (a following flag is never
 * read as a value), or a required flag that is missing. The `--` that pnpm passes through is
 * ignored.
 */
import { parseArgs } from 'node:util';

/** A transaction hash as `--record` takes it. */
export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface FlagSpec<V extends string, S extends string, R extends V> {
  /** Flags that take a value: `plan` for `--plan <id>`. */
  values?: readonly V[];
  /** Bare switches: `live` for `--live`. */
  switches?: readonly S[];
  /** Value flags that must be given. */
  required?: readonly R[];
}

export interface Flags<V extends string, S extends string, R extends V> {
  ok: true;
  values: Record<R, string> & Partial<Record<Exclude<V, R>, string>>;
  switches: Record<S, boolean>;
}

export interface FlagError {
  ok: false;
  error: string;
}

export function parseFlags<V extends string = never, S extends string = never, R extends V = never>(
  argv: readonly string[],
  spec: FlagSpec<V, S, R>,
): Flags<V, S, R> | FlagError {
  const fail = (error: string): FlagError => ({ ok: false, error });
  const options: Record<string, { type: 'string' | 'boolean' }> = {};
  for (const name of spec.values ?? []) options[name] = { type: 'string' };
  for (const name of spec.switches ?? []) options[name] = { type: 'boolean' };
  let tokens;
  try {
    ({ tokens } = parseArgs({
      args: argv.filter((arg) => arg !== '--'),
      options,
      strict: true,
      allowPositionals: false,
      tokens: true,
    }));
  } catch (error) {
    // node:util names the problem on its first line (unknown option, missing or ambiguous value).
    return fail((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '');
  }
  const values: Record<string, string> = {};
  const switches: Record<string, boolean> = {};
  for (const name of spec.switches ?? []) switches[name] = false;
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) return fail(`--${token.name} is given more than once`);
    seen.add(token.name);
    if (token.value === undefined) {
      switches[token.name] = true;
    } else if (token.value === '' || token.value.startsWith('--')) {
      return fail(`--${token.name} needs a value, not '${token.value}'`);
    } else {
      values[token.name] = token.value;
    }
  }
  for (const name of spec.required ?? []) {
    if (values[name] === undefined) return fail(`--${name} is required`);
  }
  return { ok: true, values, switches };
}
