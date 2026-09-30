/** `pnpm --filter @yieldvest/rwa-lp vectors`: rewrites vectors/nyse-sessions.json from session.ts. */
import { writeFileSync } from 'node:fs';
import { buildNyseVectors, serializeVectors, VECTORS_PATH } from './calendar-vectors.js';

const vectors = buildNyseVectors();
writeFileSync(VECTORS_PATH, serializeVectors(vectors));
console.log(`${vectors.timestamps.length} vectors → ${VECTORS_PATH}`);
