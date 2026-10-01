# RWA LP deployments

One JSON manifest per deployed pool, `<chainId>-<symbol>.json`, written by
`contracts/script/DeployRwaLp.s.sol` only when it broadcasts. `pnpm lp:status` reads every manifest here;
one that fails validation (pool id that does not match its key, a PoolManager other than Uniswap's on
chain 56, a malformed field) is reported `UNAVAILABLE` with the reason, and the others are still read.

The directory is empty until a human approves a mainnet deployment (CLAUDE.md rule 5,
docs/RWA_LP.md §5). A dry run writes nothing. A local fork rehearsal broadcasts to the fork, and an
anvil fork of BSC reports chain id 56, so its manifest would look like a mainnet one: run it with
`MANIFEST_DIR=deployments/rehearsal` (git-ignored) and read it with
`pnpm lp:status --deployments packages/rwa-lp/deployments/rehearsal` against the fork's RPC.
