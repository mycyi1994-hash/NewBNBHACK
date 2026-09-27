/**
 * An error written for the person who asked — a judge's job, an operator's command — and shown
 * to them as it is. Any other error's message can carry a database host, an RPC URL or a key: a
 * job that fails with one shows a fixed label, and the message stays in the worker's log.
 */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicError';
  }
}

/** What a failed job shows when its error was not written for the caller. */
export const JOB_FAILED_LABEL = 'the worker could not finish this job';

export function publicMessage(error: unknown): string {
  return error instanceof PublicError ? error.message : JOB_FAILED_LABEL;
}
