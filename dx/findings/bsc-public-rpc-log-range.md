# A public BSC RPC refuses eth_getLogs over a few hundred blocks

- **Where:** `https://bsc-dataseed.bnbchain.org` (JSON-RPC `eth_getLogs`)
- **Logged:** dx/LOG.md, 2026-09-30 02:10 UTC
- **Last run:** 2026-10-01T16:52:30Z — REPRODUCED — 200 blocks of Uniswap v4 PoolManager `Initialize` logs → error -32005 "limit exceeded"

## Reproduce
`pnpm dx:repro --only bsc-public-rpc-log-range`.

## Expected / actual
- Expected: `eth_getLogs` filtered by address and topic over a range long enough to list a contract's events.
- Actual: bsc-dataseed refuses 200 blocks (-32005). On 9/30: `bsc-rpc.publicnode.com` answered 100 blocks but refused 5,000,000 (HTTP 403, "Archive requests require a personal token"); `bsc.drpc.org` caps ranges at 10,000 blocks on the free plan; `rpc.ankr.com/bsc` did not answer.

## Impact
The tokenized-stock Uniswap v4 pools on BSC cannot be listed from events. We compute the pool ids of candidate keys and read StateView instead (`pnpm lp:market`). At the measured 0.45 s per block (dx/LOG.md 2026-09-24 02:11), 10,000 blocks is about 75 minutes of chain; the 9/30 entry said 2 hours from an assumed 0.75 s (our arithmetic, corrected here).

## Ask
An event index or data API for BSC v4 pools by currency, or a free archive tier with a larger log range.
