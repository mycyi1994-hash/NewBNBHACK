'use client';
/**
 * The interest calculator on Earn (DECISIONS D-31, F3): a deposit in, what it would earn at
 * today's listed Venus APY — per day, week, month, year — the days until the interest reaches the
 * minimum buy, and about how many shares a month of it buys at today's on-chain price. The rate
 * and prices come from the server with their read time; lib/projection.ts does the arithmetic in
 * the browser as the person types. Every view says it is a projection at today's rate.
 */
import { useId, useState } from 'react';
import { grouped, moneyFine, sharesText, timeText } from '../../lib/format';
import { projectInterest } from '../../lib/projection';
import { translate, type CopyKey, type Lang, type Params } from '../../lib/i18n/translate';
import { Ledger } from '../ui';

export interface CalculatorStock {
  ticker: string;
  /** On-chain price of one share, USD (decimal string), from the latest tape. */
  sharePriceUsd: string;
}

const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

export function InterestCalculator({
  lang,
  tz,
  apy,
  minBuyUsd,
  stocks,
  initialDepositUsd,
}: {
  lang: Lang;
  tz: string;
  apy: { pct: string; at: string | null };
  minBuyUsd: string;
  stocks: CalculatorStock[];
  initialDepositUsd: string;
}) {
  const t = (key: CopyKey, params?: Params) => translate(lang, key, params);
  const id = useId();
  const [deposit, setDeposit] = useState(initialDepositUsd);
  const [ticker, setTicker] = useState(stocks[0]?.ticker ?? '');
  const valid = AMOUNT.test(deposit.trim()) && Number(deposit) > 0;
  const stock = stocks.find((s) => s.ticker === ticker) ?? null;
  const projection = valid
    ? projectInterest({
        depositUsd: Number(deposit),
        apyPct: Number(apy.pct.replaceAll(',', '')),
        minBuyUsd: Number(minBuyUsd),
        sharePriceUsd: stock ? Number(stock.sharePriceUsd) : null,
      })
    : null;
  const usd = (value: string) => `${grouped(moneyFine(value)) ?? value} USDT`;

  return (
    <div className="calculator">
      <div className="calculator-inputs">
        <label htmlFor={`${id}-deposit`}>
          <span className="field-label">{t('calc.deposit')}</span>
          <span className="amount-input compact">
            <input
              id={`${id}-deposit`}
              inputMode="decimal"
              autoComplete="off"
              value={deposit}
              aria-invalid={!valid}
              aria-describedby={valid ? undefined : `${id}-error`}
              onChange={(event) => setDeposit(event.target.value)}
            />
            <span>USDT</span>
          </span>
        </label>
        {stocks.length > 0 ? (
          <label htmlFor={`${id}-stock`}>
            <span className="field-label">{t('calc.stock')}</span>
            <select
              id={`${id}-stock`}
              className="text-input"
              value={ticker}
              onChange={(event) => setTicker(event.target.value)}
            >
              {stocks.map((s) => (
                <option key={s.ticker} value={s.ticker}>
                  {s.ticker}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {!valid ? (
        <p id={`${id}-error`} className="state-line" role="alert">
          {t('calc.amount.error')}
        </p>
      ) : projection ? (
        <>
          <Ledger
            rows={[
              [t('calc.day'), usd(projection.perDayUsd)],
              [t('calc.week'), usd(projection.perWeekUsd)],
              [t('calc.month'), usd(projection.perMonthUsd)],
              [t('calc.year'), usd(projection.perYearUsd)],
            ]}
          />
          <p className="calculator-line" aria-live="polite">
            {projection.daysToMinBuy === null
              ? t('calc.first.never', { min: minBuyUsd })
              : t('calc.first', { min: minBuyUsd, days: projection.daysToMinBuy })}
          </p>
          <p className="calculator-line">
            {projection.sharesPerMonth !== null && stock
              ? t('calc.shares', {
                  shares: sharesText(projection.sharesPerMonth),
                  ticker: stock.ticker,
                })
              : t('calc.shares.none')}
          </p>
        </>
      ) : null}
      <p className="method-note">
        {t('calc.basis', { apy: apy.pct, time: timeText(apy.at, lang, tz) })}
      </p>
    </div>
  );
}
