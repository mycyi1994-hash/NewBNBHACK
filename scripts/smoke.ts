/**
 * pnpm smoke [--url https://…] [--strict] [--alert] — GET /api/judge/smoke on the target (default
 * NEXT_PUBLIC_APP_URL) and print each check (CLAUDE.md rule 9: before every deploy).
 * Exit 0 when green, 1 when red or unreachable; degraded (something stale, e.g. no receipt yet)
 * exits 0 with a warning, or 1 with --strict. With --alert, anything but green is also sent to
 * the ops channel (Telegram when configured, the log otherwise) — the M2-12 monitor runs this.
 */
import { createAlerter } from '@yieldvest/agent';
import { loadConfig } from '@yieldvest/config';

const args = process.argv.slice(2).filter((a) => a !== '--');
const urlFlag = args.indexOf('--url');
const config = loadConfig();
const base = (urlFlag >= 0 ? args[urlFlag + 1] : undefined) ?? config.appUrl;
const strict = args.includes('--strict');
const target = `${base.replace(/\/+$/, '')}/api/judge/smoke`;

interface Smoke {
  status: 'green' | 'degraded' | 'red';
  at: string;
  checks: Record<string, { state: string; detail: Record<string, unknown> }>;
}

const MARK: Record<string, string> = { green: '✓', degraded: '!', red: '✗' };

async function alert(text: string): Promise<void> {
  if (!args.includes('--alert')) return;
  const { botToken, opsChatId } = config.telegram;
  const alerter = createAlerter({
    telegram: botToken && opsChatId ? { botToken, chatId: opsChatId } : undefined,
  });
  const result = await alerter.send({ key: `smoke:${target}`, text: `[yieldvest] ${text}` });
  console.log(`alert: channel ${alerter.channel}, result ${result}`);
  if (result === 'failed') process.exitCode = 1;
}

const started = Date.now();
let body: Smoke | undefined;
try {
  const response = await fetch(target, { signal: AbortSignal.timeout(20_000) });
  body = (await response.json()) as Smoke;
  console.log(`smoke ${target} → HTTP ${response.status} in ${Date.now() - started} ms`);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.log(`smoke ${target} → unreachable: ${reason}`);
  process.exitCode = 1;
  await alert(`smoke UNREACHABLE: ${target} (${reason})`);
}
if (body) {
  for (const [name, check] of Object.entries(body.checks)) {
    console.log(
      `  ${MARK[check.state] ?? '?'} ${name.padEnd(9)} ${check.state.padEnd(8)} ${JSON.stringify(check.detail)}`,
    );
  }
  console.log(`status: ${body.status} (at ${body.at})`);
  if (body.status === 'red' || (strict && body.status !== 'green')) process.exitCode = 1;
  else if (body.status === 'degraded') console.log('warning: degraded — see the checks marked !');
  if (body.status !== 'green') {
    const failing = Object.entries(body.checks)
      .filter(([, check]) => check.state !== 'green')
      .map(([name, check]) => `${name} ${check.state}`);
    await alert(`smoke ${body.status.toUpperCase()} at ${target}: ${failing.join(', ')}`);
  }
}
