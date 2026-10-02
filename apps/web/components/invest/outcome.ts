/**
 * What a Judge Mode run came back with, in words (M2-02): bought, deposited, dry-run, waiting, or
 * why not — for every answer the worker gives, the rare ones included. Pure, so each one is
 * tested (test/outcome.test.ts). Nothing here promises what did not happen: a plan that did not
 * start is never said to try again, and a dry run says what its simulation found.
 */
import { money, sharesText } from '../../lib/format';
import type { CopyKey, Params } from '../../lib/i18n/translate';

export interface Why {
  key: string;
  params: Record<string, string>;
}

export interface Outcome {
  kind: 'BOUGHT' | 'DEFERRED' | 'SKIPPED' | 'FAILED';
  spendUsd?: string;
  shares?: string;
  interestUsd?: string | null;
  code?: string;
  message?: string;
}

export interface Simulation {
  status: string;
  failReason: string;
}

export interface JobResult {
  status: string;
  cycleId?: number;
  outcome?: Outcome;
  why?: Why;
  txHashes?: string[];
  txHash?: string;
  buy?: {
    spendUsd: string;
    expectedShares: string | null;
    expectedTokens: string | null;
    minReceive: string | null;
    instrumentId: string;
    swapSimulation: Simulation;
    /** How the dry run got its allowance: already on chain, or only simulated. */
    approval?: 'existing_allowance' | 'simulated';
  };
  /** A yield deposit's dry run: its exact approval (or the allowance already there), its deposit. */
  approve?: Simulation | 'existing_allowance';
  deposit?: Simulation;
  depositedUsd?: string;
  /** The plan's status once the run is over: `active` when it now runs on its own. */
  planStatus?: string | null;
}

export interface Job {
  status: 'queued' | 'running' | 'done' | 'failed';
  result: JobResult | null;
  error: string | null;
}

export type Tone = 'ok' | 'wait' | 'fail' | 'info';

export interface DoneText {
  title: string;
  lead: string | null;
  tone: Tone;
  note: string | null;
}

type Translate = (key: CopyKey, params?: Params) => string;

/** Nothing was signed (or only an exact approval): the same plan may simply be run again. */
export function retryable(job: Job): boolean {
  const status = job.result?.status;
  return (
    job.status === 'done' &&
    (status === 'approval_pending' || status === 'outbox_busy' || status === 'locked')
  );
}

/** A dry run's "exceeds allowance": the expected answer while the approval is only simulated. */
const APPROVAL_FIRST = /exceeds allowance/i;

export function doneText(
  t: Translate,
  ticker: string,
  job: Job,
  why: (w: Why | undefined) => string | null,
): DoneText {
  // The page stopped waiting, the worker has not finished: it may still run.
  if (job.status === 'queued' || job.status === 'running') {
    return {
      title: t('outcome.running'),
      lead: t('judge.job.still_queued'),
      tone: 'wait',
      note: null,
    };
  }
  const r = job.result;
  if (job.status === 'failed' || !r) {
    return {
      title: t('outcome.FAILED'),
      lead: t('judge.job.failed', { reason: job.error ?? '' }),
      tone: 'fail',
      note: null,
    };
  }
  if (r.status === 'done' && r.outcome?.kind === 'BOUGHT') {
    return {
      title: t('judge.done.title'),
      // The reason line says what was bought and when; without one, the done line does (it ends
      // in "· View receipt", which is the receipt link below).
      lead:
        why(r.why) ??
        t('judge.done.line', {
          ticker,
          shares: sharesText(r.outcome.shares),
          usd: money(r.outcome.spendUsd),
        }).split(' · ')[0] ??
        null,
      tone: 'ok',
      note: null,
    };
  }
  if (r.status === 'done' && r.outcome) {
    const deferred = r.outcome.kind === 'DEFERRED';
    return {
      title: t(`outcome.${r.outcome.kind}`),
      lead: why(r.why),
      tone: deferred ? 'wait' : r.outcome.kind === 'FAILED' ? 'fail' : 'info',
      // "When it buys…" holds only for a plan that now runs on its own (a simulate-mode server
      // never starts one).
      note: deferred
        ? t(r.planStatus === 'active' ? 'judge.done.deferred_note' : 'judge.done.not_started')
        : null,
    };
  }
  if (r.status === 'deposited') {
    return {
      title: t('judge.done.title'),
      lead: t('judge.done.deposited', { usd: money(r.depositedUsd) }),
      tone: 'ok',
      note: t('judge.yield.note'),
    };
  }
  if (r.status === 'simulated' && r.deposit) {
    // A yield deposit's dry run. A first deposit's exact approval is only simulated, so the
    // deposit's own simulation stops at the missing allowance: the expected answer.
    const deposit = r.deposit;
    const approvalFirst =
      deposit.status !== 'SUCCESS' &&
      r.approve !== 'existing_allowance' &&
      r.approve?.status === 'SUCCESS' &&
      APPROVAL_FIRST.test(deposit.failReason);
    if (deposit.status === 'SUCCESS' || approvalFirst) {
      return {
        title: t('outcome.simulated'),
        lead: t(
          deposit.status === 'SUCCESS'
            ? 'judge.done.deposit_simulated'
            : 'judge.done.deposit_approval_first',
        ),
        tone: 'info',
        note: null,
      };
    }
    return {
      title: t('outcome.simulated'),
      lead: t('judge.preview.failed', { reason: deposit.failReason }),
      tone: 'fail',
      note: null,
    };
  }
  if (r.status === 'simulated') {
    return {
      title: t('outcome.simulated'),
      lead: t('judge.done.simulated'),
      tone: 'info',
      note: null,
    };
  }
  if (r.status === 'awaiting_tx') {
    return {
      title: t('outcome.running'),
      lead: t('judge.done.confirming'),
      tone: 'wait',
      note: null,
    };
  }
  if (r.status === 'approval_pending') {
    return {
      title: t('outcome.running'),
      lead: t('judge.done.approval_pending'),
      tone: 'wait',
      note: null,
    };
  }
  if (r.status === 'outbox_busy' || r.status === 'locked') {
    return {
      title: t('outcome.DEFERRED'),
      lead: t(r.status === 'outbox_busy' ? 'judge.done.outbox_busy' : 'judge.done.locked'),
      tone: 'wait',
      note: null,
    };
  }
  if (r.status === 'review') {
    return {
      title: t('plan.status.paused'),
      lead: t('judge.done.review'),
      tone: 'fail',
      note: null,
    };
  }
  if (r.status === 'stopped') {
    return {
      title: t('plan.status.stopped'),
      lead: t('judge.done.stopped'),
      tone: 'info',
      note: null,
    };
  }
  return {
    title: t('outcome.FAILED'),
    lead: t('judge.job.failed', { reason: r.status }),
    tone: 'fail',
    note: null,
  };
}
