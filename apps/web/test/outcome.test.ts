/**
 * Judge Mode's done state in words (components/invest/outcome.ts, M2-02): every answer the worker
 * gives reads as what happened — never a code, never a promise the server will not keep.
 */
import { describe, expect, it } from 'vitest';
import { doneText, retryable, type Job, type JobResult } from '../components/invest/outcome';
import { makeT } from '../lib/i18n/translate';

const t = makeT('en');
const why = () => null;
const done = (result: JobResult): Job => ({ status: 'done', result, error: null });
const text = (job: Job) => doneText(t, 'NVDA', job, why);

describe('Judge Mode done text', () => {
  it('says a job the page stopped waiting for may still run, and offers no retry', () => {
    for (const status of ['queued', 'running'] as const) {
      const job: Job = { status, result: null, error: null };
      expect(text(job)).toMatchObject({ tone: 'wait', lead: t('judge.job.still_queued') });
      expect(retryable(job)).toBe(false);
    }
  });

  it('promises a later buy only for a plan that now runs on its own', () => {
    const deferred = (planStatus: string) =>
      done({ status: 'done', outcome: { kind: 'DEFERRED' }, planStatus });
    expect(text(deferred('active')).note).toBe(t('judge.done.deferred_note'));
    // A simulate-mode server never starts the plan: it will not try again at the open.
    expect(text(deferred('paused')).note).toBe(t('judge.done.not_started'));
  });

  it('shows what a yield deposit’s dry run found', () => {
    const ok = { status: 'SUCCESS', failReason: '' };
    const allowance = {
      status: 'FAILED',
      failReason: 'execution reverted: BEP20: transfer amount exceeds allowance',
    };
    const paused = { status: 'FAILED', failReason: 'execution reverted: mint is paused' };
    const deposit = (approve: JobResult['approve'], dep: { status: string; failReason: string }) =>
      text(done({ status: 'simulated', approve, deposit: dep }));
    expect(deposit(ok, ok)).toMatchObject({
      tone: 'info',
      lead: t('judge.done.deposit_simulated'),
    });
    // The approval only simulated: the deposit stops at the allowance, as expected.
    expect(deposit(ok, allowance)).toMatchObject({
      tone: 'info',
      lead: t('judge.done.deposit_approval_first'),
    });
    // With the allowance already on chain, "exceeds allowance" is a real failure.
    expect(deposit('existing_allowance', allowance)).toMatchObject({
      tone: 'fail',
      lead: t('judge.preview.failed', { reason: allowance.failReason }),
    });
    expect(deposit(ok, paused)).toMatchObject({
      tone: 'fail',
      lead: t('judge.preview.failed', { reason: paused.failReason }),
    });
  });

  it('puts every refusal of a run in words, and lets the judge run again only when nothing was signed', () => {
    const cases: [string, string, boolean][] = [
      ['approval_pending', 'judge.done.approval_pending', true],
      ['outbox_busy', 'judge.done.outbox_busy', true],
      ['locked', 'judge.done.locked', true],
      ['review', 'judge.done.review', false],
      ['stopped', 'judge.done.stopped', false],
      ['awaiting_tx', 'judge.done.confirming', false],
      ['simulated', 'judge.done.simulated', false],
    ];
    for (const [status, key, again] of cases) {
      const job = done({ status });
      const shown = text(job);
      expect(shown.lead, status).toBe(t(key as Parameters<typeof t>[0]));
      // No code on the screen: nothing like approval_pending or outbox_busy.
      expect(`${shown.title} ${shown.lead}`, status).not.toMatch(/[a-z]+_[a-z]+/);
      expect(retryable(job), status).toBe(again);
    }
    expect(retryable({ status: 'failed', result: null, error: 'x' })).toBe(false);
  });
});
