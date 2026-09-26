/** dx_events on Postgres: one row per first sighting, whoever sees it first. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl as url } from '../test/helpers.js';
import { createDb, dxEvents, listDxEvents, markDxEventsLogged, recordDxEvent } from './index.js';

describe.skipIf(!url)('dx_events on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const endpoint = `test-${randomUUID()}`;

  afterAll(async () => {
    await db.delete(dxEvents).where(eq(dxEvents.endpoint, endpoint));
    await close();
  });

  it('reports only the first sighting of a code per endpoint, even when seen concurrently', async () => {
    const event = {
      ts: '2026-09-28T13:32:01.000Z',
      kind: 'unknown_code',
      module: 'trading',
      endpoint,
      code: '40999',
      httpStatus: 200,
      msg: 'something new',
      requestId: 'req-1',
      region: 'fra',
      meaning: 'code 40999 is not in the trading error table',
    };
    const firsts = await Promise.all([1, 2, 3].map(() => recordDxEvent(db, event)));
    expect(firsts.filter(Boolean)).toHaveLength(1);
    expect(await recordDxEvent(db, { ...event, code: '40998' })).toBe(true);

    const mine = (await listDxEvents(db, { unloggedOnly: true })).filter(
      (e) => e.endpoint === endpoint,
    );
    expect(mine.map((e) => e.code).sort()).toEqual(['40998', '40999']);
    await markDxEventsLogged(
      db,
      mine.map((e) => e.id),
    );
    expect(
      (await listDxEvents(db, { unloggedOnly: true })).filter((e) => e.endpoint === endpoint),
    ).toEqual([]);
    expect((await listDxEvents(db)).filter((e) => e.endpoint === endpoint)).toHaveLength(2);
  });
});
