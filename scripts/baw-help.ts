/**
 * pnpm baw:help [--baw <path>] — records the `--help` of every Binance Agentic Wallet command that
 * the Wallet Skill and /next use, from the installed `baw`, into fixtures/baw/<version>/. Nothing is
 * signed or sent and no sign-in is needed: `--help` only prints the command's options.
 * apps/web/test/baw-contract.test.ts checks /next's argv and every `baw` line in skills/yieldvest
 * against these recordings, so a flag `baw` does not have fails CI, not the user's wallet.
 * Exit: 0 recorded · 2 usage · 3 no `baw` found.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './args.js';

/** The commands the skill documents and /next returns, as `baw` argv before the flags. */
export const BAW_COMMANDS: readonly (readonly string[])[] = [
  [],
  ['cli-check'],
  ['wallet', 'status'],
  ['wallet', 'address'],
  ['wallet', 'settings'],
  ['wallet', 'left-quota'],
  ['market-order', 'quote'],
  ['market-order', 'swap'],
  ['market-order', 'list'],
  ['defi', 'investment-list'],
  ['defi', 'preview'],
  ['defi', 'deposit'],
  ['defi', 'redeem'],
  ['approvals', 'list'],
  ['approvals', 'revoke'],
];

/** fixtures/baw/<version>/<file>: `root.txt` for `baw --help`, else the command joined by '-'. */
export const helpFile = (command: readonly string[]) =>
  `${command.length === 0 ? 'root' : command.join('-')}.txt`;

const usage = 'usage: pnpm baw:help [--baw <path to the baw executable>]';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = parseFlags(process.argv.slice(2), { values: ['baw'] });
  if (!flags.ok) {
    console.error(`${flags.error}\n${usage}`);
    process.exit(2);
  }
  const baw = flags.values.baw ?? 'baw';
  // Piped, not a terminal: commander wraps help at 80 columns and chalk prints no colours.
  const run = (args: readonly string[]) =>
    execFileSync(baw, [...args], { encoding: 'utf8', timeout: 20_000 });
  let version: string;
  try {
    version = run(['--version']).trim();
  } catch (error) {
    console.error(
      `no baw at '${baw}': ${error instanceof Error ? error.message.split('\n')[0] : ''}`,
    );
    process.exit(3);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`unexpected baw --version answer: ${JSON.stringify(version)}`);
    process.exit(3);
  }
  const dir = fileURLToPath(new URL(`../fixtures/baw/${version}/`, import.meta.url));
  mkdirSync(dir, { recursive: true });
  for (const command of BAW_COMMANDS) {
    writeFileSync(path.join(dir, helpFile(command)), run([...command, '--help']));
  }
  console.log(`baw ${version}: ${BAW_COMMANDS.length} help texts in fixtures/baw/${version}/`);
}
