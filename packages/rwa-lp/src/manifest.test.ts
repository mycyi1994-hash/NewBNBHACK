import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRY_RUN_MANIFEST } from '../test/fixtures.js';
import { DEPLOYMENTS_DIR, loadDeployments, parseDeployment } from './manifest.js';

describe('parseDeployment', () => {
  it('accepts what the deploy script writes', () => {
    const d = parseDeployment(DRY_RUN_MANIFEST, '56-NVDAB.json');
    expect(d.rwaSymbol).toBe('NVDAB');
    expect(d.hook).toBe('0x77A75903Ae8a1B6bE5788F2d4E6Fb7e9D2862880');
  });

  it.each([
    [{ hook: '0x77A75903Ae8a1B6bE5788F2d4E6Fb7e9D2862881' }, /permission flags/],
    [{ fee: 3000 }, /dynamic-fee flag/],
    [
      { currency0: DRY_RUN_MANIFEST.currency1, currency1: DRY_RUN_MANIFEST.currency0 },
      /sort below/,
    ],
    [{ rwaToken: DRY_RUN_MANIFEST.oracle }, /two pool currencies/],
    [{ vault: 'not an address' }, /vault is not an address/],
    [{ poolId: '0x1234' }, /poolId/],
    [{ chainId: 0 }, /chainId/],
    [{ tickSpacing: 0 }, /tickSpacing/],
    [{ rwaSymbol: '' }, /rwaSymbol/],
  ])('rejects %o', (patch, message) => {
    expect(() => parseDeployment({ ...DRY_RUN_MANIFEST, ...patch }, 'x.json')).toThrow(message);
  });

  it('rejects something that is not an object', () => {
    expect(() => parseDeployment(null, 'x.json')).toThrow(/not a JSON object/);
  });
});

describe('loadDeployments', () => {
  it('reads every manifest in a directory, and none from a missing one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rwa-lp-'));
    writeFileSync(path.join(dir, '56-NVDAB.json'), JSON.stringify(DRY_RUN_MANIFEST));
    writeFileSync(path.join(dir, 'README.md'), 'not a manifest');
    expect(loadDeployments(dir).map((d) => d.file)).toEqual(['56-NVDAB.json']);
    expect(loadDeployments(path.join(dir, 'missing'))).toEqual([]);
  });

  it('finds no deployment in the repository until a human deploys', () => {
    expect(loadDeployments(DEPLOYMENTS_DIR)).toEqual([]);
  });
});
