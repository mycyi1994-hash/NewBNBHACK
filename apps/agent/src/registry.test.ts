import { describe, expect, it } from 'vitest';
import { presenceMatrix, type RwaToken } from './registry.js';
import { msUntilNextSlot, routeOf, tapeSlot } from './tape.js';

const token = (ticker: string, platformId: string, tokenSymbol: string): RwaToken => ({
  binanceChainId: '56',
  tokenContractAddress: `0x${'0'.repeat(40)}`,
  platformId,
  assetType: 1,
  tokenSymbol,
  decimals: '18',
  underlyingTicker: ticker,
  tokenToShareRatio: '1',
});

describe('presenceMatrix', () => {
  it('maps platformId to SPEC issuers and keeps absent cells empty', () => {
    const m = presenceMatrix(
      [
        token('NVDA', 'bstock', 'NVDAB'),
        token('NVDA', 'ondo', 'NVDAon'),
        token('AAPL', 'ondo', 'AAPLon'),
        token('META', 'bstock', 'METAB'),
      ],
      ['NVDA', 'AAPL'],
    );
    expect(m.get('NVDA')?.get('bstocks')).toEqual(['NVDAB']);
    expect(m.get('NVDA')?.get('ondo')).toEqual(['NVDAon']);
    expect(m.get('AAPL')?.get('bstocks')).toBeUndefined();
    expect(m.has('META')).toBe(false);
  });
});

describe('tape helpers', () => {
  it('keys a scheduled run by its 10-minute slot, so a restart inside the slot maps to it', () => {
    expect(tapeSlot(new Date('2026-09-24T01:55:49.016Z')).toISOString()).toBe(
      '2026-09-24T01:50:00.000Z',
    );
    expect(tapeSlot(new Date('2026-09-24T02:00:00.000Z')).toISOString()).toBe(
      '2026-09-24T02:00:00.000Z',
    );
  });

  it('aligns runs to 10-minute wall-clock slots', () => {
    expect(msUntilNextSlot(new Date('2026-09-24T00:46:14.000Z'))).toBe(226_000);
    expect(msUntilNextSlot(new Date('2026-09-24T00:50:00.000Z'))).toBe(600_000);
  });

  it('renders the dex route of a quote', () => {
    expect(
      routeOf({
        dexRouterList: [
          { dexProtocol: { dexName: 'Rfq Halfmoon', percent: '40.00' } },
          { dexProtocol: { dexName: 'Pancakeswap V3', percent: '60.00' } },
        ],
      }),
    ).toBe('Rfq Halfmoon 40.00% + Pancakeswap V3 60.00%');
    expect(routeOf(undefined)).toBeNull();
  });
});
