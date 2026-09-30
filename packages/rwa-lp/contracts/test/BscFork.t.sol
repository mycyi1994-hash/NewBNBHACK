// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IBStockMultiplier} from "../interfaces/IBStockMultiplier.sol";
import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";
import {PoolPriceMath} from "../libraries/PoolPriceMath.sol";
import {KeeperReferenceOracle} from "../KeeperReferenceOracle.sol";
import {NyseMarketCalendar} from "../NyseMarketCalendar.sol";
import {RwaLiquidityVault} from "../RwaLiquidityVault.sol";
import {RwaSessionHook} from "../RwaSessionHook.sol";

/// @notice The whole system on BSC mainnet state: the deployed Uniswap v4 PoolManager (v4-core 1.0.2,
/// DECISIONS D-29), BSC-USD and real tokenized stocks. Token addresses come from the recorded RWA Data
/// API response (fixtures/rwa), never from code (DECISIONS D-07). Nothing is broadcast: this runs on a
/// local fork. Skipped unless BSC_FORK_URL is set, e.g.
/// `BSC_FORK_URL=https://bsc-dataseed.bnbchain.org forge test --match-path contracts/test/BscFork.t.sol`.
contract BscForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF);
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955; // SPEC §3.4
    string internal constant RWA_FIXTURE = "../../fixtures/rwa/getRwaTokenList-20260924-1.json";

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal trader = makeAddr("trader");
    address internal reporter = makeAddr("reporter");

    NyseMarketCalendar internal calendar;
    RwaSessionHook internal hook;
    KeeperReferenceOracle internal oracle;
    PoolSwapTest internal router;

    function setUp() public {
        string memory url = vm.envOr("BSC_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 forkBlock = vm.envOr("BSC_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, forkBlock);

        calendar = new NyseMarketCalendar(owner);
        address hookAddress = address(
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG)
                ^ (uint160(0x5956) << 144)
        );
        deployCodeTo("RwaSessionHook.sol:RwaSessionHook", abi.encode(POOL_MANAGER, calendar, owner), hookAddress);
        hook = RwaSessionHook(hookAddress);
        oracle = new KeeperReferenceOracle(owner, 5 minutes);
        router = new PoolSwapTest(POOL_MANAGER);
        vm.startPrank(owner);
        hook.setQuoteToken(USDT, true);
        hook.setReferenceSource(oracle);
        oracle.setReporter(reporter, true);
        vm.stopPrank();
    }

    /// The token address of `symbol` in the recorded RWA Data API token list.
    function _fromRegistryFixture(string memory symbol) internal view returns (address) {
        string memory json = vm.readFile(RWA_FIXTURE);
        string memory path =
            string.concat(".response.body.data[?(@.tokenSymbol == '", symbol, "')].tokenContractAddress");
        return vm.parseJsonAddress(json, path);
    }

    /// Moves time to the next regular session, past the opening ramp.
    function _warpToRegularSession() internal {
        for (uint256 i; i < 24 * 8; ++i) {
            (IMarketCalendar.Session session, uint256 openedAt) = calendar.sessionAt(block.timestamp);
            if (session == IMarketCalendar.Session.Regular && block.timestamp - openedAt >= 1 hours) return;
            vm.warp(block.timestamp + 1 hours);
        }
        revert("no regular session within 8 days");
    }

    function _warpToOvernight() internal {
        for (uint256 i; i < 24 * 8; ++i) {
            (IMarketCalendar.Session session,) = calendar.sessionAt(block.timestamp);
            if (session == IMarketCalendar.Session.Overnight) return;
            vm.warp(block.timestamp + 1 hours);
        }
        revert("no overnight session within 8 days");
    }

    function _fees() internal pure returns (RwaSessionHook.FeeSchedule memory) {
        return RwaSessionHook.FeeSchedule({
            regularFee: 500,
            extendedFee: 3000,
            closedFee: 10_000,
            maxFee: 30_000,
            openingRamp: 30 minutes,
            gapCaptureBps: 5000,
            maxReferenceAge: 15 minutes,
            corporateActionWindow: 1 days
        });
    }

    /// sqrt price for `priceE18` USD per stock token, both tokens 18 decimals.
    function _sqrtPriceAt(uint256 priceE18, bool rwaIsCurrency0) internal pure returns (uint160) {
        uint256 low = TickMath.MIN_SQRT_PRICE;
        uint256 high = TickMath.MAX_SQRT_PRICE;
        // Binary search on the library the hook itself uses, so the pool starts exactly where we say.
        while (high - low > 1) {
            uint256 mid = (low + high) / 2;
            uint256 p = PoolPriceMath.rwaPriceE18(uint160(mid), rwaIsCurrency0, 18, 18);
            bool tooHigh = rwaIsCurrency0 ? p > priceE18 : p < priceE18;
            if (tooHigh) high = mid;
            else low = mid;
        }
        return uint160(low);
    }

    struct Pool {
        address stock;
        PoolKey key;
        PoolId id;
        RwaLiquidityVault vault;
        bool rwaIsCurrency0;
    }

    function _createPool(address stock, bool bStock, uint256 priceE18) internal returns (Pool memory p) {
        p.stock = stock;
        p.rwaIsCurrency0 = stock < USDT;
        vm.startPrank(owner);
        (p.key, p.id) = hook.createPool(
            RwaSessionHook.PoolSettings({
                rwaToken: stock,
                quoteToken: USDT,
                tickSpacing: 60,
                sqrtPriceX96: _sqrtPriceAt(priceE18, p.rwaIsCurrency0),
                bStockMultiplier: bStock,
                liquidityGate: address(hook),
                fees: _fees()
            })
        );
        p.vault = new RwaLiquidityVault(POOL_MANAGER, p.key, "Yieldvest LP", "yvLP", owner);
        hook.setLiquidityGate(p.id, address(p.vault));
        vm.stopPrank();
    }

    function _deposit(Pool memory p, uint256 shares) internal returns (uint256 amount0, uint256 amount1) {
        (uint256 need0, uint256 need1) = p.vault.previewDeposit(shares);
        address token0 = Currency.unwrap(p.key.currency0);
        address token1 = Currency.unwrap(p.key.currency1);
        deal(token0, alice, need0);
        deal(token1, alice, need1);
        vm.startPrank(alice);
        IERC20Metadata(token0).approve(address(p.vault), need0); // exact-amount approvals only
        IERC20Metadata(token1).approve(address(p.vault), need1);
        (amount0, amount1) = p.vault.deposit(shares, need0, need1, alice, block.timestamp);
        vm.stopPrank();
    }

    function _swap(Pool memory p, bool buyStock, uint256 amountIn) internal returns (BalanceDelta delta) {
        bool zeroForOne = buyStock != p.rwaIsCurrency0;
        address tokenIn = buyStock ? USDT : p.stock;
        deal(tokenIn, trader, amountIn);
        vm.startPrank(trader);
        IERC20Metadata(tokenIn).approve(address(router), amountIn);
        delta = router.swap(
            p.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function test_bStocksNvdaThroughTheDeployedPoolManager() public {
        address nvdab = _fromRegistryFixture("NVDAB");
        assertEq(IERC20Metadata(nvdab).symbol(), "NVDAB");
        assertEq(IERC20Metadata(nvdab).decimals(), 18);
        uint256 multiplier = IBStockMultiplier(nvdab).uiMultiplier();
        assertGe(multiplier, 1e18);

        vm.prank(owner);
        oracle.configureToken(nvdab, KeeperReferenceOracle.MultiplierSource.BStockOnChain);
        Pool memory p = _createPool(nvdab, true, 225e18);
        _warpToRegularSession();

        // Liquidity in, from real balances, through the real PoolManager.
        (uint256 in0, uint256 in1) = _deposit(p, 1e21);
        assertGt(in0, 0);
        assertGt(in1, 0);
        assertEq(p.vault.positionLiquidity(), 1e21);

        // Regular session, no reference: the regular fee.
        (uint24 fee,, RwaSessionHook.FeeReason reason) = hook.quoteFee(p.key, true);
        assertEq(fee, 500);
        assertEq(uint256(reason), uint256(RwaSessionHook.FeeReason.Regular));
        _swap(p, true, 500e18);
        _swap(p, false, 2e18);

        // A reference posted with the token's own multiplier: selling closes a premium, and pays for it.
        uint256 poolPrice = PoolPriceMath.rwaPriceE18(_sqrtPrice(p), p.rwaIsCurrency0, 18, 18);
        uint256 sharePrice = (poolPrice * 98 / 100) * 1e18 / multiplier; // the pool 2% above the reference
        KeeperReferenceOracle.Report[] memory reports = new KeeperReferenceOracle.Report[](1);
        reports[0] = KeeperReferenceOracle.Report({
            token: nvdab,
            sharePriceE18: uint128(sharePrice),
            multiplierE18: uint128(multiplier),
            observedAt: uint64(block.timestamp)
        });
        vm.prank(reporter);
        oracle.post(reports);
        (uint256 referenceE18,) = oracle.referencePrice(nvdab);
        assertEq(referenceE18, sharePrice * multiplier / 1e18);
        // Selling the stock is zeroForOne exactly when the stock is currency0.
        (fee,, reason) = hook.quoteFee(p.key, p.rwaIsCurrency0);
        assertEq(uint256(reason), uint256(RwaSessionHook.FeeReason.ReferenceGap));
        assertEq(fee, 500 + PoolPriceMath.gapPips(poolPrice, referenceE18) * 5000 / 10_000);
        assertApproxEqAbs(fee, 10_704, 5); // ≈ 0.05% + half of a 2.04% gap
        (fee,, reason) = hook.quoteFee(p.key, !p.rwaIsCurrency0); // buying widens the gap
        assertEq(fee, 500);
        _swap(p, false, 1e18);

        // Overnight: the closed fee.
        _warpToOvernight();
        (fee,, reason) = hook.quoteFee(p.key, true);
        assertEq(fee, 10_000);
        assertEq(uint256(reason), uint256(RwaSessionHook.FeeReason.Closed));
        _swap(p, true, 100e18);

        // Everything out again, fees included.
        uint256 shares = p.vault.balanceOf(alice);
        (uint256 p0, uint256 p1) = p.vault.previewWithdraw(shares);
        vm.prank(alice);
        (uint256 out0, uint256 out1) = p.vault.withdraw(shares, p0, p1, alice, block.timestamp);
        assertEq(IERC20Metadata(Currency.unwrap(p.key.currency0)).balanceOf(alice), out0);
        assertEq(IERC20Metadata(Currency.unwrap(p.key.currency1)).balanceOf(alice), out1);
    }

    function test_ondoNvdaThroughTheDeployedPoolManager() public {
        address nvdaon = _fromRegistryFixture("NVDAon");
        assertEq(IERC20Metadata(nvdaon).symbol(), "NVDAon");
        vm.prank(owner);
        oracle.configureToken(nvdaon, KeeperReferenceOracle.MultiplierSource.Reported);
        Pool memory p = _createPool(nvdaon, false, 225e18);
        _warpToRegularSession();

        _deposit(p, 1e21);
        _swap(p, true, 500e18);
        _swap(p, false, 2e18);
        (uint256 fees0, uint256 fees1) = p.vault.pendingFees();
        assertGt(fees0 + fees1, 0);

        uint256 shares = p.vault.balanceOf(alice);
        vm.prank(alice);
        p.vault.withdraw(shares, 0, 0, alice, block.timestamp);
        assertEq(p.vault.balanceOf(alice), 0);
    }

    function _sqrtPrice(Pool memory p) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(p.id);
    }
}
