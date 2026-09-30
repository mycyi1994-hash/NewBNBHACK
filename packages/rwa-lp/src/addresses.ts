/**
 * Uniswap v4 on BNB Smart Chain (chain 56). Source: Uniswap/contracts `deployments/56.md`, checked
 * on chain on 2026-09-30 (DECISIONS D-29): StateView, PositionManager and V4Quoter each answer
 * `poolManager()` with the PoolManager below, and the PoolManager's runtime bytecode equals the
 * `@uniswap/v4-core@1.0.2` artifact once its one immutable is masked. Stock token addresses are
 * never constants: they come from the RWA registry (DECISIONS D-07).
 */
export const UNISWAP_V4_BSC = {
  chainId: 56,
  poolManager: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF',
  positionManager: '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b',
  stateView: '0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4',
  quoter: '0x9F75dD27D6664c475B90e105573E550ff69437B0',
  universalRouter: '0xDc264714F68d84CF29BC605589405E78bDBE7C9f',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const;

/** The deterministic CREATE2 deployer the deploy script mines the hook address against. */
export const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

/** The hook's permission bits: beforeInitialize | beforeAddLiquidity | beforeSwap. */
export const RWA_SESSION_HOOK_FLAGS = (1 << 13) | (1 << 11) | (1 << 7);
