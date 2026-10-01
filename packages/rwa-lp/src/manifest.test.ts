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
    // The id of another pool: the hook and the PoolManager would be asked about different pools.
    [{ poolId: `0x${'ab'.repeat(32)}` }, /not the id of its pool key/],
    [{ poolManager: '0x000000000000000000000000000000000000dEaD' }, /Uniswap's PoolManager/],
  ])('rejects %o', (patch, message) => {
    expect(() => parseDeployment({ ...DRY_RUN_MANIFEST, ...patch }, 'x.json')).toThrow(message);
  });

  it('rejects something that is not an object', () => {
    expect(() => parseDeployment(null, 'x.json')).toThrow(/not a JSON object/);
  });

  it('takes any PoolManager off chain 56, and the pool id in any case', () => {
    const local = { ...DRY_RUN_MANIFEST, chainId: 31337, poolManager: DRY_RUN_MANIFEST.oracle };
    expect(parseDeployment(local, 'x.json').chainId).toBe(31337);
    const upper = {
      ...DRY_RUN_MANIFEST,
      poolId: `0x${DRY_RUN_MANIFEST.poolId.slice(2).toUpperCase()}`,
    };
    expect(parseDeployment(upper, 'x.json').rwaSymbol).toBe('NVDAB');
  });
});

describe('loadDeployments', () => {
  it('reads every manifest in a directory, and none from a missing one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rwa-lp-'));
    writeFileSync(path.join(dir, '56-NVDAB.json'), JSON.stringify(DRY_RUN_MANIFEST));
    writeFileSync(path.join(dir, 'README.md'), 'not a manifest');
    const { deployments, problems } = loadDeployments(dir);
    expect(deployments.map((d) => d.file)).toEqual(['56-NVDAB.json']);
    expect(problems).toEqual([]);
    expect(loadDeployments(path.join(dir, 'missing'))).toEqual({ deployments: [], problems: [] });
  });

  it('reports a manifest it cannot use, with the reason, and still reads the others', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rwa-lp-'));
    writeFileSync(path.join(dir, '56-NVDAB.json'), JSON.stringify(DRY_RUN_MANIFEST));
    writeFileSync(path.join(dir, '56-BROKEN.json'), '{ "chainId": 56,');
    writeFileSync(
      path.join(dir, '56-OTHER.json'),
      JSON.stringify({ ...DRY_RUN_MANIFEST, poolId: `0x${'ab'.repeat(32)}` }),
    );
    const { deployments, problems } = loadDeployments(dir);
    expect(deployments.map((d) => d.file)).toEqual(['56-NVDAB.json']);
    expect(problems.map((p) => p.file)).toEqual(['56-BROKEN.json', '56-OTHER.json']);
    expect(problems[0]?.reason).toMatch(/^56-BROKEN\.json: not readable JSON/);
    expect(problems[1]?.reason).toMatch(/^56-OTHER\.json: poolId is not the id of its pool key/);
  });

  it('finds no deployment in the repository until a human deploys', () => {
    expect(loadDeployments(DEPLOYMENTS_DIR)).toEqual({ deployments: [], problems: [] });
  });
});
