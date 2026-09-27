/**
 * Pages render every block they can: a failed read becomes that block's UNAVAILABLE state with a
 * short reason (CLAUDE.md rule 4), never a crashed page or a made-up value. The public reason is
 * a label ("database unavailable"); the real error goes to the server log only, since messages
 * can carry hosts and ports.
 */
export type Settled<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function settle<T>(label: string, work: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    console.error(`web: ${label} read failed —`, error instanceof Error ? error.message : error);
    return { ok: false, reason: `${label} unavailable` };
  }
}
