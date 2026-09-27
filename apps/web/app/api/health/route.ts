/** GET /api/health (SPEC §8.2): the web process answers. Nothing else is checked here. */
import { json } from '../../../lib/server/http';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return json({ ok: true, service: 'web', at: new Date().toISOString() });
}
