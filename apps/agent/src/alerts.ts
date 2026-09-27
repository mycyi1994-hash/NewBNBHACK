/**
 * Ops alerts (SPEC §5.9, §10, §13; TASKS M1-07). Telegram when the bot token and the ops chat id
 * are configured, the worker log otherwise. Cycles alert only when they FAIL; DX findings alert on
 * their first sighting. One key is sent once per window, and an alert never breaks the worker.
 */
import type { CycleOutcome } from '@yieldvest/core';

export interface Alert {
  /** Repeats of the same key inside the window are suppressed. */
  key: string;
  text: string;
}

export type AlertResult = 'sent' | 'logged' | 'suppressed' | 'failed';

export interface AlerterOptions {
  telegram?: { botToken: string; chatId: string } | undefined;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
  /** Default one hour. */
  dedupeMs?: number;
  /** Values that must never appear in alert text (keys, the house address). */
  redact?: readonly string[];
}

export interface Alerter {
  readonly channel: 'telegram' | 'log';
  send(alert: Alert): Promise<AlertResult>;
}

const TELEGRAM_API = 'https://api.telegram.org';

export function createAlerter(options: AlerterOptions = {}): Alerter {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  const dedupeMs = options.dedupeMs ?? 60 * 60_000;
  const fetchImpl = options.fetch ?? fetch;
  const secrets = [...(options.redact ?? []), options.telegram?.botToken ?? ''].filter(Boolean);
  // A URL's path and query can carry a key (RPC providers put it there): only the host is kept.
  const mask = (text: string) =>
    secrets
      .reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text)
      .replace(/\b(https?|wss?):\/\/([^/\s?#]+)[^\s]*/gi, '$1://$2/…');
  const lastSent = new Map<string, number>();

  return {
    channel: options.telegram ? 'telegram' : 'log',
    async send(alert) {
      const at = now();
      const previous = lastSent.get(alert.key);
      if (previous !== undefined && at - previous < dedupeMs) return 'suppressed';
      lastSent.set(alert.key, at);
      const text = mask(alert.text);
      if (!options.telegram) {
        log(`ALERT ${alert.key}: ${text}`);
        return 'logged';
      }
      try {
        const response = await fetchImpl(
          `${TELEGRAM_API}/bot${options.telegram.botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: options.telegram.chatId,
              text,
              disable_web_page_preview: true,
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const body = (await response.json().catch(() => null)) as {
          ok?: boolean;
          description?: string;
        } | null;
        if (response.ok && body?.ok === true) return 'sent';
        log(
          `ALERT ${alert.key} (telegram refused: HTTP ${response.status}` +
            `${body?.description ? ` ${mask(body.description)}` : ''}): ${text}`,
        );
        return 'failed';
      } catch (error) {
        const reason = mask(error instanceof Error ? error.message : String(error));
        log(`ALERT ${alert.key} (telegram unreachable: ${reason}): ${text}`);
        return 'failed';
      }
    },
  };
}

/** The alert a finished cycle raises: FAILED only (DEFERRED and SKIPPED are normal days). */
export function cycleAlert(cycle: {
  planId: string;
  cycleId: number;
  executionMode: string;
  outcome: CycleOutcome;
}): Alert | undefined {
  if (cycle.outcome.kind !== 'FAILED') return undefined;
  const { code, message, fundsMoved } = cycle.outcome;
  const moved = fundsMoved === 'none' ? 'no funds moved' : 'only the network fee was spent';
  return {
    key: `cycle-failed:${cycle.planId}:${code}`,
    text:
      `[yieldvest] ${cycle.planId} cycle #${cycle.cycleId} FAILED (${cycle.executionMode}): ` +
      `${code} — ${message}; ${moved}.`,
  };
}
