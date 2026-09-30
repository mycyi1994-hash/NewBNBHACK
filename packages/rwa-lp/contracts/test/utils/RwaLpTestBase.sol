// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {KeeperReferenceOracle} from "../../KeeperReferenceOracle.sol";
import {NyseMarketCalendar} from "../../NyseMarketCalendar.sol";
import {RwaLiquidityVault} from "../../RwaLiquidityVault.sol";
import {RwaSessionHook} from "../../RwaSessionHook.sol";
import {PoolPriceMath} from "../../libraries/PoolPriceMath.sol";

/// @notice A bStocks-like token: ERC-20 plus the BEP-677 multiplier getters (tests only).
contract MockBStock is MockERC20 {
    uint256 internal _uiMultiplier = 1e18;
    uint256 internal _newUIMultiplier = 1e18;
    uint256 internal _effectiveAt;
    bool public broken;

    constructor() MockERC20("NVIDIA (bStocks)", "NVDAB", 18) {}

    function uiMultiplier() external view returns (uint256) {
        require(!broken, "broken");
        return _current();
    }

    function newUIMultiplier() external view returns (uint256) {
        require(!broken, "broken");
        return _newUIMultiplier;
    }

    function effectiveAt() external view returns (uint256) {
        require(!broken, "broken");
        return _effectiveAt;
    }

    /// @dev Schedules `multiplier` for `at`; whatever is in force now stays in force until then.
    function schedule(uint256 multiplier, uint256 at) external {
        _uiMultiplier = _current();
        _newUIMultiplier = multiplier;
        _effectiveAt = at;
    }

    function _current() internal view returns (uint256) {
        return _effectiveAt != 0 && block.timestamp >= _effectiveAt ? _newUIMultiplier : _uiMultiplier;
    }

    function setBroken(bool broken_) external {
        broken = broken_;
    }
}

/// @notice Local PoolManager (the v4-core 1.0.2 build that runs on BSC), a USDT-like quote token,
/// a bStocks-like stock token, the calendar, the hook, the oracle and a vault for one pool.
abstract contract RwaLpTestBase is Test {
    using StateLibrary for IPoolManager;
    // Tuesday 6 October 2026 (New York is on EDT, UTC−4) and a few other session instants.
    uint256 internal constant TUE_OPEN = 1_791_293_400; // 09:30 New York
    uint256 internal constant TUE_REGULAR = 1_791_298_800; // 11:00
    uint256 internal constant TUE_PRE = 1_791_288_000; // 08:00
    uint256 internal constant TUE_POST = 1_791_320_400; // 17:00
    uint256 internal constant TUE_OVERNIGHT = 1_791_338_400; // 22:00
    uint256 internal constant SATURDAY = 1_791_644_400; // Sat 10 Oct 2026 11:00
    uint256 internal constant THANKSGIVING = 1_795_705_200; // Thu 26 Nov 2026 10:00 (EST)

    uint256 internal constant START_PRICE = 225e18; // USD per stock token

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal reporter = makeAddr("reporter");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    IPoolManager internal manager;
    NyseMarketCalendar internal calendar;
    RwaSessionHook internal hook;
    KeeperReferenceOracle internal oracle;
    MockBStock internal stock;
    MockERC20 internal usdt;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    RwaLiquidityVault internal vault;
    PoolKey internal key;
    PoolId internal id;

    /// @dev Overridden to put the stock token on the currency1 side.
    function rwaIsCurrency0() internal pure virtual returns (bool) {
        return true;
    }

    function defaultFees() internal pure returns (RwaSessionHook.FeeSchedule memory) {
        return RwaSessionHook.FeeSchedule({
            regularFee: 500, // 0.05%
            extendedFee: 3000, // 0.30%
            closedFee: 10_000, // 1.00%
            maxFee: 30_000, // 3.00%
            openingRamp: 30 minutes,
            gapCaptureBps: 5000, // half of the gap a swap closes
            maxReferenceAge: 15 minutes,
            corporateActionWindow: 1 days
        });
    }

    function hookFlags() internal pure returns (uint160) {
        return uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);
    }

    function setUp() public virtual {
        vm.warp(TUE_REGULAR);
        manager = IPoolManager(
            deployCode("node_modules/@uniswap/v4-core/out/PoolManager.sol/PoolManager.json", abi.encode(address(this)))
        );
        calendar = new NyseMarketCalendar(owner);

        address hookAddress = address(hookFlags() ^ (uint160(0x4444) << 144));
        deployCodeTo("RwaSessionHook.sol:RwaSessionHook", abi.encode(manager, calendar, owner), hookAddress);
        hook = RwaSessionHook(hookAddress);
        oracle = new KeeperReferenceOracle(owner, 5 minutes);

        // Fixed token addresses make the pool orientation deterministic.
        (address low, address high) = (address(0x1000000000000000000000000000000000000001), address(0x2000000000000000000000000000000000000002));
        (address stockAt, address usdtAt) = rwaIsCurrency0() ? (low, high) : (high, low);
        deployCodeTo("RwaLpTestBase.sol:MockBStock", stockAt);
        deployCodeTo(
            "node_modules/@uniswap/v4-core/lib/solmate/src/test/utils/mocks/MockERC20.sol:MockERC20",
            abi.encode("Tether USD", "USDT", uint8(18)),
            usdtAt
        );
        stock = MockBStock(stockAt);
        usdt = MockERC20(usdtAt);

        vm.startPrank(owner);
        hook.setQuoteToken(address(usdt), true);
        hook.setGuardian(guardian);
        hook.setReferenceSource(oracle);
        oracle.setReporter(reporter, true);
        oracle.configureToken(address(stock), KeeperReferenceOracle.MultiplierSource.BStockOnChain);
        (key, id) = hook.createPool(
            RwaSessionHook.PoolSettings({
                rwaToken: address(stock),
                quoteToken: address(usdt),
                tickSpacing: 60,
                sqrtPriceX96: sqrtPriceAt(START_PRICE),
                bStockMultiplier: true,
                liquidityGate: address(hook), // nobody can add until the vault is wired
                fees: defaultFees()
            })
        );
        vault = new RwaLiquidityVault(manager, key, "Yieldvest NVDAB-USDT LP", "yvLP-NVDAB", owner);
        hook.setLiquidityGate(id, address(vault));
        vault.setOperator(operator);
        vm.stopPrank();

        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);
        stock.approve(address(swapRouter), type(uint256).max);
        usdt.approve(address(swapRouter), type(uint256).max);
    }

    // ---------------------------------------------------------------- prices

    /// @dev sqrt price of the pool when one stock token is worth `priceE18` USD.
    function sqrtPriceAt(uint256 priceE18) internal pure returns (uint160) {
        uint256 ratioX192 = rwaIsCurrency0()
            ? FullMath.mulDiv(priceE18, 1 << 192, 1e18) // USDT per stock
            : FullMath.mulDiv(1e18, 1 << 192, priceE18); // stock per USDT
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }

    function poolPriceE18() internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(id);
        return PoolPriceMath.rwaPriceE18(sqrtPriceX96, rwaIsCurrency0(), 18, 18);
    }

    function lpFeeInSlot0() internal view returns (uint24 lpFee) {
        (,,, lpFee) = manager.getSlot0(id);
    }

    /// @dev The ERC-7751 error Uniswap v4 raises when a hook call reverts with `reason`.
    function hookError(bytes4 hookSelector, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookSelector,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    // ---------------------------------------------------------------- actions

    /// @dev Swaps as this test contract; `buyStock` pays USDT, otherwise pays stock. Exact input.
    function swapExactIn(bool buyStock, uint256 amountIn) internal returns (BalanceDelta) {
        fundSwap(buyStock, amountIn);
        return rawSwap(buyStock, amountIn);
    }

    function fundSwap(bool buyStock, uint256 amountIn) internal {
        if (buyStock) usdt.mint(address(this), amountIn);
        else stock.mint(address(this), amountIn);
    }

    /// @dev The swap alone (one external call), for tests that expect events from it.
    function rawSwap(bool buyStock, uint256 amountIn) internal returns (BalanceDelta) {
        bool zeroForOne = buyStock != rwaIsCurrency0(); // paying currency0 means zeroForOne
        return swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev `who` deposits `shares`, paying exactly what previewDeposit quotes (exact approvals).
    function depositAs(address who, uint256 shares) internal returns (uint256 amount0, uint256 amount1) {
        (uint256 need0, uint256 need1) = vault.previewDeposit(shares);
        _fund(who, need0, need1);
        vm.startPrank(who);
        _approve(need0, need1);
        (amount0, amount1) = vault.deposit(shares, need0, need1, who, block.timestamp);
        vm.stopPrank();
    }

    function _fund(address who, uint256 amount0, uint256 amount1) internal {
        (MockERC20 token0, MockERC20 token1) = _tokens();
        token0.mint(who, amount0);
        token1.mint(who, amount1);
    }

    function _approve(uint256 amount0, uint256 amount1) internal {
        (MockERC20 token0, MockERC20 token1) = _tokens();
        token0.approve(address(vault), amount0);
        token1.approve(address(vault), amount1);
    }

    function _tokens() internal view returns (MockERC20 token0, MockERC20 token1) {
        return rwaIsCurrency0() ? (MockERC20(stock), usdt) : (usdt, MockERC20(stock));
    }

    function postReference(uint256 sharePriceE18) internal {
        postReference(sharePriceE18, stock.uiMultiplier(), uint64(block.timestamp));
    }

    function postReference(uint256 sharePriceE18, uint256 multiplierE18, uint64 observedAt) internal {
        KeeperReferenceOracle.Report[] memory reports = new KeeperReferenceOracle.Report[](1);
        reports[0] = KeeperReferenceOracle.Report({
            token: address(stock),
            sharePriceE18: uint128(sharePriceE18),
            multiplierE18: uint128(multiplierE18),
            observedAt: observedAt
        });
        vm.prank(reporter);
        oracle.post(reports);
    }
}
