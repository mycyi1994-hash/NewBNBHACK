/**
 * DX findings (SPEC §10, M1-07). A finding is stored once per (kind, module, endpoint, code); the
 * insert tells the caller whether this was the first sighting, which is when ops hear about it.
 */
import { and, asc, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import { dxEvents } from './schema.js';

export type DxEventRow = typeof dxEvents.$inferSelect;
export type DxEventInsert = typeof dxEvents.$inferInsert;

/** Stores the finding unless it was seen before; true on the first sighting. */
export async function recordDxEvent(db: Db, event: DxEventInsert): Promise<boolean> {
  const created = await db
    .insert(dxEvents)
    .values(event)
    .onConflictDoNothing({
      target: [dxEvents.kind, dxEvents.module, dxEvents.endpoint, dxEvents.code],
    })
    .returning({ id: dxEvents.id });
  return created.length > 0;
}

export async function listDxEvents(
  db: Db,
  filter: { unloggedOnly?: boolean } = {},
): Promise<DxEventRow[]> {
  return db
    .select()
    .from(dxEvents)
    .where(filter.unloggedOnly ? isNull(dxEvents.loggedAt) : undefined)
    .orderBy(asc(dxEvents.ts), asc(dxEvents.id));
}

/** Marks findings as copied into dx/LOG.md. */
export async function markDxEventsLogged(db: Db, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(dxEvents)
    .set({ loggedAt: sql`now()` })
    .where(and(inArray(dxEvents.id, [...ids]), isNull(dxEvents.loggedAt)));
}
