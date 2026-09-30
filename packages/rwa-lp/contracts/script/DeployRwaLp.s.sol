// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {IBStockMultiplier} from "../interfaces/IBStockMultiplier.sol";
import {PoolPriceMath} from "../libraries/PoolPriceMath.sol";
import {KeeperReferenceOracle} from "../KeeperReferenceOracle.sol";
import {NyseMarketCalendar} from "../NyseMarketCalendar.sol";
import {RwaLiquidityVault} from "../RwaLiquidityVault.sol";
import {RwaSessionHook} from "../RwaSessionHook.sol";
import {HookMiner} from "./HookMiner.sol";

/// @title Deploys the RWA liquidity stack for one tokenized stock (docs/RWA_LP.md §5)
/// @notice Calendar → hook (CREATE2, mined address) → reference oracle → dynamic-fee pool → vault.
/// Moves no tokens: the pool starts empty and closed to liquidity until the vault is wired in.
///
/// Dry run against BSC state (nothing is signed or sent):
///   RWA_TOKEN=<address from the RWA registry> RWA_PRICE_E18=<USD per token, 1e18> \
///     forge script contracts/script/DeployRwaLp.s.sol --fork-url "$BSC_RPC_URL"
/// A live deployment adds `--broadcast` and a key. It is a new on-chain spend (gas) and needs a
/// human yes first (CLAUDE.md rule 5); the deployer key must not be the house wallet.
///
/// Environment: RWA_TOKEN and RWA_PRICE_E18 are required. Optional: POOL_MANAGER and QUOTE_TOKEN
/// (default: Uniswap v4 PoolManager and BSC-USD on BSC), RWA_BSTOCK_MULTIPLIER (default: probed),
/// TICK_SPACING (60), LP_OWNER (default: the deployer; any other owner must accept ownership),
/// ORACLE_MAX_REPORT_DELAY seconds (300).
contract DeployRwaLp is Script {
    /// Uniswap v4 PoolManager on BSC (Uniswap/contracts deployments/56.md; bytecode = v4-core 1.0.2, D-29).
    address internal constant BSC_POOL_MANAGER = 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF;
    /// BSC-USD (SPEC §3.4).
    address internal constant BSC_USDT = 0x55d398326f99059fF775485246999027B3197955;

    struct Deployment {
        NyseMarketCalendar calendar;
        RwaSessionHook hook;
        KeeperReferenceOracle oracle;
        RwaLiquidityVault vault;
        PoolKey key;
        PoolId id;
    }

    /// @notice Agent proposal (DECISIONS D-29); the owner can change it after deployment.
    function defaultFees() public pure returns (RwaSessionHook.FeeSchedule memory) {
        return RwaSessionHook.FeeSchedule({
            regularFee: 500, // 0.05%
            extendedFee: 3000, // 0.30%
            closedFee: 10_000, // 1.00%
            maxFee: 30_000, // 3.00%
            openingRamp: 30 minutes,
            gapCaptureBps: 5000,
            maxReferenceAge: 15 minutes,
            corporateActionWindow: 1 days
        });
    }

    struct Params {
        IPoolManager manager;
        address quote;
        address rwa;
        uint256 priceE18;
        bool bStock;
        int24 tickSpacing;
        uint64 maxReportDelay;
        string symbol;
        uint160 sqrtPriceX96;
    }

    function run() external returns (Deployment memory) {
        return deploy(_params(), vm.envOr("LP_OWNER", address(0)));
    }

    /// @param finalOwner Owner after deployment; zero keeps the deployer.
    function deploy(Params memory p, address finalOwner) public returns (Deployment memory d) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = _deploy(p, deployer);
        if (finalOwner == address(0)) finalOwner = deployer;
        if (finalOwner != deployer) {
            // Ownable2Step: the new owner finishes each handover with acceptOwnership().
            d.calendar.transferOwnership(finalOwner);
            d.hook.transferOwnership(finalOwner);
            d.oracle.transferOwnership(finalOwner);
            d.vault.transferOwnership(finalOwner);
        }
        vm.stopBroadcast();
        _report(d, p, finalOwner);
    }

    function _params() internal view returns (Params memory) {
        address rwa = vm.envAddress("RWA_TOKEN");
        return params(
            IPoolManager(vm.envOr("POOL_MANAGER", BSC_POOL_MANAGER)),
            vm.envOr("QUOTE_TOKEN", BSC_USDT),
            rwa,
            vm.envUint("RWA_PRICE_E18"),
            vm.envOr("RWA_BSTOCK_MULTIPLIER", _hasBStockMultiplier(rwa)),
            int24(vm.envOr("TICK_SPACING", int256(60))),
            uint64(vm.envOr("ORACLE_MAX_REPORT_DELAY", uint256(300)))
        );
    }

    /// @notice Deployment parameters, with the token symbol and the initial sqrt price derived.
    function params(
        IPoolManager manager,
        address quote,
        address rwa,
        uint256 priceE18,
        bool bStock,
        int24 tickSpacing,
        uint64 maxReportDelay
    ) public view returns (Params memory p) {
        p.manager = manager;
        p.quote = quote;
        p.rwa = rwa;
        p.priceE18 = priceE18;
        p.bStock = bStock;
        p.tickSpacing = tickSpacing;
        p.maxReportDelay = maxReportDelay;
        p.symbol = IERC20Metadata(rwa).symbol();
        p.sqrtPriceX96 = PoolPriceMath.sqrtPriceAtE18(
            priceE18, rwa < quote, IERC20Metadata(rwa).decimals(), IERC20Metadata(quote).decimals()
        );
    }

    function _deploy(Params memory p, address deployer) internal returns (Deployment memory d) {
        d.calendar = new NyseMarketCalendar(deployer);
        d.hook = _deployHook(p.manager, d.calendar, deployer);
        d.oracle = new KeeperReferenceOracle(deployer, p.maxReportDelay);
        d.hook.setQuoteToken(p.quote, true);
        d.hook.setReferenceSource(d.oracle);
        d.oracle.configureToken(
            p.rwa,
            p.bStock ? KeeperReferenceOracle.MultiplierSource.BStockOnChain : KeeperReferenceOracle.MultiplierSource.Reported
        );
        (d.key, d.id) = d.hook.createPool(
            RwaSessionHook.PoolSettings({
                rwaToken: p.rwa,
                quoteToken: p.quote,
                tickSpacing: p.tickSpacing,
                sqrtPriceX96: p.sqrtPriceX96,
                bStockMultiplier: p.bStock,
                liquidityGate: address(d.hook), // closed until the vault below exists
                fees: defaultFees()
            })
        );
        d.vault = new RwaLiquidityVault(
            p.manager,
            d.key,
            string.concat("Yieldvest ", p.symbol, "-", IERC20Metadata(p.quote).symbol(), " LP"),
            string.concat("yvLP-", p.symbol),
            deployer
        );
        d.hook.setLiquidityGate(d.id, address(d.vault));
    }

    function _deployHook(IPoolManager manager, NyseMarketCalendar calendar, address owner)
        internal
        returns (RwaSessionHook hook)
    {
        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);
        bytes memory args = abi.encode(manager, calendar, owner);
        (address expected, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(RwaSessionHook).creationCode, args);
        hook = new RwaSessionHook{salt: salt}(manager, calendar, owner);
        require(address(hook) == expected, "hook landed at an unexpected address");
    }

    function _hasBStockMultiplier(address token) internal view returns (bool) {
        try IBStockMultiplier(token).effectiveAt() returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    function _report(Deployment memory d, Params memory p, address owner) internal {
        console2.log("chain id", block.chainid);
        console2.log("rwa token", p.symbol, p.rwa);
        console2.log("quote token", p.quote);
        console2.log("bStocks multiplier", p.bStock);
        console2.log("initial price (USD per token, 1e18)", p.priceE18);
        console2.log("NyseMarketCalendar", address(d.calendar));
        console2.log("RwaSessionHook", address(d.hook));
        console2.log("KeeperReferenceOracle", address(d.oracle));
        console2.log("RwaLiquidityVault", address(d.vault));
        console2.log("pool id");
        console2.logBytes32(PoolId.unwrap(d.id));
        console2.log("owner (pending until accepted if not the deployer)", owner);

        // Only a broadcast leaves a manifest; a dry run changes nothing on disk.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return;
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeString(o, "rwaSymbol", p.symbol);
        vm.serializeAddress(o, "rwaToken", p.rwa);
        vm.serializeAddress(o, "quoteToken", p.quote);
        vm.serializeAddress(o, "poolManager", address(d.hook.poolManager()));
        vm.serializeAddress(o, "calendar", address(d.calendar));
        vm.serializeAddress(o, "hook", address(d.hook));
        vm.serializeAddress(o, "oracle", address(d.oracle));
        vm.serializeAddress(o, "vault", address(d.vault));
        vm.serializeAddress(o, "currency0", Currency.unwrap(d.key.currency0));
        vm.serializeAddress(o, "currency1", Currency.unwrap(d.key.currency1));
        vm.serializeUint(o, "fee", d.key.fee);
        vm.serializeInt(o, "tickSpacing", d.key.tickSpacing);
        string memory json = vm.serializeBytes32(o, "poolId", PoolId.unwrap(d.id));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-", p.symbol, ".json"));
    }
}
