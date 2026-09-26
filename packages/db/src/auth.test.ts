/** Judge codes and skill tokens on Postgres: only hashes are stored (SPEC §8.2, §14). */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl as url } from '../test/helpers.js';
import {
  createDb,
  createSkillToken,
  findJudgeCode,
  findSkillToken,
  judgeCodes,
  revokeSkillToken,
  sha256Hex,
  skillTokens,
  syncJudgeCodes,
} from './index.js';

describe('sha256Hex', () => {
  it('matches the SHA-256 test vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe.skipIf(!url)('judge codes and skill tokens on Postgres', () => {
  const { db, close } = createDb(url ?? 'postgres://unused');
  const alpha = `alpha-${randomUUID()}`;
  const beta = `beta-${randomUUID()}`;
  const tokenIds: string[] = [];

  afterAll(async () => {
    await db.delete(judgeCodes).where(inArray(judgeCodes.codeHash, [alpha, beta].map(sha256Hex)));
    if (tokenIds.length > 0) await db.delete(skillTokens).where(inArray(skillTokens.id, tokenIds));
    await close();
  });

  it('keeps the table in step with the configured codes, storing hashes only', async () => {
    expect(await syncJudgeCodes(db, [alpha, beta, ` ${alpha} `, ''])).toBe(2);
    const found = await findJudgeCode(db, ` ${alpha}`);
    expect(found).toMatchObject({
      codeHash: sha256Hex(alpha),
      label: sha256Hex(alpha).slice(0, 8),
    });
    const stored = await db
      .select()
      .from(judgeCodes)
      .where(eq(judgeCodes.codeHash, sha256Hex(alpha)));
    expect(JSON.stringify(stored)).not.toContain(alpha);

    // A code removed from the configuration stops working; adding it back restores it.
    await syncJudgeCodes(db, [beta]);
    expect(await findJudgeCode(db, alpha)).toBeUndefined();
    expect(await findJudgeCode(db, beta)).toBeDefined();
    await syncJudgeCodes(db, [alpha, beta]);
    expect(await findJudgeCode(db, alpha)).toBeDefined();
    expect(await findJudgeCode(db, 'not-a-code')).toBeUndefined();
  });

  it('issues a skill token once, finds it by hash, and stops it when revoked', async () => {
    const wallet = '0x00000000000000000000000000000000000000a1';
    const { id, token } = await createSkillToken(db, wallet);
    tokenIds.push(id);
    expect(token).toMatch(/^ijr_[A-Za-z0-9_-]{43}$/);
    expect(id).toMatch(/^sk_[0-9a-f]{16}$/);

    const [row] = await db.select().from(skillTokens).where(eq(skillTokens.id, id));
    expect(row?.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row?.lastUsedAt).toBeNull();

    const used = await findSkillToken(db, token);
    expect(used).toMatchObject({ id, walletAddress: wallet });
    expect(used?.lastUsedAt).not.toBeNull();
    expect(await findSkillToken(db, `${token}x`)).toBeUndefined();

    await revokeSkillToken(db, id);
    expect(await findSkillToken(db, token)).toBeUndefined();
  });
});
