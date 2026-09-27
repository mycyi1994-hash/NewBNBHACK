/** Ops alerts: FAILED-only, deduplicated, Telegram or log, never leaking the bot token. */
import { describe, expect, it } from 'vitest';
import { createAlerter, cycleAlert } from './alerts.js';

const TOKEN = '123456:telegram-bot-token';

function telegram(reply: () => Promise<Response>) {
  const calls: { url: string; body: unknown }[] = [];
  const lines: string[] = [];
  let now = 0;
  const alerter = createAlerter({
    telegram: { botToken: TOKEN, chatId: '-100200' },
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') });
      return reply();
    },
    log: (line) => lines.push(line),
    now: () => now,
    dedupeMs: 60_000,
    redact: ['0xHOUSE'],
  });
  return { alerter, calls, lines, advance: (ms: number) => (now += ms) };
}

describe('createAlerter', () => {
  it('sends to the ops chat once per key per window', async () => {
    const t = telegram(() => Promise.resolve(Response.json({ ok: true })));
    const alert = { key: 'cycle-failed:H-SAFE:40001', text: 'H-SAFE failed for 0xHOUSE' };
    expect(await t.alerter.send(alert)).toBe('sent');
    expect(await t.alerter.send(alert)).toBe('suppressed');
    t.advance(60_000);
    expect(await t.alerter.send(alert)).toBe('sent');
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]).toEqual({
      url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      body: {
        chat_id: '-100200',
        text: 'H-SAFE failed for [redacted]',
        disable_web_page_preview: true,
      },
    });
    expect(t.alerter.channel).toBe('telegram');
  });

  it('logs when Telegram refuses or is unreachable, without the token', async () => {
    const refused = telegram(() =>
      Promise.resolve(Response.json({ ok: false, description: 'chat not found' }, { status: 400 })),
    );
    expect(await refused.alerter.send({ key: 'k', text: 'hello' })).toBe('failed');
    expect(refused.lines).toEqual(['ALERT k (telegram refused: HTTP 400 chat not found): hello']);

    const down = telegram(() =>
      Promise.reject(new Error(`connect ECONNREFUSED api.telegram.org/bot${TOKEN}`)),
    );
    expect(await down.alerter.send({ key: 'k', text: 'hello' })).toBe('failed');
    expect(down.lines[0]).toContain('telegram unreachable');
    expect(down.lines.join('\n')).not.toContain(TOKEN);
  });

  it('keeps only the host of a URL: an RPC key in its path never reaches the chat', async () => {
    const lines: string[] = [];
    const alerter = createAlerter({ log: (line) => lines.push(line) });
    await alerter.send({
      key: 'tick:settle',
      text: 'worker settle failed: HTTP request failed. URL: https://bsc.example.com/v1/SECRET?k=1 Details',
    });
    expect(lines).toEqual([
      'ALERT tick:settle: worker settle failed: HTTP request failed. URL: https://bsc.example.com/… Details',
    ]);
  });

  it('writes to the worker log when no Telegram is configured', async () => {
    const lines: string[] = [];
    const alerter = createAlerter({ log: (line) => lines.push(line) });
    expect(alerter.channel).toBe('log');
    expect(await alerter.send({ key: 'dx:x', text: 'first sighting' })).toBe('logged');
    expect(lines).toEqual(['ALERT dx:x: first sighting']);
  });
});

describe('cycleAlert', () => {
  const base = { planId: 'H-SAFE', cycleId: 42, executionMode: 'live' };

  it('raises an alert only for FAILED cycles', () => {
    expect(
      cycleAlert({ ...base, outcome: { kind: 'SKIPPED', reason: 'daily_cap' } }),
    ).toBeUndefined();
    expect(
      cycleAlert({
        ...base,
        outcome: { kind: 'DEFERRED', reason: 'market_closed', retryAt: '2026-09-28T13:32:00Z' },
      }),
    ).toBeUndefined();
    expect(
      cycleAlert({
        ...base,
        outcome: {
          kind: 'FAILED',
          code: 'SIM_REVERT',
          message: 'execution reverted',
          fundsMoved: 'none',
        },
      }),
    ).toEqual({
      key: 'cycle-failed:H-SAFE:SIM_REVERT',
      text: '[ijaro] H-SAFE cycle #42 FAILED (live): SIM_REVERT — execution reverted; no funds moved.',
    });
    expect(
      cycleAlert({
        ...base,
        outcome: {
          kind: 'FAILED',
          code: 'RECEIPT_STATUS_0',
          message: 'reverted',
          fundsMoved: 'gas_only',
        },
      })?.text,
    ).toContain('only the network fee was spent');
  });
});
