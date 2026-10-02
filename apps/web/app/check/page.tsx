/**
 * /check (DECISIONS D-31, F1): "Would it buy right now?" A person picks a stock, a token and an
 * amount; the agent's own engine (decideCycle, through nextFor) runs on its latest market data for
 * that plan-to-be, once per token, and every rule is listed with what it read and its limit. A
 * plain GET form, so it works without JavaScript and every answer has a link. Read-only.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '../../components/Icon';
import { ruleName, sessionText, windowText } from '../../components/plan-text';
import { Toolbar } from '../../components/Toolbar';
import {
  BlockTitle,
  DataTable,
  Ledger,
  Panel,
  Pill,
  SectionHeading,
  StateBadge,
  tapeState,
  Unavailable,
  whyText,
  type Tone,
} from '../../components/ui';
import { issuerName, money, timeText } from '../../lib/format';
import { locale } from '../../lib/i18n/server';
import { isCopyKey, type Lang, type T } from '../../lib/i18n/translate';
import { comparableTickers } from '../../lib/server/compare';
import { context } from '../../lib/server/context';
import {
  preflight,
  preflightAmountProblem,
  type Check,
  type IssuerVerdict,
  type Preflight,
} from '../../lib/server/preflight';
import { PreflightQuery } from '../../lib/server/schemas';
import { settle } from '../../lib/server/settle';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: t('check.title') };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STATE_TONE: Record<Check['state'], Tone> = {
  pass: 'ok',
  wait: 'wait',
  block: 'fail',
  unknown: 'skip',
  na: 'neutral',
};

const DECISION_TONE: Record<IssuerVerdict['decision'], Tone> = {
  buy: 'ok',
  wait: 'wait',
  skip: 'skip',
  failed: 'fail',
};

/** What a rule read, in words (UX_COPY §7.7). */
function readText(t: T, lang: Lang, tz: string, check: Check): string {
  const { value, limit } = check;
  switch (check.id) {
    case 'data':
      return value === null
        ? t('check.read.none')
        : t('check.read.data', {
            age: Math.floor(Number(value) / 60),
            limit: Number(limit) / 60,
          });
    case 'guardian':
      if (check.state === 'block') {
        return t('check.read.guardian.open', {
          rules: (value ?? '')
            .split(',')
            .map((r) => ruleName(t, r))
            .join(', '),
        });
      }
      return check.state === 'unknown'
        ? t('check.read.guardian.unchecked')
        : t('check.read.guardian.ok', { time: timeText(check.at, lang, tz) });
    case 'session':
      return t('check.read.session', {
        session: sessionText(t, value ?? ''),
        window: windowText(t, limit ?? ''),
      });
    case 'amount': {
      // Off-hours an anytime plan buys half: say so whether half reaches the minimum or not.
      const half = check.note === 'off_hours_half' || check.note === 'half_limit_below_min';
      return t(half ? 'check.read.amount.half' : 'check.read.amount', {
        value: money(value),
        limit: money(limit),
      });
    }
    case 'status':
      return value === null || check.at === null
        ? t('check.read.none')
        : check.note
          ? t('check.read.status.why', { code: value, why: check.note })
          : t('check.read.status', { code: value });
    case 'gap':
      if (check.note === 'off_hours') return t('check.read.gap.off_hours');
      if (check.note === 'no_us_price') return t('check.read.gap.no_us_price');
      return t('check.read.gap', { value, limit });
    case 'impact':
      // A number is the Trading API refusing the quote; anything else, the recording failing.
      if (check.code) {
        return /^\d+$/.test(check.code)
          ? t('check.read.impact.code', { code: check.code })
          : t('check.read.impact.unrecorded', { code: check.code });
      }
      if (value === null) return t('check.read.none');
      return check.note === 'halved'
        ? t('check.read.impact.halved', { value, limit, usd: money(check.basisUsd ?? null) })
        : t('check.read.impact', { value, limit });
  }
}

function ruleText(t: T, check: Check): string {
  return t(`check.rule.${check.id}`);
}

function stateText(t: T, check: Check): string {
  return t(`check.state.${check.state}`);
}

/** `of` names whose rules these are: two tables of one page need two names (axe landmark-unique). */
function Rules({
  t,
  lang,
  tz,
  checks,
  of,
}: {
  t: T;
  lang: Lang;
  tz: string;
  checks: Check[];
  of: string;
}) {
  return (
    <DataTable
      label={`${t('check.rules.title')} · ${of}`}
      head={[t('check.col.rule'), t('check.col.read'), t('check.col.state')]}
      rows={checks.map((check) => [
        ruleText(t, check),
        readText(t, lang, tz, check),
        <Pill key="s" tone={STATE_TONE[check.state]}>
          {stateText(t, check)}
        </Pill>,
      ])}
    />
  );
}

function verdictLine(t: T, lang: Lang, tz: string, verdict: IssuerVerdict): string[] {
  if (verdict.decision === 'buy') {
    return [
      t('check.verdict.buy', {
        shares: verdict.estimate?.shares,
        usd: money(verdict.spendUsd ?? null),
      }),
    ];
  }
  const head = t(`check.verdict.${verdict.decision}`);
  const why = whyText(t, lang, tz, verdict.why);
  if (why) return [head, why];
  if (verdict.reason) {
    const key = `check.reason.${verdict.reason}`;
    return [head, isCopyKey(key) ? t(key) : t('check.reason.other', { reason: verdict.reason })];
  }
  return [head];
}

function Verdict({
  t,
  lang,
  tz,
  verdict,
}: {
  t: T;
  lang: Lang;
  tz: string;
  verdict: IssuerVerdict;
}) {
  const name = issuerName(verdict.issuer) ?? verdict.issuer;
  const [head, reason] = verdictLine(t, lang, tz, verdict);
  return (
    <section className="page-block check-verdict" aria-label={`${name} · ${verdict.symbol}`}>
      <BlockTitle aside={<Pill tone={DECISION_TONE[verdict.decision]}>{head}</Pill>}>
        {name} · {verdict.symbol}
      </BlockTitle>
      {reason ? <p className="check-why">{reason}</p> : null}
      {verdict.retryAt ? (
        <p className="method-note">
          {t('check.retry', { time: timeText(verdict.retryAt, lang, tz) })}
        </p>
      ) : null}
      <Rules t={t} lang={lang} tz={tz} checks={verdict.checks} of={`${name} · ${verdict.symbol}`} />
    </section>
  );
}

function Form({
  t,
  tickers,
  values,
}: {
  t: T;
  tickers: string[];
  values: { ticker: string; issuer: string; usd: string; window: string };
}) {
  return (
    <form className="check-form" method="get" action="/check">
      <label>
        <span className="field-label">{t('check.form.ticker')}</span>
        <select className="text-input" name="ticker" defaultValue={values.ticker}>
          {tickers.map((ticker) => (
            <option key={ticker} value={ticker}>
              {ticker}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="field-label">{t('check.form.issuer')}</span>
        <select className="text-input" name="issuer" defaultValue={values.issuer}>
          <option value="">{t('check.form.issuer.both')}</option>
          <option value="bstocks">{issuerName('bstocks')}</option>
          <option value="ondo">{issuerName('ondo')}</option>
        </select>
      </label>
      <label>
        <span className="field-label">{t('check.form.usd')}</span>
        <input
          className="text-input"
          name="usd"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={values.usd}
          required
        />
      </label>
      <label>
        <span className="field-label">{t('check.form.window')}</span>
        <select className="text-input" name="window" defaultValue={values.window}>
          <option value="regular_session">{windowText(t, 'regular_session')}</option>
          <option value="anytime">{windowText(t, 'anytime')}</option>
        </select>
      </label>
      <button className="button primary" type="submit">
        {t('check.form.submit')}
      </button>
    </form>
  );
}

function Shared({
  t,
  lang,
  tz,
  now,
  answer,
}: {
  t: T;
  lang: Lang;
  tz: string;
  now: Date;
  answer: Preflight | null;
}) {
  return (
    <Panel eyebrow={t('check.shared.title')} title={t('check.rules.title')} badge={false}>
      {answer ? (
        <>
          <StateBadge t={t} data={tapeState(answer.data, 'no tape samples yet')} now={now} />
          <Ledger
            rows={answer.checks.map((check) => [
              ruleText(t, check),
              <span key="v" className="check-shared">
                {readText(t, lang, tz, check)}{' '}
                <Pill tone={STATE_TONE[check.state]}>{stateText(t, check)}</Pill>
              </span>,
            ])}
          />
        </>
      ) : null}
      <p className="panel-note">{t('check.note')}</p>
      <Link
        className="button dark wide"
        href={`/compare${answer ? `?ticker=${answer.ticker}` : ''}`}
      >
        {t('check.cta.compare')}
        <Icon name="arrow" size={18} />
      </Link>
    </Panel>
  );
}

export default async function CheckPage({ searchParams }: { searchParams: SearchParams }) {
  const { lang, tz, t } = await locale();
  const { config, db } = context();
  const now = new Date();
  const toolbar = <Toolbar t={t} lang={lang} tz={tz} title={t('invest.tools')} />;
  if (!db) {
    return (
      <>
        {toolbar}
        <section className="empty-state">
          <Unavailable t={t} reason="no database" />
        </section>
      </>
    );
  }
  const params = await searchParams;
  const raw = Object.fromEntries(
    Object.entries(params).flatMap(([k, v]) => (typeof v === 'string' && v !== '' ? [[k, v]] : [])),
  );
  const tickers = await settle('database', () => comparableTickers(db));
  const names = tickers.ok ? tickers.value.map((x) => x.ticker) : [];
  const minBuyUsd = String(config.caps.minBuyUsd);
  const maxPerTxUsd = String(config.caps.houseMaxPerTxUsd);

  let answer: Preflight | null = null;
  let problem: string | null = null;
  // Without an amount (a link from /compare carries only the stock) the form is filled in and
  // nothing runs yet.
  if (raw.usd !== undefined) {
    const query = PreflightQuery.safeParse(raw);
    const field = query.success ? null : query.error.issues[0]?.path[0];
    const bad = query.success
      ? preflightAmountProblem(query.data.usd, { minBuyUsd, maxPerTxUsd })
      : null;
    if (bad || field === 'usd') {
      problem = t('invest.amount.error', { min: money(minBuyUsd), max: money(maxPerTxUsd) });
    } else if (!query.success) {
      problem = t('home.status.unavailable', { reason: `bad ${String(field ?? 'query')}` });
    } else {
      const result = await settle('database', () => preflight(db, query.data, minBuyUsd, now));
      if (!result.ok) problem = t('home.status.unavailable', { reason: result.reason });
      else if (!result.value)
        problem = t('home.status.unavailable', { reason: 'not in the registry' });
      else answer = result.value;
    }
  }
  const values = {
    ticker: answer?.ticker ?? raw.ticker?.toUpperCase() ?? names[0] ?? '',
    issuer: raw.issuer ?? '',
    usd: answer?.usd ?? raw.usd ?? money(minBuyUsd) ?? minBuyUsd,
    window: answer?.window ?? raw.window ?? 'regular_session',
  };

  return (
    <>
      {toolbar}
      <div className="workspace-grid">
        <section className="visual-workspace">
          <SectionHeading title={t('check.title')} sub={t('check.sub')} />
          {tickers.ok ? (
            <Form t={t} tickers={names} values={values} />
          ) : (
            <Unavailable t={t} reason={tickers.reason} />
          )}
          {problem ? (
            <p className="state-line" role="alert">
              <Icon name="info" size={16} />
              <span>{problem}</span>
            </p>
          ) : null}
          {answer ? (
            answer.issuers.map((verdict) => (
              <Verdict key={verdict.issuer} t={t} lang={lang} tz={tz} verdict={verdict} />
            ))
          ) : problem ? null : (
            <p className="page-intro">{t('check.empty')}</p>
          )}
        </section>
        <Shared t={t} lang={lang} tz={tz} now={now} answer={answer} />
      </div>
    </>
  );
}
