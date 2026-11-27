// May this Moa show nanotradingclub's fire chart inside its own page? The answer is in nanotradingclub's response
// headers, so the server reads them (a browser cannot read another site's headers, and a frame that is refused
// just shows an error page the parent cannot see into). Checked at most once every ten minutes per Moa address.
export const NANO_FIRE = 'https://nanotradingclub.xyz/fire';
export interface FrameCheck { allowed: boolean; why?: 'refused' | 'unreachable'; checkedAt: string }

/**
 * The browser's rule: a Content-Security-Policy frame-ancestors list decides when there is one (X-Frame-Options is
 * then ignored); without one, any X-Frame-Options refuses a frame from another site.
 */
export function frameVerdict(xfo: string | null, csp: string | null, origin: string): boolean {
  const fa = (csp ?? '').split(';').map((d) => d.trim()).find((d) => d.toLowerCase().startsWith('frame-ancestors'));
  if (fa) {
    const allowed = fa.split(/\s+/).slice(1).map((x) => x.replace(/\/+$/, '').toLowerCase());
    return allowed.includes('*') || allowed.includes(origin.replace(/\/+$/, '').toLowerCase());
  }
  return !xfo;
}

const kept = new Map<string, { at: number; v: FrameCheck }>();
export async function frameCheck(origin: string, fetcher: typeof fetch = fetch): Promise<FrameCheck> {
  const had = kept.get(origin);
  if (had && Date.now() - had.at < 600_000) return had.v;
  let v: FrameCheck;
  try {
    const r = await fetcher(`${NANO_FIRE}?embed=1`, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    v = { allowed: frameVerdict(r.headers.get('x-frame-options'), r.headers.get('content-security-policy'), origin), checkedAt: new Date().toISOString() };
    if (!v.allowed) v.why = 'refused';
    void r.body?.cancel();
  } catch {
    v = { allowed: false, why: 'unreachable', checkedAt: new Date().toISOString() };
  }
  kept.set(origin, { at: Date.now(), v });
  return v;
}
