'use client';
/**
 * "Stop this plan" for the plan's owner (M2-03): asks first, queues the stop for the worker (which
 * redeems a yield plan's position), polls the job and refreshes the page with the result.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { translate, type Lang } from '../../lib/i18n/translate';
import { Icon } from '../Icon';

export function StopPlan({
  planId,
  lang,
  yieldPlan,
}: {
  planId: string;
  lang: Lang;
  yieldPlan: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<'idle' | 'asking' | 'queued' | 'done' | 'failed'>('idle');
  const [error, setError] = useState('');
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(lang, key, params);

  async function stop() {
    setPhase('queued');
    try {
      const res = await fetch(`/api/plans/${planId}/stop`, { method: 'POST' });
      const body = (await res.json()) as { jobId?: string; error?: { message: string } };
      if (!res.ok || !body.jobId) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const job = (await (
          await fetch(`/api/jobs/${body.jobId}`, { cache: 'no-store' })
        ).json()) as {
          status: string;
          error: string | null;
        };
        if (job.status === 'done') {
          setPhase('done');
          router.refresh();
          return;
        }
        if (job.status === 'failed') throw new Error(job.error ?? 'failed');
      }
      throw new Error('timeout');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  }

  if (phase === 'done') {
    return (
      <p className="notice ok" role="status">
        <Icon name="check" size={16} />
        <span>{t('plan.stop.done')}</span>
      </p>
    );
  }
  if (phase === 'queued') {
    return (
      <p className="notice info" role="status">
        <span className="spinner" />
        <span>{t('plan.stop.queued')}</span>
      </p>
    );
  }
  return (
    <div className="stop-plan">
      {yieldPlan ? <p className="panel-note">{t('judge.stop.yield.note')}</p> : null}
      {phase === 'asking' ? (
        <div className="stop-confirm">
          <strong>{t('plan.stop.confirm')}</strong>
          <div className="button-row">
            <button type="button" className="button danger" onClick={() => void stop()}>
              {t('judge.stop.cta')}
            </button>
            <button type="button" className="button secondary" onClick={() => setPhase('idle')}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="button danger" onClick={() => setPhase('asking')}>
          {t('judge.stop.cta')}
        </button>
      )}
      {phase === 'failed' ? (
        <p className="notice fail" role="alert">
          <Icon name="x" size={16} />
          <span>{t('judge.job.failed', { reason: error })}</span>
        </p>
      ) : null}
    </div>
  );
}
