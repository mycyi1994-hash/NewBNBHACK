# RWA LP deployments

One JSON manifest per deployed pool, `<chainId>-<symbol>.json`, written by
`contracts/script/DeployRwaLp.s.sol` only when it broadcasts. `pnpm lp:status` reads every manifest here.

The directory is empty until a human approves a mainnet deployment (CLAUDE.md rule 5,
docs/RWA_LP.md §5). Dry runs and local fork rehearsals write nothing here.
