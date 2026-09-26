/**
 * The human gate for spending (CLAUDE.md rule 5, SPEC §12): a live action runs only after a
 * person types `y` at an interactive terminal. There is no flag or environment variable that
 * answers for them.
 */
import { createInterface } from 'node:readline/promises';

export async function confirmSpend(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log('refused: live execution needs an interactive terminal to type y');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `${question} Type y to sign and broadcast, anything else to stop: `,
    );
    return answer.trim() === 'y';
  } finally {
    rl.close();
  }
}
