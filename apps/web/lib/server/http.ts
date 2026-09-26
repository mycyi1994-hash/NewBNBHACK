/** JSON responses, request parsing and a per-instance rate limit for the API routes. */
import type { z } from 'zod';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** An error body with a stable code the UI maps to copy, and a plain message for developers. */
export function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export const unavailable = (reason: string) => json({ state: 'UNAVAILABLE', reason }, 503);

/** The validated JSON body, or a 400. With `optional`, an empty body reads as `{}`. */
export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  options: { optional?: boolean } = {},
): Promise<T | Response> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = options.optional && text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return problem(400, 'bad_json', 'the body must be JSON');
  }
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

export function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

const hits = new Map<string, number[]>();

/**
 * At most `max` requests per `windowMs` for `key` on this server instance. A courtesy limit: the
 * durable ones (plans per code, jobs per plan, the spend caps) are counted in Postgres.
 */
export function rateLimited(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  const limited = recent.length >= max;
  if (!limited) recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.clear();
  return limited;
}

export const tooMany = () => problem(429, 'rate_limited', 'too many requests, try again shortly');
