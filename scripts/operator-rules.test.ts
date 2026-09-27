import { houseRedactions, type ChainPort, type CycleReport, type SimulatedBuy } from '@ijaro/agent';
import { BSC_USDT } from '@ijaro/chain';
import { describe, expect, it } from 'vitest';
import {
  buyProblem,
  cycleExitCode,
  cycleReportText,
  depositProblem,
  depositRecordRefusal,
  depositRefusal,
  liveActivationReasons,
  pendingDepositHint,
  watchAllowances,
  whenSettledAndLocked,
} from './operator-rules.js';

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

describe('exit codes and dry-run verdicts (audit S11)', () => {
  const buy: SimulatedBuy = {
    instrumentId: 'NVDA:bstocks',
    spendUsd: '1',
    expectedTokens: '4442430800471653',
    expectedShares: '0.004442430800471653',
    approval: 'simulated',
    swapSimulation: { status: 'FAILED', failReason: 'transfer amount exceeds allowance' },
    minReceive: '4420218646469295',
  };
  const planId = 'H-SAFE';
  const done = (outcome: Extract<CycleReport, { status: 'done' }>['outcome']): CycleReport => ({
    status: 'done',
    planId,
    cycleId: 1,
    outcome,
    why: { key: 'why.failed.simulation', params: {} },
    txHashes: [],
  });

  it('passes a dry-run buy whose only failure is the approval a simulation cannot hold', () => {
    expect(buyProblem(buy)).toBeUndefined();
    expect(cycleExitCode({ status: 'simulated', planId, cycleId: 1, buy })).toBe(0);
    const covered = {
      ...buy,
      approval: 'existing_allowance' as const,
      swapSimulation: { status: 'SUCCESS', failReason: '' },
    };
    expect(buyProblem(covered)).toBeUndefined();
  });

  it('fails a dry-run buy the live run would stop at the same simulation', () => {
    const covered = { ...buy, approval: 'existing_allowance' as const };
    expect(buyProblem(covered)).toBe(
      'the swap simulation is FAILED although the allowance already covers the spend',
    );
    expect(cycleExitCode({ status: 'simulated', planId, cycleId: 1, buy: covered })).toBe(1);
    const redeem = { ...buy, redeem: { status: 'FAILED', failReason: 'x', vTokens: '1' } };
    expect(buyProblem(redeem)).toBe('the redeem simulation is FAILED');
  });

  it('exits 1 on FAILED, review, outbox_busy, locked and stopped; 0 when it ran or chose not to buy', () => {
    const failed = done({ kind: 'FAILED', code: 'SIM_SWAP', message: 'x', fundsMoved: 'none' });
    expect(cycleExitCode(failed)).toBe(1);
    expect(cycleExitCode({ status: 'review', planId, cycleId: 1, message: 'x' })).toBe(1);
    expect(cycleExitCode({ status: 'outbox_busy', planId, pending: ['0x1'] })).toBe(1);
    expect(cycleExitCode({ status: 'locked', planId })).toBe(1);
    expect(cycleExitCode({ status: 'stopped', planId })).toBe(1);
    expect(cycleExitCode(done({ kind: 'SKIPPED', reason: 'daily_cap' }))).toBe(0);
    expect(
      cycleExitCode(
        done({ kind: 'DEFERRED', reason: 'market_closed', retryAt: '2026-09-28T13:32:00.000Z' }),
      ),
    ).toBe(0);
    expect(cycleExitCode({ status: 'awaiting_tx', planId, cycleId: 1, txHash: '0x2' })).toBe(0);
  });

  it('fails a deposit dry run on a build or check failure, not on the expected mint FAILED', () => {
    const sim = (status: 'SUCCESS' | 'FAILED') => ({
      status,
      failReason: '',
      balanceChanges: [],
      allowanceChanges: [],
    });
    expect(
      depositProblem({
        kind: 'failed',
        code: 'DEFI_WRONG_AMOUNT',
        message: 'DEPOSIT is mint(2)',
        fundsMoved: 'none',
      }),
    ).toBe('DEFI_WRONG_AMOUNT: DEPOSIT is mint(2)');
    expect(
      depositProblem({ kind: 'simulated', approve: sim('SUCCESS'), deposit: sim('FAILED') }),
    ).toBeUndefined();
    expect(
      depositProblem({ kind: 'simulated', approve: 'existing_allowance', deposit: sim('SUCCESS') }),
    ).toBeUndefined();
    expect(
      depositProblem({ kind: 'simulated', approve: 'existing_allowance', deposit: sim('FAILED') }),
    ).toBe('the deposit simulation is FAILED although the allowance already covers the amount');
  });
});

describe('yield:deposit --record and its pending hint (audit S15)', () => {
  const HASH = `0x${'ab'.repeat(32)}`;

  it('records only a deposit our outbox signed for this plan', () => {
    expect(depositRecordRefusal({ planId: 'H-YIELD', kind: 'deposit' }, 'H-YIELD', HASH)).toBe(
      undefined,
    );
    expect(depositRecordRefusal(undefined, 'H-YIELD', HASH)).toBe(
      `${HASH} is not a transaction our outbox signed`,
    );
    expect(depositRecordRefusal({ planId: 'H-YIELD', kind: 'approve' }, 'H-YIELD', HASH)).toBe(
      `${HASH} is H-YIELD's approve, not a deposit of H-YIELD`,
    );
    expect(depositRecordRefusal({ planId: 'J-1', kind: 'deposit' }, 'H-YIELD', HASH)).toBe(
      `${HASH} is J-1's deposit, not a deposit of H-YIELD`,
    );
  });

  it('suggests --record for a pending deposit only', () => {
    const hint = (kind: string | undefined) =>
      pendingDepositHint({ planId: 'H-YIELD', usd: '1', txHash: HASH, kind });
    expect(hint('deposit')).toContain(`pending: deposit ${HASH}`);
    expect(hint('deposit')).toContain(`pnpm yield:deposit --plan H-YIELD --record ${HASH}`);
    expect(hint('approve')).toContain(`pending: approve ${HASH}`);
    expect(hint('approve')).toContain('nothing was deposited');
    expect(hint('approve')).toContain('pnpm yield:deposit --plan H-YIELD --usd 1 --live');
    expect(hint('approve')).not.toContain('--record');
    expect(hint(undefined)).not.toContain('--record');
  });
});

describe('depositRefusal (yield:deposit, audit L4)', () => {
  const caps = { maxPrincipalUsd: 1000, sandboxMaxPerPlanUsd: 5 };
  const house = { id: 'H-YIELD', ownerKind: 'house', mode: 'yield', principalUsd: '0' };
  const refuse = (
    plan: typeof house,
    usd?: string,
    guardian: { rule: string; action: string }[] = [],
  ) => depositRefusal({ plan, ...(usd === undefined ? {} : { usd }), caps, guardian });

  it("never deposits house money into a skill plan (the position is its owner's wallet)", () => {
    const skill = { ...house, id: 'S-1', ownerKind: 'skill' };
    expect(refuse(skill, '1')).toBe(
      "S-1 is a skill plan: its principal is in its owner's wallet, and the owner deposits it with the skill",
    );
    // Not even a --record of one.
    expect(refuse(skill)).toContain('is a skill plan');
    expect(refuse({ ...house, ownerKind: 'stranger' }, '1')).toBe(
      'H-YIELD belongs to a stranger, not the house or a judge',
    );
    expect(refuse({ ...house, mode: 'safe' }, '1')).toBe('H-YIELD is a safe plan, not yield');
  });

  it('lets a house or judge yield plan deposit within its cap', () => {
    expect(refuse(house, '1')).toBeUndefined();
    expect(refuse({ ...house, principalUsd: '999' }, '1')).toBeUndefined();
    expect(refuse(house)).toBeUndefined();
    expect(refuse({ ...house, id: 'J-1', ownerKind: 'judge' }, '5')).toBeUndefined();
  });

  it('keeps the principal cap, and the sandbox cap for a judge plan', () => {
    expect(refuse({ ...house, principalUsd: '999.5' }, '1')).toBe(
      'principal would be 1000.5 USD; the principal cap is 1000',
    );
    expect(refuse(house, '0')).toBe('principal would be 0 USD; the principal cap is 1000');
    expect(refuse({ ...house, id: 'J-1', ownerKind: 'judge', principalUsd: '4' }, '1.01')).toBe(
      'principal would be 5.01 USD; the judge plan cap is 5',
    );
  });

  it('holds new deposits while the guardian does, but still records one', () => {
    const hold = [{ rule: 'venus_paused', action: 'stop_deposits' }];
    expect(refuse(house, '1', hold)).toBe(
      'the guardian holds new deposits: venus_paused (stop_deposits)',
    );
    expect(refuse(house, undefined, hold)).toBeUndefined();
    expect(refuse(house, '1', [{ rule: 'other', action: 'alert' }])).toBeUndefined();
  });
});

describe('whenSettledAndLocked (yield:deposit --live, audit S9)', () => {
  function steps(pending: string[], lockFree: boolean) {
    const calls: string[] = [];
    return {
      calls,
      steps: {
        reconcile: () => {
          calls.push('reconcile');
          return Promise.resolve({ pending });
        },
        lock: () => {
          calls.push('lock');
          return Promise.resolve(lockFree);
        },
        release: () => {
          calls.push('release');
          return Promise.resolve();
        },
      },
    };
  }

  it('signs nothing while an earlier transaction of the house is pending', async () => {
    const { calls, steps: s } = steps(['0xabc'], true);
    const sign = () => Promise.reject(new Error('must not sign'));
    expect(await whenSettledAndLocked(s, sign)).toEqual({
      kind: 'outbox_busy',
      pending: ['0xabc'],
    });
    expect(calls).toEqual(['reconcile']);
  });

  it('signs nothing while a cycle holds the plan', async () => {
    const { calls, steps: s } = steps([], false);
    const sign = () => Promise.reject(new Error('must not sign'));
    expect(await whenSettledAndLocked(s, sign)).toEqual({ kind: 'locked' });
    expect(calls).toEqual(['reconcile', 'lock']);
  });

  it('signs with the outbox settled and the lock held, and releases it after', async () => {
    const { calls, steps: s } = steps([], true);
    const sign = () => {
      calls.push('sign');
      return Promise.resolve('0xdeposit');
    };
    expect(await whenSettledAndLocked(s, sign)).toEqual({ kind: 'ran', value: '0xdeposit' });
    expect(calls).toEqual(['reconcile', 'lock', 'sign', 'release']);
  });

  it('releases the lock when signing throws', async () => {
    const { calls, steps: s } = steps([], true);
    const sign = () => Promise.reject(new Error('rpc down'));
    await expect(whenSettledAndLocked(s, sign)).rejects.toThrow('rpc down');
    expect(calls).toEqual(['reconcile', 'lock', 'release']);
  });
});
