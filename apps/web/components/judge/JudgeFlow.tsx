'use client';
/**
 * Judge Mode steps (DESIGN_BRIEF §5.2): ① code ② stock ③ how & how much ④ preview (a dry run by
 * the worker) ⑤ run ⑥ receipt. Every state shown comes from an API answer; while the worker
 * works the page says so and waits — nothing is ticked off before it happened.
 */
import Link from 'next/link';
import { useState } from 'react';
import { displayParams, money, sharesText, timeText } from '../../lib/format';
import {
  isCopyKey,
  translate,
  type CopyKey,
  type Lang,
  type Params,
} from '../../lib/i18n/translate';
import { StopPlan } from '../plan/StopPlan';
import { RiskText } from '../RiskText';
import { buttonClass, Pill } from '../ui';

export interface Venue {
  ticker: string;
  issuer: string;
  symbol: string;
  address: string;
  venueMinUsd: string | null;
  reasonCode: string | null;
}

interface Market {
  session: string;
  regularClose: string | null;
  nextBuyWindow: string;
  nextRegularOpen: string;
}

type Step = 'code' | 'pick' | 'mode' | 'preview' | 'run' | 'done';
const STEPS: Step[] = ['code', 'pick', 'mode', 'preview', 'run', 'done'];

interface Why {
  key: string;
  params: Record<string, string>;
}
interface Outcome {
  kind: 'BOUGHT' | 'DEFERRED' | 'SKIPPED' | 'FAILED';
  spendUsd?: string;
  shares?: string;
  interestUsd?: string | null;
  code?: string;
  message?: string;
}
interface JobResult {
  status: string;
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
    swapSimulation: { status: string; failReason: string };
  };
  depositedUsd?: string;
}
interface Job {
  status: 'queued' | 'running' | 'done' | 'failed';
  result: JobResult | null;
  error: string | null;
}
interface Problem {
  error?: { code: string; message: string };
  reason?: string;
}

const units = (value: string) => {
  const [whole = '0', frac = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
};

async function post(
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & Problem }> {
  const res = await fetch(url, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & Problem;
  return { status: res.status, body: json };
}

async function waitForJob(jobId: string): Promise<Job> {
  for (let i = 0; i < 120; i++) {
    const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
    const job = (await res.json()) as Job;
    if (job.status === 'done' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: 'failed', result: null, error: 'timeout' };
}

export function JudgeFlow({
  lang,
  tz,
  capUsd,
  minBuyUsd,
  market,
  venues,
  session,
  risk,
}: {
  lang: Lang;
  tz: string;
  capUsd: string;
  minBuyUsd: string;
  market: Market;
  venues: Venue[];
  session: { remainingUsd: string } | null;
  risk: { apy: string | null; score: string | null };
}) {
  const t = (key: CopyKey, params?: Params) => translate(lang, key, params);
  const [step, setStep] = useState<Step>(session ? 'pick' : 'code');
  const [remaining, setRemaining] = useState<string | null>(session?.remainingUsd ?? null);
  const [code, setCode] = useState('');
  const [ticker, setTicker] = useState<string | null>(null);
  const [mode, setMode] = useState<'safe' | 'yield'>('safe');
  const [riskOpen, setRiskOpen] = useState(false);
  const [riskChecked, setRiskChecked] = useState(false);
  const [amount, setAmount] = useState(capUsd);
  const [window, setWindow] = useState<'regular_session' | 'anytime'>('regular_session');
  const [planId, setPlanId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<JobResult | null>(null);
  const [result, setResult] = useState<{ job: Job; ranAt: string } | null>(null);

  const closed = market.session !== 'regular';
  const issuerOrder = ['bstocks', 'ondo'];
  const tickers = [...new Set(venues.map((v) => v.ticker))];
  const venuesOf = (tk: string) =>
    issuerOrder.flatMap((issuer) => venues.filter((v) => v.ticker === tk && v.issuer === issuer));
  const usable = (tk: string, usd: string) =>
    venuesOf(tk).find((v) => v.venueMinUsd === null || units(usd) >= units(v.venueMinUsd));

  const problemText = (status: number, body: Problem): string => {
    const code = body.error?.code;
    if (status === 429) return t('judge.error.rate_limited');
    if (code === 'bad_code') return t('judge.code.error.bad');
    if (code === 'code_exhausted') return t('judge.code.error.exhausted');
    if (status === 503) return t('judge.error.unavailable', { reason: body.reason ?? '' });
    return t('judge.error.generic', { reason: body.error?.message ?? `HTTP ${status}` });
  };
  const why = (w: Why | undefined) => {
    if (!w || !isCopyKey(w.key)) return null;
    const params = displayParams(w.params, lang, tz);
    if (params.rule && isCopyKey(`guardian.rule.${params.rule}`)) {
      params.rule = t(`guardian.rule.${params.rule}` as CopyKey);
    }
    return t(w.key, params);
  };

  async function checkCode() {
    setBusy(true);
    setError(null);
    const res = await post('/api/judge/session', { code });
    setBusy(false);
    if (res.status !== 200) return setError(problemText(res.status, res.body));
    if (res.body.exhausted === true) return setError(t('judge.code.error.exhausted'));
    setRemaining(String(res.body.remainingUsd));
    setStep('pick');
  }

  async function createPlan() {
    if (!ticker) return;
    setBusy(true);
    setError(null);
    const res = await post('/api/plans', { ticker, mode, amountUsd: amount, window });
    setBusy(false);
    if (res.status === 401) {
      setStep('code');
      return setError(t('judge.code.title'));
    }
    if (res.status !== 201) return setError(problemText(res.status, res.body));
    const plan = res.body.plan as { id: string };
    setPlanId(plan.id);
    setPreview(null);
    setStep('preview');
    if (mode === 'safe') await runPreview(plan.id);
  }

  async function runPreview(id: string) {
    setBusy(true);
    setError(null);
    const res = await post(`/api/plans/${id}/preview`);
    if (res.status !== 202) {
      setBusy(false);
      return setError(problemText(res.status, res.body));
    }
    const job = await waitForJob(String(res.body.jobId));
    setBusy(false);
    if (job.status === 'failed' || !job.result) {
      return setError(t('judge.job.failed', { reason: job.error ?? '' }));
    }
    setPreview(job.result);
  }

  async function run() {
    if (!planId) return;
    setStep('run');
    setError(null);
    const res = await post(
      `/api/plans/${planId}/run`,
      mode === 'yield' ? { depositUsd: amount } : undefined,
    );
    if (res.status !== 202) {
      setStep('preview');
      return setError(problemText(res.status, res.body));
    }
    const job = await waitForJob(String(res.body.jobId));
    setResult({ job, ranAt: new Date().toISOString() });
    setStep('done');
  }

  const amountValid = (() => {
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) return false;
    const u = units(amount);
    return u > 0n && u <= units(capUsd) && (mode === 'yield' || u >= units(minBuyUsd));
  })();
  // Off-hours an anytime plan buys half of the amount chosen here; when half is under the minimum
  // buy it waits for the open like a regular-session plan (DECISIONS D-22).
  const halfCents = units(amountValid ? amount : capUsd) / 2n;
  const halfUsd = `${halfCents / 100n}.${String(halfCents % 100n).padStart(2, '0')}`;
  const halfWaits = halfCents < units(minBuyUsd);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex min-w-0 flex-col gap-6">
        <ol className="flex flex-wrap gap-2 text-sm">
          {STEPS.map((s, i) => {
            const at = STEPS.indexOf(step);
            return (
              <li
                key={s}
                aria-current={s === step ? 'step' : undefined}
                className={`rounded-full px-3 py-1 font-medium ${
                  i < at
                    ? 'bg-brand-soft text-ok'
                    : s === step
                      ? 'bg-ink text-white'
                      : 'bg-white text-muted'
                }`}
              >
                {i + 1}. {t(`judge.step.${s}`)}
              </li>
            );
          })}
        </ol>

        {error ? (
          <p
            role="alert"
            className="rounded-xl bg-fail-soft px-4 py-3 text-sm font-medium text-fail"
          >
            {error}
          </p>
        ) : null}

        {step === 'code' ? (
          <section className="rounded-2xl border border-line bg-white p-6">
            <h1 className="text-2xl font-extrabold">{t('judge.code.title')}</h1>
            <form
              className="mt-4 flex flex-col gap-3 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void checkCode();
              }}
            >
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                aria-label={t('judge.code.title')}
                className="min-w-0 flex-1 rounded-xl border border-line px-4 py-3 text-base"
              />
              <button
                type="submit"
                disabled={busy || code.trim() === ''}
                className={buttonClass.primary}
              >
                {t('common.confirm')}
              </button>
            </form>
            <p className="mt-3 text-sm text-muted">
              {t('judge.code.hint', { cap: money(capUsd) })}
            </p>
          </section>
        ) : null}

        {step === 'pick' ? (
          <section className="rounded-2xl border border-line bg-white p-6">
            <h1 className="text-2xl font-extrabold">{t('judge.pick.title')}</h1>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tickers.map((tk) => {
                const venue = usable(tk, capUsd);
                const ondoMin = venuesOf(tk).find((v) => v.issuer === 'ondo')?.venueMinUsd;
                return (
                  <button
                    key={tk}
                    type="button"
                    disabled={!venue}
                    onClick={() => setTicker(tk)}
                    aria-pressed={ticker === tk}
                    className={`rounded-2xl border p-4 text-left disabled:cursor-not-allowed disabled:opacity-60 ${
                      ticker === tk
                        ? 'border-brand ring-2 ring-brand'
                        : 'border-line hover:border-muted'
                    }`}
                  >
                    <div className="text-lg font-bold">{tk}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {venuesOf(tk).map((v) => (
                        <Pill key={v.issuer} tone="neutral" icon={false}>
                          {v.issuer === 'bstocks' ? 'bStocks' : 'Ondo'}
                        </Pill>
                      ))}
                    </div>
                    {!venue && ondoMin ? (
                      <p className="mt-2 text-xs text-wait">
                        {t('judge.pick.venue_min', { min: ondoMin, cap: money(capUsd) })}
                      </p>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {ticker ? (
              <p className="mt-3 text-sm text-muted">
                {t('judge.pick.issuer.auto', {
                  issuer: usable(ticker, capUsd)?.issuer === 'bstocks' ? 'bStocks' : 'Ondo',
                })}
              </p>
            ) : null}
            <button
              type="button"
              disabled={!ticker}
              onClick={() => setStep('mode')}
              className={`${buttonClass.primary} mt-5`}
            >
              {t('common.confirm')}
            </button>
          </section>
        ) : null}

        {step === 'mode' ? (
          <section className="flex flex-col gap-5 rounded-2xl border border-line bg-white p-6">
            <div className="grid gap-3 sm:grid-cols-2">
              {(['safe', 'yield'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() =>
                    m === 'yield' && mode !== 'yield' ? setRiskOpen(true) : setMode(m)
                  }
                  className={`rounded-2xl border p-4 text-left ${
                    mode === m ? 'border-brand ring-2 ring-brand' : 'border-line hover:border-muted'
                  }`}
                >
                  <div className="font-bold">
                    {t(m === 'safe' ? 'judge.mode.safe' : 'judge.mode.yield')}
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {t(m === 'safe' ? 'judge.mode.safe.desc' : 'judge.mode.yield.desc')}
                  </p>
                </button>
              ))}
            </div>

            <div>
              <div className="font-semibold">
                {t(mode === 'yield' ? 'judge.yield.amount' : 'judge.amount.label')}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {[...new Set(['2.50', capUsd])].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={amount === preset}
                    onClick={() => setAmount(preset)}
                    className={`num rounded-xl border px-4 py-2 font-semibold ${
                      amount === preset ? 'border-brand bg-brand-soft text-ok' : 'border-line'
                    }`}
                  >
                    ${money(preset)}
                  </button>
                ))}
                <label className="flex items-center gap-2 text-sm text-muted">
                  {t('judge.amount.custom')}
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.trim())}
                    className="num w-24 rounded-xl border border-line px-3 py-2 text-base text-ink"
                  />
                </label>
              </div>
              {mode === 'yield' ? (
                <p className="mt-2 text-sm text-muted">{t('judge.yield.note')}</p>
              ) : null}
            </div>

            {mode === 'safe' ? (
              <div className="flex flex-col gap-2">
                {(['regular_session', 'anytime'] as const).map((w) => (
                  <label
                    key={w}
                    className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3"
                  >
                    <input
                      type="radio"
                      name="window"
                      checked={window === w}
                      onChange={() => setWindow(w)}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium">
                        {t(
                          w === 'regular_session' ? 'judge.window.regular' : 'judge.window.anytime',
                        )}
                      </span>
                      {closed ? (
                        <span className="block text-sm text-muted">
                          {w === 'regular_session' || halfWaits
                            ? t('judge.window.regular.closed', {
                                open: timeText(market.nextBuyWindow, lang, tz),
                              })
                            : t('judge.window.anytime.closed', { half: money(halfUsd) })}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setStep('pick')}
                className={buttonClass.secondary}
              >
                {t('common.back')}
              </button>
              <button
                type="button"
                disabled={!amountValid || busy}
                onClick={() => void createPlan()}
                className={buttonClass.primary}
              >
                {mode === 'yield' ? t('common.confirm') : t('judge.preview.cta')}
              </button>
            </div>
          </section>
        ) : null}

        {step === 'preview' ? (
          <section className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-6">
            <h1 className="text-2xl font-extrabold">{t('judge.preview.title')}</h1>
            {mode === 'yield' ? (
              <p className="text-lg">{t('judge.preview.deposit', { usd: money(amount) })}</p>
            ) : busy ? (
              <p className="text-muted">{t('judge.preview.waiting')}</p>
            ) : preview ? (
              <PreviewResult t={t} result={preview} ticker={ticker ?? ''} why={why} />
            ) : null}
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setStep('mode')}
                className={buttonClass.secondary}
              >
                {t('common.back')}
              </button>
              {mode === 'safe' &&
              !busy &&
              planId &&
              (!preview || preview.status !== 'simulated') ? (
                <button
                  type="button"
                  onClick={() => void runPreview(planId)}
                  className={buttonClass.secondary}
                >
                  {t('common.retry')}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy || (mode === 'safe' && !preview)}
                onClick={() => void run()}
                className={buttonClass.primary}
              >
                {t('judge.run.cta')}
              </button>
            </div>
          </section>
        ) : null}

        {step === 'run' ? (
          <section className="rounded-2xl border border-line bg-white p-6">
            <p className="text-lg font-semibold">{t('judge.run.waiting')}</p>
            <ol className="mt-3 list-decimal pl-5 text-muted">
              {(mode === 'safe'
                ? ([
                    'judge.run.progress.approve',
                    'judge.run.progress.swap',
                    'judge.run.progress.confirm',
                  ] as const)
                : (['judge.run.progress.approve', 'judge.run.progress.confirm'] as const)
              ).map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ol>
          </section>
        ) : null}

        {step === 'done' && result ? (
          <Done
            t={t}
            lang={lang}
            planId={planId}
            mode={mode}
            ticker={ticker ?? ''}
            job={result.job}
            why={why}
          />
        ) : null}
      </div>

      <aside className="h-fit rounded-2xl border border-line bg-white p-5 lg:sticky lg:top-24">
        <h2 className="font-bold">{t('judge.summary.title')}</h2>
        <dl className="num mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted">{t('judge.step.pick')}</dt>
          <dd>{ticker ?? '—'}</dd>
          <dt className="text-muted">{t('judge.step.mode')}</dt>
          <dd>
            {t(mode === 'safe' ? 'judge.mode.safe' : 'judge.mode.yield')} · ${money(amount) ?? '—'}
          </dd>
          <dt className="text-muted">{t('judge.summary.window')}</dt>
          <dd>
            {t(
              window === 'regular_session' ? 'plan.window.regular_session' : 'plan.window.anytime',
            )}
          </dd>
        </dl>
        <p className="mt-4 text-sm text-muted">{t('judge.code.hint', { cap: money(capUsd) })}</p>
        {remaining !== null ? (
          <p className="num mt-2 text-sm font-medium">
            {t('judge.code.remaining', { remaining: money(remaining) })}
          </p>
        ) : null}
      </aside>

      {riskOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="risk-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
        >
          <div className="max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-2xl bg-white p-6">
            <h2 id="risk-title" className="text-xl font-bold">
              {t('nav.risk')}
            </h2>
            <RiskText lang={lang} apy={risk.apy} score={risk.score} />
            <label className="mt-4 flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={riskChecked}
                onChange={(e) => setRiskChecked(e.target.checked)}
              />
              {t('judge.risk.check')}
            </label>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  setRiskOpen(false);
                  setRiskChecked(false);
                }}
                className={buttonClass.secondary}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={!riskChecked}
                onClick={() => {
                  setMode('yield');
                  setRiskOpen(false);
                }}
                className={buttonClass.primary}
              >
                {t('risk.cta')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PreviewResult({
  t,
  result,
  ticker,
  why,
}: {
  t: (key: CopyKey, params?: Params) => string;
  result: JobResult;
  ticker: string;
  why: (w: Why | undefined) => string | null;
}) {
  if (result.status === 'simulated' && result.buy) {
    const ok = result.buy.swapSimulation.status === 'SUCCESS';
    return (
      <div className="flex flex-col gap-3">
        <p className="text-lg">
          {t('judge.preview.line', {
            usd: money(result.buy.spendUsd),
            ticker,
            shares: sharesText(result.buy.expectedShares),
          })}
        </p>
        {ok ? (
          <Pill tone="ok">{t('judge.preview.simulated')}</Pill>
        ) : (
          <Pill tone="fail">
            {t('judge.preview.failed', { reason: result.buy.swapSimulation.failReason })}
          </Pill>
        )}
        <details className="rounded-xl bg-canvas p-3 text-sm">
          <summary className="cursor-pointer font-medium">{t('common.details')}</summary>
          <dl className="num mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">{t('judge.details.issuer')}</dt>
            <dd>{result.buy.instrumentId.split(':')[1]}</dd>
            <dt className="text-muted">{t('judge.details.pieces')}</dt>
            <dd>{result.buy.expectedTokens ?? '—'}</dd>
            <dt className="text-muted">{t('judge.details.min')}</dt>
            <dd>{result.buy.minReceive ?? '—'}</dd>
          </dl>
        </details>
      </div>
    );
  }
  if (result.status === 'done' && result.outcome) {
    return (
      <div className="flex flex-col gap-2">
        <Pill
          tone={
            result.outcome.kind === 'DEFERRED'
              ? 'wait'
              : result.outcome.kind === 'FAILED'
                ? 'fail'
                : 'skip'
          }
        >
          {t(`outcome.${result.outcome.kind}`)}
        </Pill>
        <p className="text-lg">{why(result.why)}</p>
      </div>
    );
  }
  return <p className="text-muted">{t('judge.job.failed', { reason: result.status })}</p>;
}

function Done({
  t,
  lang,
  planId,
  mode,
  ticker,
  job,
  why,
}: {
  t: (key: CopyKey, params?: Params) => string;
  lang: Lang;
  planId: string | null;
  mode: 'safe' | 'yield';
  ticker: string;
  job: Job;
  why: (w: Why | undefined) => string | null;
}) {
  const r = job.result;
  const planLink = planId ? (
    <Link href={`/plans/${planId}`} className="font-medium text-brand hover:underline">
      {t('judge.plan.link')}
    </Link>
  ) : null;
  const stop = planId ? (
    <StopPlan planId={planId} lang={lang} yieldPlan={mode === 'yield'} />
  ) : null;
  const receipts = (r?.txHashes ?? []).map((hash) => (
    <a
      key={hash}
      href={`https://bscscan.com/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-brand hover:underline"
    >
      {t('receipt.view')}
    </a>
  ));
  let body;
  if (job.status === 'failed' || !r) {
    body = <p className="text-fail">{t('judge.job.failed', { reason: job.error ?? '' })}</p>;
  } else if (r.status === 'done' && r.outcome?.kind === 'BOUGHT') {
    body = (
      <>
        <h1 className="text-3xl font-extrabold text-ok">✓ {t('judge.done.title')}</h1>
        <p className="num text-lg">
          {
            // The line ends in "· 영수증 보기", which is the receipt link below.
            t('judge.done.line', {
              ticker,
              shares: sharesText(r.outcome.shares),
              usd: money(r.outcome.spendUsd),
            }).split(' · ')[0]
          }
        </p>
        <p className="text-muted">{why(r.why)}</p>
        <div className="flex flex-wrap gap-3">{receipts}</div>
        <p className="text-sm text-muted">{t('judge.done.plan_note')}</p>
      </>
    );
  } else if (r.status === 'done' && r.outcome) {
    body = (
      <>
        <Pill
          tone={
            r.outcome.kind === 'DEFERRED' ? 'wait' : r.outcome.kind === 'FAILED' ? 'fail' : 'skip'
          }
        >
          {t(`outcome.${r.outcome.kind}`)}
        </Pill>
        <p className="text-lg">{why(r.why)}</p>
        {r.outcome.kind === 'DEFERRED' ? (
          <p className="text-sm text-muted">{t('judge.done.deferred_note')}</p>
        ) : null}
      </>
    );
  } else if (r.status === 'deposited') {
    body = (
      <>
        <h1 className="text-3xl font-extrabold text-ok">
          ✓ {t('judge.done.deposited', { usd: money(r.depositedUsd) })}
        </h1>
        <div className="flex flex-wrap gap-3">{receipts}</div>
      </>
    );
  } else if (r.status === 'simulated') {
    body = <p className="text-lg">{t('judge.done.simulated')}</p>;
  } else if (r.status === 'awaiting_tx') {
    body = <p className="text-lg">{t('judge.done.confirming')}</p>;
  } else {
    body = <p className="text-fail">{t('judge.job.failed', { reason: r.status })}</p>;
  }
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-6">
      {body}
      {planLink}
      {stop}
    </section>
  );
}
