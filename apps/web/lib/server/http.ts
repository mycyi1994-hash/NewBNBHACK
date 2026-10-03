/** JSON responses, request parsing and a per-instance rate limit for the API routes. */
import type { z } from 'zod';
import { onWorkers } from './runtime';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** An error body with a stable code the UI maps to copy, and a plain message for developers. */
export function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export const unavailable = (reason: string) => json({ state: 'UNAVAILABLE', reason }, 503);

/** Every request body here is a few hundred bytes; anything far larger is refused unread. */
const MAX_BODY_BYTES = 16_384;

/**
 * The request body as JSON (undefined when empty), or a Response. A body larger than the limit is
 * refused before it is read in full, and a non-empty body must say it is JSON — a cross-site form
 * cannot send that without a CORS preflight, which these routes never answer.
 */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return problem(413, 'too_large', 'the body is too large');
  let text = '';
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return problem(413, 'too_large', 'the body is too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  if (text.trim() === '') return undefined;
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/([\w.+-]*\+)?json\b/i.test(type)) {
    return problem(415, 'json_only', 'send the body as application/json');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return problem(400, 'bad_json', 'the body must be JSON');
  }
}

/** `raw` validated by `schema`, or a 400 naming the first problem. */
export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T | Response {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return problem(
      400,
      'bad_request',
      `${first?.path.join('.') || 'body'}: ${first?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

/** The validated JSON body, or an error response. With `optional`, an empty body reads as `{}`. */
export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  options: { optional?: boolean } = {},
): Promise<T | Response> {
  const raw = await readJson(request);
  if (raw instanceof Response) return raw;
  if (raw === undefined && !options.optional) {
    return problem(400, 'bad_json', 'the body must be JSON');
  }
  return parseWith(schema, raw ?? {});
}

/** An integer query parameter clamped to [min, max]; missing or not a number → `fallback`. */
export function intParam(
  request: Request,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(new URL(request.url).searchParams.get(name) ?? fallback);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * The caller's address as the platform saw it: Vercel sets x-real-ip and overwrites
 * x-forwarded-for, so neither is the client's own claim there (RUNBOOK: the web runs on Vercel).
 * On Cloudflare Workers (G2-2) x-real-ip and the head of x-forwarded-for can be the client's own
 * claim; cf-connecting-ip is set by Cloudflare, replacing any value the client sent.
 */
export function clientIp(request: Request): string {
  if (onWorkers) return request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  return (
    request.headers.get('x-real-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

const hits = new Map<string, number[]>();
const MAX_KEYS = 10_000;

/**
 * At most `max` requests per `windowMs` for `key` on this server instance. A courtesy limit: the
 * durable ones (plans per code, jobs per plan, the spend caps) are counted in Postgres. When too
 * many keys are tracked, the idle ones go first — never everyone's history at once.
 */
export function rateLimited(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  const limited = recent.length >= max;
  if (!limited) recent.push(now);
  hits.delete(key);
  hits.set(key, recent);
  if (hits.size > MAX_KEYS) {
    // Map order is insertion order and every hit re-inserts its key: the first keys are the
    // longest idle.
    for (const idle of hits.keys()) {
      if (hits.size <= MAX_KEYS * 0.9) break;
      hits.delete(idle);
    }
  }
  return limited;
}

export const tooMany = () => problem(429, 'rate_limited', 'too many requests, try again shortly');

/**
 * Wraps a route handler: a failure it did not handle (the database is down, a read timed out)
 * becomes 503 UNAVAILABLE with a label — never a 500 page, never the raw message (it can carry
 * hosts); the real error goes to the server log (M3-06 rehearsal).
 */
export function guard<A extends unknown[]>(
  label: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error(`web: ${label} failed —`, error instanceof Error ? error.message : error);
      return unavailable(`${label} unavailable`);
    }
  };
}
