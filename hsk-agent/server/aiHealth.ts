// Is the AI model answering? The last outcome of each kind of call this server makes to it: the chat (Moa's answers)
// and Moa AI's decisions. Kept in memory only: an answer, or the kind of failure (HTTP status and the API's error
// type, never the request, the answer or a key). A key that is set says nothing about whether calls succeed: with no
// credit left every call fails at once, and the server used to go on saying "ai: on".
export type AiCall = 'chat' | 'pilot';
export interface CallOutcome { ok: boolean; kind?: string; at: number }
/**
 * A failure this old, with no call of its kind since, no longer counts: nobody has tried again, so nothing is known.
 * Moa AI calls every four hours, so its failure stands until the call after next; the chat is asked far more often,
 * and one busy moment should not mark it for hours.
 */
export const FAIL_KEEP_MS: Record<AiCall, number> = { chat: 30 * 60_000, pilot: 6 * 3_600_000 };

/** The kind of failure, safe to show: "400 invalid_request_error", "529 overloaded_error", "no-status APIConnectionError", "timeout". */
export function failureKind(e: unknown): string {
  const x = e as { status?: unknown; name?: unknown; message?: unknown; error?: { error?: { type?: unknown } } } | null;
  const type = x?.error?.error?.type;
  if (typeof x?.status !== 'number' && /abort|timeout|timed out/i.test(`${String(x?.name ?? '')} ${String(x?.message ?? '')}`)) return 'timeout';
  return `${typeof x?.status === 'number' ? x.status : 'no-status'} ${typeof type === 'string' ? type : e instanceof Error ? e.name : 'error'}`.slice(0, 80);
}

export interface AiHealth {
  ok(call: AiCall, now?: number): void;
  /** Records the failure and returns its kind. */
  fail(call: AiCall, e: unknown, now?: number): string;
  last(call: AiCall): CallOutcome | undefined;
  /** True while the last outcome of any kind of call is a failure not older than its FAIL_KEEP_MS. */
  failing(now?: number): boolean;
}
export function openAiHealth(): AiHealth {
  const last = new Map<AiCall, CallOutcome>();
  return {
    ok: (call, now = Date.now()) => { last.set(call, { ok: true, at: now }); },
    fail: (call, e, now = Date.now()) => { const kind = failureKind(e); last.set(call, { ok: false, kind, at: now }); return kind; },
    last: (call) => last.get(call),
    failing: (now = Date.now()) => [...last].some(([call, o]) => !o.ok && now - o.at < FAIL_KEEP_MS[call]),
  };
}
