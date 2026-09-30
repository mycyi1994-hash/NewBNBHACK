/**
 * pnpm lp:status — the RWA liquidity pools recorded in packages/rwa-lp/deployments, read live from
 * BSC at one block each: the fee a buy and a sell pay right now and why (NYSE session, opening
 * ramp, reference gap, corporate action), the halt flag, pool price vs reference, vault holdings.
 * Read-only: no key, no transaction. Deploying a pool is a human decision (docs/RWA_LP.md §5).
 * Flags: --deployments <dir> (read manifests from another directory, e.g. a local fork rehearsal).
 * Exit: 0 every pool LIVE · 1 a pool UNAVAILABLE · 3 nothing deployed yet.
 */
import { parseArgs } from 'node:util';
import { createBscClient, BSC_CHAIN_ID } from '@yieldvest/chain';
import { loadConfig } from '@yieldvest/config';
import {
  DEPLOYMENTS_DIR,
  feePercent,
  formatE18,
  loadDeployments,
  readLpStatus,
  type LpStatus,
} from '@yieldvest/rwa-lp';

function describe(status: LpStatus): string[] {
  const d = status.deployment;
  const head = `${d.rwaSymbol} pool ${d.poolId} (hook ${d.hook}, vault ${d.vault})`;
  if (status.state === 'UNAVAILABLE') return [head, `  UNAVAILABLE: ${status.reason}`];
  const ref = status.reference;
  const reference = ref
    ? `reference ${formatE18(ref.priceE18)} USD, ${ref.ageSeconds} s old (${ref.fresh ? 'fresh' : 'STALE'})`
    : 'no reference price';
  return [
    head,
    `  LIVE at block ${status.blockNumber} (${status.at.toISOString()}), session ${status.session}` +
      (status.halted ? ', HALTED' : ''),
    `  buy ${feePercent(status.buy.feePips)} (${status.buy.reason}) · sell ${feePercent(status.sell.feePips)} (${status.sell.reason})`,
    `  pool ${formatE18(status.poolPriceE18)} USD per token · ${reference}`,
    `  vault ${formatE18(status.vault.totalSupply)} shares · ${formatE18(status.vault.rwaAmount, 4)} ${d.rwaSymbol} + ` +
      `${formatE18(status.vault.quoteAmount)} quote · allowlist ${status.vault.allowlistEnabled ? 'on' : 'off'}`,
  ];
}

const { values: flags } = parseArgs({
  options: { deployments: { type: 'string', default: DEPLOYMENTS_DIR } },
});
const deployments = loadDeployments(flags.deployments);
if (deployments.length === 0) {
  console.log(
    `UNAVAILABLE: no RWA LP deployment recorded in ${flags.deployments} — ` +
      'deploying is a human decision (docs/RWA_LP.md §5)',
  );
  process.exitCode = 3;
} else {
  const client = createBscClient(loadConfig().bsc);
  for (const deployment of deployments) {
    const status: LpStatus =
      deployment.chainId === BSC_CHAIN_ID
        ? await readLpStatus(client, deployment)
        : {
            state: 'UNAVAILABLE',
            deployment,
            reason: `chain ${deployment.chainId} is not BSC mainnet`,
          };
    for (const line of describe(status)) console.log(line);
    if (status.state !== 'LIVE') process.exitCode = 1;
  }
}
