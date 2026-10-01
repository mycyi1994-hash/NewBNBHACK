/**
 * The dx:repro checks against the responses recorded when each finding was logged (fixtures/):
 * each must say "reproduced" for the recorded answer, and not for a plausible fixed one.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  approvesUnlimited,
  logRangeRefused,
  ondoMinimum,
  oneCodeTwoCauses,
  quoteExpired,
  referenceIsDerived,
  signedOutLooksSuccessful,
  slidingWindow429,
  tickersRepeatPerChain,
  wafChallenge,
  type ApiAnswer,
} from './dx-repro-checks';

interface Fixture {
  recordedAt: string;
  response: { httpStatus: number; body: { code: number; msg: string; data?: unknown } };
}

const fixture = (path: string): Fixture =>
  JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')) as Fixture;

const answer = (f: Fixture): ApiAnswer => ({
  ok: f.response.body.code === 0,
  httpStatus: f.response.httpStatus,
  code: f.response.body.code,
  msg: f.response.body.msg,
});

describe('dx:repro checks on the recorded answers', () => {
  it('a quoteId used 35 s later is gone (00:52)', () => {
    const swap = fixture('trading/buildSwapTransaction-20260924-2.json');
    expect(quoteExpired(35, answer(swap))).toMatchObject({ reproduced: true });
    const fresh = fixture('trading/buildSwapTransaction-20260924-1.json');
    expect(quoteExpired(1, answer(fresh)).reproduced).toBe(false);
  });

  it('no balance and no position share 40484 with different messages (00:49)', () => {
    const deposit = answer(fixture('defi-transaction/buildDeFiDepositTransaction-20260924-1.json'));
    const redeem = answer(fixture('defi-transaction/buildDeFiRedeemTransaction-20260924-1.json'));
    expect(oneCodeTwoCauses(deposit, redeem).reproduced).toBe(true);
    expect(oneCodeTwoCauses(deposit, { ...redeem, code: 40485 }).reproduced).toBe(false);
  });

  it('the DeFi deposit build approves type(uint256).max (00:49)', () => {
    const build = fixture('defi-transaction/buildDeFiDepositTransaction-20260924-3.json');
    const verdict = approvesUnlimited(
      build.response.body.data as Parameters<typeof approvesUnlimited>[0],
    );
    expect(verdict).toMatchObject({ reproduced: true });
    expect(verdict.observed).toContain('type(uint256).max');
    expect(approvesUnlimited({ dataList: [{ callDataType: 'DEPOSIT' }] }).reproduced).toBe(false);
  });

  it('referencePrice is tokenPrice ÷ tokenToShareRatio for every token (00:55)', () => {
    const list = fixture('rwa/getRwaTokenList-20260924-1.json').response.body.data as {
      tokenSymbol: string;
      tokenPrice: string | null;
      referencePrice: string | null;
      tokenToShareRatio: string | null;
    }[];
    const rows = list.map((t) => ({
      symbol: t.tokenSymbol,
      tokenPrice: t.tokenPrice,
      referencePrice: t.referencePrice,
      ratio: t.tokenToShareRatio,
    }));
    expect(referenceIsDerived(rows).reproduced).toBe(true);
    // An independent price (here 1 % off) would not be.
    const independent = rows.map((r) =>
      r.referencePrice ? { ...r, referencePrice: String(Number(r.referencePrice) * 1.01) } : r,
    );
    expect(referenceIsDerived(independent).reproduced).toBe(false);
  });

  it('a $5 Ondo quote is below the 5 USD minimum (00:46)', () => {
    expect(
      ondoMinimum(answer(fixture('trading/getAggregatedQuote-20260924-4.json'))),
    ).toMatchObject({ reproduced: true });
    expect(
      ondoMinimum(answer(fixture('trading/getAggregatedQuote-20260924-1.json'))).reproduced,
    ).toBe(false);
  });

  it('the sixth quote inside one second meets 429 although a 5/s bucket would allow it (01:52)', () => {
    const burst = [1, 2, 3, 4, 5, 6].map((n) =>
      fixture(`trading/getAggregatedQuote-20260924-${n}.json`),
    );
    const attempts = burst.map((f) => ({
      httpStatus: f.response.httpStatus,
      atMs: Date.parse(f.recordedAt),
    }));
    const verdict = slidingWindow429(attempts);
    expect(verdict.reproduced).toBe(true);
    expect(verdict.observed).toContain('422 ms 429');
    expect(slidingWindow429(attempts.map((a) => ({ ...a, httpStatus: 200 }))).reproduced).toBe(
      false,
    );
  });
});

describe('dx:repro checks on answers quoted in dx/LOG.md', () => {
  it('the docs host challenges a non-browser client (09-23 17:44)', () => {
    expect(wafChallenge({ status: 202, wafAction: 'challenge', bodyBytes: 0 }).reproduced).toBe(
      true,
    );
    expect(wafChallenge({ status: 200, wafAction: null, bodyBytes: 425_947 }).reproduced).toBe(
      false,
    );
  });

  it('the public RWA list repeats a ticker per chain, Ethereum first (10-01 06:04)', () => {
    const entries = [
      { chainId: '1', ticker: 'NVDA', symbol: 'NVDAon' },
      { chainId: '56', ticker: 'NVDA', symbol: 'NVDAon' },
      { chainId: 'CT_501', ticker: 'NVDA', symbol: 'NVDAon' },
      { chainId: '56', ticker: 'EEM', symbol: 'EEMon' },
    ];
    const verdict = tickersRepeatPerChain(entries);
    expect(verdict.reproduced).toBe(true);
    expect(verdict.observed).toContain('NVDA in order: 1 → 56 → CT_501');
    expect(tickersRepeatPerChain(entries.filter((e) => e.chainId === '56')).reproduced).toBe(false);
  });

  it('baw wallet status reports success while signed out (10-01 06:19)', () => {
    expect(
      signedOutLooksSuccessful({ success: true, data: { status: 'UNCONNECTED' } }).reproduced,
    ).toBe(true);
    expect(signedOutLooksSuccessful({ success: false, error: { code: 10003000 } }).reproduced).toBe(
      false,
    );
  });

  it('a public RPC refuses a few hundred blocks of logs (09-30 02:10)', () => {
    expect(
      logRangeRefused(200, { error: { code: -32005, message: 'limit exceeded' } }).reproduced,
    ).toBe(true);
    expect(logRangeRefused(200, { resultCount: 12 }).reproduced).toBe(false);
  });
});
