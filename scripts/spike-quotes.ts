/**
 * pnpm spike:quotes — M0-06 small-amount quote spike: $1/$5/$50 USDT → NVDA/QQQ on each issuer.
 * Read-only (GET /quote only). Prints a Markdown table for dx/LOG.md and saves each response as a
 * fixture under fixtures/trading/ (house address redacted).
 */
import { createRuntime, maskHouse, quoteUsdtTo, routeOf } from '@ijaro/agent';
import { fromUnits, usSession } from '@ijaro/core';
import { loadConfig } from '@ijaro/config';
import { listInstruments } from '@ijaro/db';

const SIZES = [1, 5, 50];
const TICKERS = ['NVDA', 'QQQ'];

const rt = createRuntime(loadConfig(), { fixtures: true });
try {
  const now = new Date();
  const instruments = (await listInstruments(rt.database.db)).filter((i) =>
    TICKERS.includes(i.ticker),
  );
  console.log(
    `spike:quotes — ${now.toISOString()} — US session: ${usSession(now)} — userWalletAddress: house`,
  );
  console.log(
    '\n| instrument | USD | expectedOut (tokens) | implied USD/token | priceImpact % | vendor / mode | route | error | ms |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const i of instruments) {
    for (const usd of SIZES) {
      const o = await quoteUsdtTo(rt.client, i.address, usd, rt.houseAddress, {
        recordFixture: true,
      });
      const out = o.quote?.toTokenAmount
        ? fromUnits(BigInt(o.quote.toTokenAmount), i.decimals)
        : '—';
      const implied = o.quote?.toTokenAmount ? (usd / Number(out)).toFixed(4) : '—';
      console.log(
        `| ${i.symbol} | ${usd} | ${out} | ${implied} | ${o.quote?.priceImpactPercent ?? '—'} | ${o.quote ? `${o.quote.vendorName}/${o.quote.executionMode}` : '—'} | ${routeOf(o.quote) ?? '—'} | ${o.errorCode ? `${o.errorCode} "${maskHouse(o.errorMsg ?? '', rt.redact)}"` : '—'} | ${o.latencyMs ?? '—'} |`,
      );
    }
  }
} finally {
  await rt.close();
}
