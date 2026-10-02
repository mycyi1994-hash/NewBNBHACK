# @yieldvest/rwa-lp

Session-aware liquidity for tokenized stocks on Uniswap v4 (BSC). Design, safety properties,
evidence and the deploy runbook: [`docs/RWA_LP.md`](../../docs/RWA_LP.md).

```
contracts/                 Solidity (Foundry): RwaSessionHook, RwaLiquidityVault,
                           KeeperReferenceOracle, NyseMarketCalendar, libraries
contracts/test/            unit, fuzz, invariant, calendar-vector and BSC fork tests
contracts/script/          DeployRwaLp.s.sol (CREATE2-mined hook address) and HookMiner
src/                       TypeScript: ABIs (generated), Uniswap v4 BSC addresses, manifests,
                           price math, read-only status reader
vectors/nyse-sessions.json generated from packages/core/src/session.ts (pnpm lp:vectors)
deployments/               one manifest per deployed pool (empty until a human deploys)
```

```bash
pnpm lp:build && pnpm lp:test          # forge build / test (Foundry 1.5.1)
BSC_FORK_URL=https://bsc-dataseed.bnbchain.org pnpm lp:test   # + BSC mainnet fork suite
pnpm lp:abi                            # regenerate src/abi.ts after a contract change
pnpm lp:vectors                        # regenerate the calendar vectors after a session.ts change
```
