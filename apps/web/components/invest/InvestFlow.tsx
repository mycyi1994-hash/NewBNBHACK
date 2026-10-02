'use client';
/**
 * Invest (the approved design's third tab) running Judge Mode (M2-02, DESIGN_BRIEF §5.2): a judge
 * code, a stock, how and how much, a dry run by the worker, the buy, the receipt. The API contract
 * is the one Judge Mode always used — POST /api/judge/session, /api/plans, /api/plans/{id}/preview
 * and /run, GET /api/jobs/{id} — and every state shown comes from its answers: while the worker
 * works the page says so and waits; nothing is ticked off before it happened.
 */
import Link from 'next/link';
import { useId, useState } from 'react';
import {
  displayParams,
  fromBaseUnits,
  issuerName,
  money,
  sharesText,
  timeText,
} from '../../lib/format';
import {
  isCopyKey,
  translate,
  type CopyKey,
  type Lang,
  type Params,
} from '../../lib/i18n/translate';
import { AssetBadge, Dialog, Process } from '../design';
import { Icon } from '../Icon';
import { AnimatedText } from '../motion';
import { StopPlan } from '../plan/StopPlan';
import { RiskText } from '../RiskText';
import { doneText, retryable, type Job, type JobResult, type Why } from './outcome';
import { CheckBadge, Ledger, Panel, SectionHeading, Status } from '../ui';

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

interface Problem {
  error?: { code: string; message: string };
  reason?: string;
}

type Stage = 'previewing' | 'previewed' | 'running' | 'done';

const STEPS = ['code', 'pick', 'mode', 'preview', 'run', 'done'] as const;
/** The order the approved design lists them in; anything else the registry adds comes after. */
const DISPLAY_ORDER = ['NVDA', 'TSLA', 'MSFT', 'QQQ', 'AAPL'];
const NAMES: Record<string, CopyKey> = {
  NVDA: 'stock.name.nvda',
  TSLA: 'stock.name.tsla',
  MSFT: 'stock.name.msft',
  QQQ: 'stock.name.qqq',
  AAPL: 'stock.name.aapl',
};

const units = (value: string) => {
  const [whole = '0', frac = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
};

/** Never throws: a dropped connection is an answer (status 0) the flow shows, not a stuck spinner. */
async function post(
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & Problem }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & Problem;
    return { status: res.status, body: json };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error';
    return { status: 0, body: { error: { code: 'network', message } } };
  }
}

/**
 * Polls a job until it is done or failed (four minutes at most). A poll that fails on the way — a
 * dropped connection, a gateway page instead of JSON — is tried again; the job keeps running. When
 * the page stops waiting, the job as last seen comes back (queued or running): it may still run,
 * and is never reported as failed.
 */
async function waitForJob(jobId: string): Promise<Job> {
  let last: Job = { status: 'queued', result: null, error: null };
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
      const job = (await res.json()) as Job;
      if (job.status === 'done' || job.status === 'failed') return job;
      last = job;
    } catch {
      // Transient: ask again on the next tick.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

export function InvestFlow({
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
  const issuerOrder = ['bstocks', 'ondo'];
  const tickers = [...new Set(venues.map((v) => v.ticker))].sort((a, b) => {
    const rank = (tk: string) => {
      const i = DISPLAY_ORDER.indexOf(tk);
      return i < 0 ? DISPLAY_ORDER.length : i;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const venuesOf = (tk: string) =>
    issuerOrder.flatMap((issuer) => venues.filter((v) => v.ticker === tk && v.issuer === issuer));
  const usable = (tk: string, usd: string) =>
    venuesOf(tk).find((v) => v.venueMinUsd === null || units(usd) >= units(v.venueMinUsd));

  const [remaining, setRemaining] = useState<string | null>(session?.remainingUsd ?? null);
  const [code, setCode] = useState('');
  const [ticker, setTicker] = useState<string | null>(
    () => tickers.find((tk) => usable(tk, capUsd)) ?? null,
  );
  const [mode, setMode] = useState<'safe' | 'yield'>('safe');
  const [riskOpen, setRiskOpen] = useState(false);
  const [riskChecked, setRiskChecked] = useState(false);
  const [amount, setAmount] = useState(capUsd);
  const [window, setWindow] = useState<'regular_session' | 'anytime'>('regular_session');
  const [planId, setPlanId] = useState<string | null>(null);
  // A plan the judge stopped from the done panel: it is never run again from here.
  const [stoppedPlan, setStoppedPlan] = useState<string | null>(null);
  // What the plan was created with: its runs use these, whatever the form shows since.
  const [terms, setTerms] = useState<{
    ticker: string;
    mode: 'safe' | 'yield';
    amount: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<JobResult | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [review, setReview] = useState(false);
  const [result, setResult] = useState<Job | null>(null);
  const reviewTitle = useId();
  const riskTitle = useId();

  const closed = market.session !== 'regular';
  // Yield mode hides the window choice and runs in regular hours: never a hidden "anytime".
  const planWindow = mode === 'yield' ? 'regular_session' : window;
  const problemText = (status: number, body: Problem): string => {
    const codeName = body.error?.code;
    if (status === 429) return t('judge.error.rate_limited');
    if (codeName === 'bad_code') return t('judge.code.error.bad');
    if (codeName === 'code_exhausted') return t('judge.code.error.exhausted');
    if (codeName === 'daily_cap') {
      return t('judge.error.daily_cap', { remaining: money(remaining ?? capUsd) ?? '' });
    }
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
    // The code is fine, but today's house-wide cap is spent: say so now, not after the form.
    if (res.body.dailyCapReached === true) {
      setError(
        t('judge.error.daily_cap', { remaining: money(String(res.body.remainingUsd)) ?? '' }),
      );
    }
  }

  async function runPreview(id: string) {
    setBusy(true);
    setError(null);
    setStage('previewing');
    const res = await post(`/api/plans/${id}/preview`);
    if (res.status !== 202) {
      setBusy(false);
      setStage('previewed');
      return setError(problemText(res.status, res.body));
    }
    const job = await waitForJob(String(res.body.jobId));
    setBusy(false);
    setStage('previewed');
    if (job.status === 'queued' || job.status === 'running') {
      return setError(t('judge.job.still_queued'));
    }
    if (job.status === 'failed' || !job.result) {
      return setError(t('judge.job.failed', { reason: job.error ?? '' }));
    }
    setPreview(job.result);
  }

  async function createPlan() {
    if (!ticker) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    const res = await post('/api/plans', { ticker, mode, amountUsd: amount, window: planWindow });
    setBusy(false);
    if (res.status === 401) {
      setRemaining(null);
      return setError(t('judge.code.title'));
    }
    if (res.status !== 201) return setError(problemText(res.status, res.body));
    const plan = res.body.plan as { id: string };
    setPlanId(plan.id);
    setTerms({ ticker, mode, amount });
    setResult(null);
    setReview(true);
    setStage('previewed');
    if (mode === 'safe') await runPreview(plan.id);
  }

  async function run() {
    if (!planId) return;
    setStage('running');
    setBusy(true);
    setError(null);
    const plan = terms ?? { mode, amount };
    const res = await post(
      `/api/plans/${planId}/run`,
      plan.mode === 'yield' ? { depositUsd: plan.amount } : undefined,
    );
    if (res.status !== 202) {
      setBusy(false);
      setStage('previewed');
      return setError(problemText(res.status, res.body));
    }
    const job = await waitForJob(String(res.body.jobId));
    setBusy(false);
    setResult(job);
    setStage('done');
    // What the code has left: the server's figure less what the worker reports — a buy (the spend
    // ledger) or a deposit (principal counts towards the code's cap too).
    const spent =
      job.result?.outcome?.kind === 'BOUGHT'
        ? job.result.outcome.spendUsd
        : job.result?.depositedUsd;
    if (spent && /^\d+(\.\d+)?$/.test(spent)) {
      setRemaining((left) => {
        if (left === null) return left;
        const cents = units(left) - units(spent);
        const kept = cents > 0n ? cents : 0n;
        return `${kept / 100n}.${String(kept % 100n).padStart(2, '0')}`;
      });
    }
  }

  // A deposit whose exact approval was still confirming goes on from it with the same plan: a new
  // plan would leave this one waiting for its first run for good. The form shows the plan's own
  // terms again, so the dialog says what the run sends.
  const retry =
    !busy && result && retryable(result) && stoppedPlan !== planId
      ? () => {
          if (terms) {
            setTicker(terms.ticker);
            setMode(terms.mode);
            setAmount(terms.amount);
          }
          setReview(true);
          void run();
        }
      : undefined;

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

  const hasSession = remaining !== null;
  const funding = mode === 'safe' ? t('invest.funding.contribution') : t('invest.funding.interest');
  const windowText = t(
    planWindow === 'regular_session' ? 'plan.window.regular_session' : 'plan.window.anytime',
  );
  const step = !hasSession
    ? 0
    : !ticker
      ? 1
      : result
        ? STEPS.length
        : stage === 'running'
          ? 4
          : review
            ? 3
            : 2;
  const disabledNote = tickers
    .filter((tk) => !usable(tk, capUsd))
    .map((tk) => {
      const ondoMin = venuesOf(tk).find((v) => v.issuer === 'ondo')?.venueMinUsd;
      return ondoMin
        ? `${tk}: ${t('judge.pick.venue_min', { min: ondoMin, cap: money(capUsd) })}`
        : null;
    })
    .filter(Boolean);

  const amountShown = money(amountValid ? amount : null);
  return (
    <>
      <section className="summary-strip" aria-label={t('invest.summary')}>
        <div className="summary-stat">
          <span>{t('invest.funding')}</span>
          <strong>
            <AnimatedText value={funding} />
          </strong>
        </div>
        <div className="summary-stat">
          <span>{t(mode === 'yield' ? 'judge.yield.amount' : 'judge.amount.label')}</span>
          <strong>
            <AnimatedText value={amountShown ?? '—'} /> <small>USDT</small>
          </strong>
        </div>
        <div className="summary-stat">
          <span>{t('invest.limit')}</span>
          <strong>
            <AnimatedText value={money(remaining ?? capUsd) ?? '—'} /> <small>USDT</small>
          </strong>
          <small className="summary-note">
            {hasSession ? t('invest.limit.left') : t('judge.code.hint', { cap: money(capUsd) })}
          </small>
        </div>
        <div className="summary-status">
          <Status tone={closed ? 'neutral' : 'ok'}>
            {t('invest.when', { window: windowText })}
          </Status>
        </div>
      </section>

      <div className={`workspace-grid invest-grid ${hasSession ? '' : 'needs-code'}`}>
        <section className="visual-workspace investment-workspace">
          <SectionHeading
            title={mode === 'yield' ? t('invest.title.interest') : t('invest.title.contribution')}
            sub={t('invest.sub')}
          />
          <div className="segmented-control" role="group" aria-label={t('invest.funding')}>
            {(['safe', 'yield'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                disabled={busy}
                onClick={() => (m === 'yield' && mode !== 'yield' ? setRiskOpen(true) : setMode(m))}
              >
                {t(m === 'safe' ? 'judge.mode.safe' : 'judge.mode.yield')}
              </button>
            ))}
          </div>
          <p className="field-note">
            {t(mode === 'safe' ? 'judge.mode.safe.desc' : 'judge.mode.yield.desc')}
          </p>

          <div className="asset-options" role="group" aria-label={t('judge.pick.title')}>
            {tickers.map((tk) => {
              const venue = usable(tk, capUsd);
              const nameKey = NAMES[tk];
              return (
                <button
                  className={`asset-option ${ticker === tk ? 'selected' : ''}`}
                  key={tk}
                  type="button"
                  disabled={!venue || busy}
                  aria-pressed={ticker === tk}
                  onClick={() => setTicker(tk)}
                >
                  {ticker === tk ? (
                    <span className="asset-selected">
                      <Icon name="check" size={14} />
                    </span>
                  ) : null}
                  <AssetBadge ticker={tk} />
                  <strong>{tk}</strong>
                  <span>
                    {nameKey
                      ? t(nameKey)
                      : venuesOf(tk)
                          .map((v) => (v.issuer === 'bstocks' ? 'bStocks' : 'Ondo'))
                          .join(' · ')}
                  </span>
                </button>
              );
            })}
          </div>
          {ticker ? (
            <p className="issuer-line">
              {t('judge.pick.issuer.auto', {
                issuer: usable(ticker, capUsd)?.issuer === 'bstocks' ? 'bStocks' : 'Ondo',
              })}
            </p>
          ) : null}
          {disabledNote.map((note) => (
            <p className="asset-note" key={note}>
              {note}
            </p>
          ))}

          <div className="form-block">
            <label className="field-label" htmlFor="amount">
              {t(mode === 'yield' ? 'judge.yield.amount' : 'judge.amount.label')}
            </label>
            <div className="amount-input compact">
              <input
                id="amount"
                inputMode="decimal"
                value={amount}
                disabled={busy}
                onChange={(e) => setAmount(e.target.value.trim())}
                aria-invalid={!amountValid}
                aria-describedby="amount-help"
              />
              <span>USDT</span>
            </div>
            <div className="chips">
              {[...new Set(['2.50', capUsd])].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="chip"
                  disabled={busy}
                  aria-pressed={amountValid && units(amount) === units(preset)}
                  onClick={() => setAmount(preset)}
                >
                  ${money(preset)}
                </button>
              ))}
            </div>
            <p id="amount-help" className={`form-help ${amountValid ? '' : 'field-error'}`}>
              {amountValid
                ? mode === 'yield'
                  ? t('judge.yield.note')
                  : t('judge.code.hint', { cap: money(capUsd) })
                : t('invest.amount.error', {
                    min: money(mode === 'yield' ? '0.01' : minBuyUsd),
                    max: money(capUsd),
                  })}
            </p>
          </div>

          {mode === 'safe' ? (
            <fieldset className="form-block window-field">
              <legend className="field-label">{t('judge.summary.window')}</legend>
              <div className="radio-cards">
                {(['regular_session', 'anytime'] as const).map((w) => (
                  <label key={w} className="radio-card">
                    <input
                      type="radio"
                      name="window"
                      checked={window === w}
                      disabled={busy}
                      onChange={() => setWindow(w)}
                    />
                    <span>
                      <strong>
                        {t(
                          w === 'regular_session' ? 'judge.window.regular' : 'judge.window.anytime',
                        )}
                      </strong>
                      {closed ? (
                        <small>
                          {w === 'regular_session' || halfWaits
                            ? t('judge.window.regular.closed', {
                                open: timeText(market.nextBuyWindow, lang, tz),
                              })
                            : t('judge.window.anytime.closed', { half: money(halfUsd) })}
                        </small>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </section>

        {result ? (
          <DonePanel
            t={t}
            lang={lang}
            planId={planId}
            mode={terms?.mode ?? mode}
            ticker={terms?.ticker ?? ticker ?? ''}
            job={result}
            why={why}
            onRetry={retry}
            onStopped={() => setStoppedPlan(planId)}
          />
        ) : hasSession ? (
          <Panel
            eyebrow={t('invest.panel.eyebrow')}
            title={t('invest.panel.title', { funding, ticker: ticker ?? '—' })}
            waiting
          >
            <Ledger
              rows={[
                [t('invest.funding'), funding],
                [t('invest.target'), ticker ?? '—'],
                [t('invest.min'), `${money(minBuyUsd)} USDT`],
                [
                  t(mode === 'yield' ? 'judge.yield.amount' : 'judge.amount.label'),
                  amountShown ? `${amountShown} USDT` : '—',
                ],
                ...(mode === 'safe'
                  ? ([[t('judge.summary.window'), windowText]] as [string, string][])
                  : []),
                [t('receipt.chain'), 'BNB Smart Chain'],
                [t('invest.limit'), `${money(remaining)} USDT`],
              ]}
            />
            <p className="panel-note">{t('footer.simulate')}</p>
            {error && !review ? <ErrorNotice text={error} /> : null}
            <button
              type="button"
              className="button dark wide"
              disabled={!ticker || !amountValid || busy}
              onClick={() => void createPlan()}
            >
              {mode === 'yield' ? t('common.confirm') : t('judge.preview.cta')}
              <Icon name="arrow" size={18} />
            </button>
            <p className="panel-caption">{t('judge.code.hint', { cap: money(capUsd) })}</p>
          </Panel>
        ) : (
          <Panel eyebrow={t('plan.owner.judge')} title={t('judge.code.title')} waiting>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void checkCode();
              }}
            >
              <input
                className="text-input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                aria-label={t('judge.code.title')}
              />
              <button type="submit" className="button dark" disabled={busy || code.trim() === ''}>
                {t('common.confirm')}
              </button>
            </form>
            {error ? <ErrorNotice text={error} /> : null}
            <Ledger
              rows={[
                [t('invest.limit'), `${money(capUsd)} USDT`],
                [t('invest.min'), `${money(minBuyUsd)} USDT`],
                [t('receipt.chain'), 'BNB Smart Chain'],
              ]}
            />
            <p className="panel-note">
              {t('judge.code.hint', { cap: money(capUsd) })} {t('judge.done.plan_note')}
            </p>
            <Link className="button secondary wide" href="/skill">
              {t('home.cta.skill')}
              <Icon name="arrow" size={18} />
            </Link>
          </Panel>
        )}
      </div>

      <Process
        caption={t('invest.process')}
        steps={STEPS.map((s) => t(`judge.step.${s}`))}
        current={step}
      />

      {review && stage && planId ? (
        <Dialog
          titleId={reviewTitle}
          onClose={() => setReview(false)}
          closeLabel={t('common.cancel')}
          dismissable={!busy}
          returnFocusId="invest-outcome"
        >
          {stage === 'done' && result ? (
            <DoneBody
              t={t}
              titleId={reviewTitle}
              ticker={ticker ?? ''}
              job={result}
              why={why}
              onRetry={retry}
            />
          ) : (
            <>
              <AssetBadge ticker={ticker ?? ''} />
              <p className="eyebrow">
                {mode === 'yield' ? t('judge.mode.yield') : t('judge.step.preview')}
              </p>
              <h2 id={reviewTitle}>
                {mode === 'yield'
                  ? t('judge.preview.deposit', { usd: money(amount) })
                  : t('invest.review.title', { ticker: ticker ?? '' })}
              </h2>
              <p className="dialog-lead">{t('judge.preview.title')}</p>
              <Ledger
                rows={[
                  [t('invest.funding'), funding],
                  [
                    t(mode === 'yield' ? 'judge.yield.amount' : 'judge.amount.label'),
                    `${money(amount)} USDT`,
                  ],
                  [t('receipt.asset'), t('receipt.asset.value', { ticker: ticker ?? '' })],
                  ...(mode === 'safe'
                    ? ([[t('judge.summary.window'), windowText]] as [string, string][])
                    : []),
                ]}
              />
              <Process
                steps={[t('judge.step.preview'), t('judge.step.run'), t('judge.step.done')]}
                current={stage === 'running' ? 1 : 0}
              />
              <div className="preview-state" role="status">
                <PreviewState
                  t={t}
                  mode={mode}
                  stage={stage}
                  preview={preview}
                  ticker={ticker ?? ''}
                  why={why}
                />
              </div>
              {preview?.status === 'simulated' && preview.buy ? (
                <details className="dialog-details">
                  <summary>{t('common.details')}</summary>
                  <Ledger
                    rows={[
                      [t('judge.details.issuer'), issuerName(preview.buy.instrumentId) ?? '—'],
                      [t('judge.details.pieces'), fromBaseUnits(preview.buy.expectedTokens) ?? '—'],
                      [t('judge.details.min'), preview.buy.minReceive ?? '—'],
                    ]}
                  />
                </details>
              ) : null}
              {error ? <ErrorNotice text={error} /> : null}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setReview(false)}
                >
                  {t('common.back')}
                </button>
                {mode === 'safe' && !busy && (!preview || preview.status !== 'simulated') ? (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void runPreview(planId)}
                  >
                    {t('common.retry')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || (mode === 'safe' && !preview)}
                  onClick={() => void run()}
                >
                  {stage === 'running' ? (
                    <>
                      <span className="spinner" />
                      {t('judge.run.waiting')}
                    </>
                  ) : mode === 'yield' ? (
                    t('invest.deposit.cta')
                  ) : (
                    t('judge.run.cta')
                  )}
                </button>
              </div>
              <p className="dialog-caption">{t('footer.simulate')}</p>
            </>
          )}
        </Dialog>
      ) : null}

      {riskOpen ? (
        <Dialog
          titleId={riskTitle}
          onClose={() => {
            setRiskOpen(false);
            setRiskChecked(false);
          }}
          closeLabel={t('common.cancel')}
        >
          <span className="dialog-symbol">
            <Icon name="warn" size={26} />
          </span>
          <h2 id={riskTitle}>{t('nav.risk')}</h2>
          <RiskText lang={lang} apy={risk.apy} score={risk.score} />
          <label className="check-line">
            <input
              type="checkbox"
              checked={riskChecked}
              onChange={(e) => setRiskChecked(e.target.checked)}
            />
            {t('judge.risk.check')}
          </label>
          <div className="dialog-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setRiskOpen(false);
                setRiskChecked(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!riskChecked}
              onClick={() => {
                setMode('yield');
                setRiskOpen(false);
              }}
            >
              {t('risk.cta')}
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function ErrorNotice({ text }: { text: string }) {
  return (
    <p role="alert" className="notice fail">
      <Icon name="x" size={16} />
      <span>{text}</span>
    </p>
  );
}

function PreviewState({
  t,
  mode,
  stage,
  preview,
  ticker,
  why,
}: {
  t: (key: CopyKey, params?: Params) => string;
  mode: 'safe' | 'yield';
  stage: Stage;
  preview: JobResult | null;
  ticker: string;
  why: (w: Why | undefined) => string | null;
}) {
  if (stage === 'running') {
    const keys =
      mode === 'safe'
        ? ([
            'judge.run.progress.approve',
            'judge.run.progress.swap',
            'judge.run.progress.confirm',
          ] as const)
        : (['judge.run.progress.approve', 'judge.run.progress.confirm'] as const);
    return (
      <>
        <span className="spinner" />
        <span>{keys.map((key) => t(key)).join(' → ')}</span>
      </>
    );
  }
  if (mode === 'yield') {
    return (
      <>
        <Icon name="info" />
        <span>{t('judge.yield.note')}</span>
      </>
    );
  }
  if (stage === 'previewing' || !preview) {
    return stage === 'previewing' ? (
      <>
        <span className="spinner" />
        <span>{t('judge.preview.waiting')}</span>
      </>
    ) : (
      <>
        <Icon name="info" />
        <span>{t('judge.preview.cta')}</span>
      </>
    );
  }
  if (preview.status === 'simulated' && preview.buy) {
    const { swapSimulation, approval } = preview.buy;
    const ok = swapSimulation.status === 'SUCCESS';
    // A first buy's exact approval is only simulated, so the swap's own dry run stops at the
    // missing allowance — the expected answer, not a failure (scripts/operator-rules.ts
    // buyProblem): the live run dry-runs the swap again once the approval is on chain.
    const approvalFirst =
      !ok && approval === 'simulated' && /exceeds allowance/i.test(swapSimulation.failReason);
    return (
      <>
        <Icon name={ok || approvalFirst ? 'check' : 'x'} />
        <span>
          {t('judge.preview.line', {
            usd: money(preview.buy.spendUsd),
            ticker,
            shares: sharesText(preview.buy.expectedShares),
          })}{' '}
          {ok
            ? t('judge.preview.simulated')
            : approvalFirst
              ? t('judge.preview.approval_first')
              : t('judge.preview.failed', { reason: swapSimulation.failReason })}
        </span>
      </>
    );
  }
  if (preview.status === 'done' && preview.outcome) {
    return (
      <>
        <Icon
          name={
            preview.outcome.kind === 'DEFERRED'
              ? 'clock'
              : preview.outcome.kind === 'FAILED'
                ? 'x'
                : 'minus'
          }
        />
        <span>
          {t(`outcome.${preview.outcome.kind}`)} · {why(preview.why)}
        </span>
      </>
    );
  }
  return (
    <>
      <Icon name="x" />
      <span>{t('judge.job.failed', { reason: preview.status })}</span>
    </>
  );
}

function receiptLinks(t: (key: CopyKey, params?: Params) => string, job: Job) {
  return (job.result?.txHashes ?? []).map((hash) => (
    <a
      key={hash}
      className="receipt-link"
      href={`https://bscscan.com/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {t('receipt.view')}
    </a>
  ));
}

function DoneBody({
  t,
  titleId,
  ticker,
  job,
  why,
  onRetry,
}: {
  t: (key: CopyKey, params?: Params) => string;
  titleId: string;
  ticker: string;
  job: Job;
  why: (w: Why | undefined) => string | null;
  onRetry: (() => void) | undefined;
}) {
  const done = doneText(t, ticker, job, why);
  // The receipt page shows cycles that reached the chain; a wait lives on the plan's page.
  const cycleId = (job.result?.txHashes?.length ?? 0) > 0 ? job.result?.cycleId : undefined;
  return (
    <>
      <span className={`dialog-symbol ${done.tone}`}>
        <Icon
          name={
            done.tone === 'ok'
              ? 'check'
              : done.tone === 'fail'
                ? 'x'
                : done.tone === 'wait'
                  ? 'clock'
                  : 'info'
          }
          size={28}
        />
      </span>
      <p className="eyebrow">{t('judge.step.done')}</p>
      <h2 id={titleId}>{done.title}</h2>
      {done.lead ? <p className="dialog-lead">{done.lead}</p> : null}
      {done.note ? <p className="dialog-lead">{done.note}</p> : null}
      <div className="link-row dialog-links">{receiptLinks(t, job)}</div>
      {cycleId ? (
        <Link className="button primary wide" href={`/activity/${cycleId}`}>
          {t('receipt.inspect')}
          <Icon name="arrow" size={18} />
        </Link>
      ) : null}
      {onRetry ? (
        <button type="button" className="button primary wide" onClick={onRetry}>
          {t('common.retry')}
        </button>
      ) : null}
      {job.result?.planStatus === 'active' ? (
        <p className="dialog-caption">{t('judge.done.plan_note')}</p>
      ) : null}
    </>
  );
}

function DonePanel({
  t,
  lang,
  planId,
  mode,
  ticker,
  job,
  why,
  onRetry,
  onStopped,
}: {
  t: (key: CopyKey, params?: Params) => string;
  lang: Lang;
  planId: string | null;
  mode: 'safe' | 'yield';
  ticker: string;
  job: Job;
  why: (w: Why | undefined) => string | null;
  onRetry: (() => void) | undefined;
  onStopped: () => void;
}) {
  const done = doneText(t, ticker, job, why);
  // The receipt page shows cycles that reached the chain; a wait lives on the plan's page.
  const cycleId = (job.result?.txHashes?.length ?? 0) > 0 ? job.result?.cycleId : undefined;
  return (
    <aside className="receipt-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t('judge.step.done')}</p>
          <h3 id="invest-outcome" tabIndex={-1}>
            {done.title}
          </h3>
        </div>
        {done.tone === 'fail' ? (
          <span className="check-badge fail" aria-hidden="true" />
        ) : (
          <CheckBadge waiting={done.tone !== 'ok'} />
        )}
      </div>
      {done.lead ? <p className="panel-note">{done.lead}</p> : null}
      {done.note ? <p className="panel-note">{done.note}</p> : null}
      <div className="link-row">{receiptLinks(t, job)}</div>
      {cycleId ? (
        <Link className="button dark wide" href={`/activity/${cycleId}`}>
          {t('receipt.inspect')}
          <Icon name="arrow" size={18} />
        </Link>
      ) : null}
      {onRetry ? (
        <button type="button" className="button dark wide" onClick={onRetry}>
          {t('common.retry')}
        </button>
      ) : null}
      {planId ? (
        <>
          <Link className="text-link panel-link" href={`/plans/${planId}`}>
            {t('judge.plan.link')}
          </Link>
          <StopPlan
            planId={planId}
            lang={lang}
            yieldPlan={mode === 'yield'}
            onStopped={onStopped}
          />
        </>
      ) : null}
      {job.result?.planStatus === 'active' ? (
        <p className="panel-caption">{t('judge.done.plan_note')}</p>
      ) : null}
    </aside>
  );
}
