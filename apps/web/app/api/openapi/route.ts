/** GET /api/openapi — the OpenAPI 3.1 contract of this API (TASKS M2-08). */
import { context } from '../../../lib/server/context';
import { json } from '../../../lib/server/http';
import { openApiDocument } from '../../../lib/server/openapi';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return json(openApiDocument(context().config.appUrl));
}
