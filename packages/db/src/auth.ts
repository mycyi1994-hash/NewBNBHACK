/**
 * Judge codes and skill tokens (SPEC §8.2, §14). Only SHA-256 hashes are stored; a skill token is
 * shown once, when it is created. The server never stores user keys or wallet sessions.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, not, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import { judgeCodes, skillTokens } from './schema.js';

export type JudgeCodeRow = typeof judgeCodes.$inferSelect;
export type SkillTokenRow = typeof skillTokens.$inferSelect;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Makes the table match the configured codes: new ones added, missing ones disabled. */
export async function syncJudgeCodes(db: Db, codes: readonly string[]): Promise<number> {
  const hashes = [...new Set(codes.map((c) => c.trim()).filter((c) => c !== ''))].map(sha256Hex);
  if (hashes.length > 0) {
    await db
      .insert(judgeCodes)
      .values(hashes.map((codeHash) => ({ codeHash, label: codeHash.slice(0, 8) })))
      .onConflictDoUpdate({ target: judgeCodes.codeHash, set: { disabled: false } });
  }
  await db
    .update(judgeCodes)
    .set({ disabled: true })
    .where(hashes.length > 0 ? not(inArray(judgeCodes.codeHash, hashes)) : sql`true`);
  return hashes.length;
}

export async function findJudgeCode(db: Db, code: string): Promise<JudgeCodeRow | undefined> {
  const [row] = await db
    .select()
    .from(judgeCodes)
    .where(and(eq(judgeCodes.codeHash, sha256Hex(code.trim())), eq(judgeCodes.disabled, false)))
    .limit(1);
  return row;
}

/** Issues a bearer token for a skill plan. The plain token is returned once and never stored. */
export async function createSkillToken(
  db: Db,
  walletAddress: string,
): Promise<{ id: string; token: string }> {
  const token = `ijr_${randomBytes(32).toString('base64url')}`;
  const id = `sk_${randomBytes(8).toString('hex')}`;
  await db.insert(skillTokens).values({ id, tokenHash: sha256Hex(token), walletAddress });
  return { id, token };
}

export async function findSkillToken(db: Db, token: string): Promise<SkillTokenRow | undefined> {
  const [row] = await db
    .update(skillTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(skillTokens.tokenHash, sha256Hex(token)), isNull(skillTokens.revokedAt)))
    .returning();
  return row;
}

export async function revokeSkillToken(db: Db, id: string): Promise<void> {
  await db
    .update(skillTokens)
    .set({ revokedAt: sql`now()` })
    .where(eq(skillTokens.id, id));
}
