import { houseRedactions, type ChainPort, type CycleReport, type SimulatedBuy } from '@ijaro/agent';
import { BSC_USDT } from '@ijaro/chain';
import { describe, expect, it } from 'vitest';
import { cycleReportText, liveActivationReasons, watchAllowances } from './operator-rules.js';

const HOUSE = '0x00000000000000000000000000000000000a11ce';
const REDACT = houseRedactions(HOUSE);
const ROUTER = '0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5';
const NVDAB = { symbol: 'NVDAB', address: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436' } as const;
const VUSDT = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';

describe('liveActivationReasons (plan:status --activate)', () => {
  const tick = (value: Record<string, unknown>) => ({
    value,
    updatedAt: '2026-09-28T13:00:05.000Z',
  });

  it('asks for nothing when neither this shell nor the worker is live', () => {
    expect(liveActivationReasons('simulate', undefined)).toEqual([]);
    expect(liveActivationReasons('simulate', tick({ mode: 'simulate', at: 'x' }))).toEqual([]);
  });

  it('asks when this shell is live', () => {
    expect(liveActivationReasons('live', tick({ mode: 'simulate' }))).toEqual([
      'EXECUTION_MODE=live here',
    ]);
  });

  it('asks when the worker last ticked live, even from a simulate shell', () => {
    expect(
      liveActivationReasons('simulate', tick({ mode: 'live', at: '2026-09-28T13:00:00.000Z' })),
    ).toEqual(["the worker's last tick at 2026-09-28T13:00:00.000Z ran live"]);
    // Without its own `at`, the row's update time says when.
    expect(liveActivationReasons('live', tick({ mode: 'live' }))).toEqual([
      'EXECUTION_MODE=live here',
      "the worker's last tick at 2026-09-28T13:00:05.000Z ran live",
    ]);
  });

  it('does not read an unrecognised mode as live', () => {
    expect(liveActivationReasons('simulate', tick({ mode: 'LIVE' }))).toEqual([]);
    expect(liveActivationReasons('simulate', tick({}))).toEqual([]);
  });
});

describe('watchAllowances (cycle:once dry run)', () => {
  const unused = () => Promise.reject(new Error('not used in this test'));
  const chain: ChainPort = {
    allowance: () => Promise.resolve(7n),
    balanceOf: unused,
    nativeBalance: unused,
    exchangeRate: unused,
    underlyingOf: unused,
    venusMarketState: unused,
    pendingNonce: unused,
    minedNonce: unused,
    sendRaw: unused,
    waitForReceipt: unused,
    receipt: unused,
  };

  it('passes every read through and remembers each USDT spender once', async () => {
    const watched = watchAllowances(chain);
    expect(await watched.chain.allowance(BSC_USDT, HOUSE, ROUTER)).toBe(7n);
    await watched.chain.allowance(BSC_USDT.toLowerCase(), HOUSE, ROUTER.toLowerCase());
    // A Venus deposit's approval is not a buy's: other tokens are not recorded.
    await watched.chain.allowance(NVDAB.address, HOUSE, VUSDT);
    expect(watched.spenders).toEqual([ROUTER]);
    await expect(watched.chain.receipt('0x01')).rejects.toThrow('not used');
  });
});

describe('cycleReportText (cycle:once)', () => {
  const buy: SimulatedBuy = {
    instrumentId: 'NVDA:bstocks',
    spendUsd: '1',
    expectedTokens: '4442430800471653',
    expectedShares: '0.004442430800471653',
    approval: 'simulated',
    swapSimulation: {
      status: 'FAILED',
      failReason: `ERC20: transfer amount exceeds allowance (owner ${HOUSE})`,
    },
    minReceive: '4420218646469295',
  };
  const simulated = (b: SimulatedBuy): CycleReport => ({
    status: 'simulated',
    planId: 'H-SAFE',
    cycleId: 12,
    buy: b,
  });
  const context = { instrument: NVDAB, spenders: [ROUTER], vToken: VUSDT, redact: REDACT };

  it('shows the amounts, the addresses and the simulations before the live y (audit S10)', () => {
    const text = cycleReportText(simulated(buy), context);
    expect(text).toContain('would buy NVDA:bstocks for $1 from [house]');
    expect(text).toContain(`buys:  NVDAB ${NVDAB.address}`);
    expect(text).toContain(`pays:  1000000000000000000 units of USDT ${BSC_USDT}`);
    expect(text).toContain(
      `approval: exact approve of 1000000000000000000 USDT units to spender ${ROUTER}, simulated: SUCCESS`,
    );
    expect(text).toContain('quote: 4442430800471653 token units ≈ 0.004442 shares');
    expect(text).toContain('slippage floor 4420218646469295');
    expect(text).toContain('swap simulation: FAILED — ERC20: transfer amount exceeds allowance');
    expect(text).toContain('(expected: the approval is not on chain');
    // The house wallet never shows, in any spelling.
    expect(text).toContain('(owner [house])');
    expect(text.toLowerCase()).not.toContain(HOUSE.slice(2));
  });

  it('names an allowance that already covers the spend, and the redeem of a yield plan', () => {
    const text = cycleReportText(
      simulated({
        ...buy,
        approval: 'existing_allowance',
        swapSimulation: { status: 'SUCCESS', failReason: '' },
        redeem: { status: 'SUCCESS', failReason: '', vTokens: '4870' },
      }),
      context,
    );
    expect(text).toContain(`approval: the allowance of spender ${ROUTER} already covers it`);
    expect(text).toContain('swap simulation: SUCCESS');
    expect(text).not.toContain('(expected');
    expect(text).toContain(`redeem simulation (4870 vTokens of ${VUSDT}): SUCCESS`);
  });

  it('says so when the registry entry or the spender is missing, rather than inventing one', () => {
    const text = cycleReportText(simulated(buy), { spenders: [], redact: REDACT });
    expect(text).toContain('buys:  (not in the registry)');
    expect(text).toContain('to spender (not seen in the dry run)');
  });

  it('masks the house in outcomes and names what did not start', () => {
    const failed = cycleReportText(
      {
        status: 'done',
        planId: 'H-SAFE',
        cycleId: 13,
        outcome: {
          kind: 'FAILED',
          code: 'SIM_SWAP',
          message: `swap simulation FAILED for ${HOUSE}`,
          fundsMoved: 'gas_only',
        },
        why: { key: 'why.failed.onchain', params: { code: 'SIM_SWAP' } },
        txHashes: ['0xabc'],
      },
      context,
    );
    expect(failed).toContain('cycle #13: FAILED — why.failed.onchain {"code":"SIM_SWAP"}');
    expect(failed).toContain('swap simulation FAILED for [house]');
    expect(failed).toContain('tx https://bscscan.com/tx/0xabc');
    expect(
      cycleReportText({ status: 'outbox_busy', planId: 'H-SAFE', pending: ['0xdef'] }, context),
    ).toBe('not started: earlier transactions are still pending (0xdef)');
    expect(cycleReportText({ status: 'locked', planId: 'H-SAFE' }, context)).toBe(
      'not started: locked',
    );
  });
});
