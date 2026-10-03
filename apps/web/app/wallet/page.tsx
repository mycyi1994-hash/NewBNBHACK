/**
 * /wallet (DECISIONS D-32): a person's own wallet — their Binance Wallet or Agentic Wallet — read
 * on chain at one block: the tokenized stocks it holds counted in real shares, a scheduled
 * dividend or split, the value at the last recorded price, its USDT and Venus position, and the
 * Yieldvest plans that use it. A plain GET form; nothing is signed or stored.
 */
import { fromUnits, toUnits } from '@yieldvest/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '../../components/Icon';
import { planName, statusText } from '../../components/plan-text';
import { Toolbar } from '../../components/Toolbar';
import {
  BlockTitle,
  DataTable,
  SectionHeading,
  StateBadge,
  tapeState,
  Unavailable,
} from '../../components/ui';
import { grouped, issuerName, money, moneyFine, sharesText, timeText } from '../../lib/format';
import { locale } from '../../lib/i18n/server';
import type { Lang, T } from '../../lib/i18n/translate';
import { context } from '../../lib/server/context';
import { WalletQuery } from '../../lib/server/schemas';
import { settle } from '../../lib/server/settle';
import { walletView, type WalletView } from '../../lib/server/wallet';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: t('wallet.title') };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** USDT amounts: to the micro-dollar under $1,000, to the cent above (the rest is noise there). */
function usdt(value: string): string {
  return grouped(Number(value) >= 1000 ? money(value) : moneyFine(value)) ?? value;
}

/** The sum of the values when every holding has one; null otherwise (never a partial total). */
function totalValue(view: WalletView): string | null {
  if (view.stocks.length === 0) return null;
  let sum = 0n;
  for (const s of view.stocks) {
    if (s.valueUsd === null) return null;
    sum += toUnits(s.valueUsd, 18);
  }
  return fromUnits(sum, 18);
}

function Holdings({
  t,
  lang,
  tz,
  now,
  view,
}: {
  t: T;
  lang: Lang;
  tz: string;
  now: Date;
  view: WalletView;
}) {
  if (view.chain.state === 'UNAVAILABLE') {
    return <Unavailable t={t} reason={view.chain.reason} />;
  }
  const total = totalValue(view);
  const usd = (value: string | null) => (value === null ? '—' : `$${grouped(money(value))}`);
  const stats: [string, string, string | null][] = [
    [t('wallet.summary.stocks'), String(view.stocks.length), null],
    [t('wallet.summary.value'), usd(total), null],
    [t('wallet.summary.usdt'), view.usdt === null ? '—' : `${usdt(view.usdt)} USDT`, null],
    [
      t('wallet.summary.venus'),
      view.venus.state === 'LIVE' ? `${usdt(view.venus.usdt)} USDT` : '—',
      view.venus.state === 'UNAVAILABLE'
        ? t('home.status.unavailable', { reason: view.venus.reason })
        : null,
    ],
  ];
  return (
    <>
      <section className="summary-strip four wallet-summary" aria-label={t('wallet.summary')}>
        {stats.map(([label, value, note]) => (
          <div className="summary-stat" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            {note ? <small className="summary-note">{note}</small> : null}
          </div>
        ))}
      </section>
      {/* No section label: the holdings table carries this name (one name per landmark, axe). */}
      <section className="page-block">
        <BlockTitle>{t('wallet.title')}</BlockTitle>
        <p className="method-note wallet-read">
          {t('wallet.read', {
            block: view.chain.blockNumber,
            time: timeText(view.chain.readAt, lang, tz),
          })}
        </p>
        {view.stocks.length > 0 ? (
          <div className="wallet-table">
            <DataTable
              label={t('wallet.title')}
              head={[t('wallet.col.stock'), t('wallet.col.shares'), t('wallet.col.value')]}
              rows={view.stocks.map((s) => [
                <span key="n">
                  <strong>{s.ticker}</strong>
                  <small className="table-note" title={s.token}>
                    {issuerName(s.issuer) ?? s.issuer} · {s.symbol}
                  </small>
                </span>,
                <span key="s">
                  {sharesText(s.shares) ?? s.shares}
                  {s.pendingChange ? (
                    <small className="table-note">
                      {t('wallet.pending', {
                        m: s.pendingChange.to,
                        time: timeText(s.pendingChange.effectiveAt, lang, tz),
                      })}
                    </small>
                  ) : null}
                </span>,
                usd(s.valueUsd),
              ])}
            />
          </div>
        ) : (
          <p className="state-line">{t('wallet.none', { n: view.checked })}</p>
        )}
        {view.unread > 0 ? (
          <p className="method-note">{t('wallet.unread', { n: view.unread })}</p>
        ) : null}
        <p className="method-note wallet-prices">
          {t('wallet.prices')}{' '}
          <StateBadge
            t={t}
            data={tapeState(view.prices, 'no market data recorded yet')}
            now={now}
          />
        </p>
        <p className="method-note">{t('wallet.note')}</p>
      </section>
    </>
  );
}

function Plans({ t, view }: { t: T; view: WalletView }) {
  return (
    <section className="page-block">
      <BlockTitle>{t('wallet.plans.title')}</BlockTitle>
      {view.plans.length === 0 ? (
        <p>{t('wallet.plans.none')}</p>
      ) : (
        <ul className="check-list">
          {view.plans.map((plan) => (
            <li key={plan.id}>
              <Icon name="arrow" size={18} />
              <Link className="text-link" href={`/plans/${plan.id}`}>
                {planName(t, plan)} · {statusText(t, plan.status)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function WalletPage({ searchParams }: { searchParams: SearchParams }) {
  const { lang, tz, t } = await locale();
  const { config, db } = context();
  const now = new Date();
  const toolbar = <Toolbar t={t} lang={lang} tz={tz} title={t('nav.activity')} />;
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
  const raw = (await searchParams).address;
  const asked = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  const query = asked === null ? null : WalletQuery.safeParse({ address: asked });
  const result =
    query?.success === true
      ? await settle('database', () => walletView(db, config, query.data.address, now))
      : null;

  return (
    <>
      {toolbar}
      <SectionHeading title={t('wallet.title')} sub={t('wallet.sub')} />
      <form className="inline-form wallet-form" method="get" action="/wallet">
        <label className="wallet-field">
          <span className="field-label">{t('wallet.form.address')}</span>
          <input
            className="text-input"
            name="address"
            defaultValue={asked ?? ''}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        <button className="button primary" type="submit">
          {t('wallet.form.submit')}
        </button>
      </form>
      {query && !query.success ? (
        <p className="state-line" role="alert">
          <Icon name="info" size={16} />
          <span>{t('wallet.error.address')}</span>
        </p>
      ) : null}
      {result === null ? (
        query === null ? (
          <p className="page-intro">{t('wallet.empty')}</p>
        ) : null
      ) : result.ok ? (
        <>
          <Holdings t={t} lang={lang} tz={tz} now={now} view={result.value} />
          <Plans t={t} view={result.value} />
        </>
      ) : (
        <Unavailable t={t} reason={result.reason} />
      )}
    </>
  );
}
