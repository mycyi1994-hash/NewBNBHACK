// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {IBStockMultiplier} from "../interfaces/IBStockMultiplier.sol";
import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";
import {IReferencePriceSource} from "../interfaces/IReferencePriceSource.sol";
import {PoolPriceMath} from "../libraries/PoolPriceMath.sol";
import {RwaSessionHook} from "../RwaSessionHook.sol";
import {RwaLpTestBase} from "./utils/RwaLpTestBase.sol";

contract RevertingSource is IReferencePriceSource {
    function referencePrice(address) external pure returns (uint256, uint256) {
        revert("down");
    }
}

/// Answers with one word instead of two.
contract MalformedSource {
    fallback() external {
        assembly {
            mstore(0, 150000000000000000000)
            return(0, 32)
        }
    }
}

/// Burns every unit of gas it is given.
contract GasBurningSource is IReferencePriceSource {
    function referencePrice(address) external view returns (uint256, uint256) {
        uint256 i;
        while (gasleft() > 0) ++i;
        return (i, block.timestamp);
    }
}

contract FixedSource is IReferencePriceSource {
    uint256 internal immutable price;
    uint256 internal immutable at;

    constructor(uint256 price_, uint256 at_) {
        price = price_;
        at = at_;
    }

    function referencePrice(address) external view returns (uint256, uint256) {
        return (price, at);
    }
}

contract RwaSessionHookTest is RwaLpTestBase {
    using PoolIdLibrary for PoolKey;

    event SwapFeeApplied(
        PoolId indexed id, IMarketCalendar.Session session, RwaSessionHook.FeeReason reason, uint24 fee
    );

    uint256 internal constant LIQUIDITY = 1e21; // ≈ 66.7 stock tokens and 15,000 USDT at 225

    function setUp() public override {
        super.setUp();
        depositAs(alice, LIQUIDITY);
    }

    function _assertQuote(
        bool buyStock,
        uint24 fee,
        IMarketCalendar.Session session,
        RwaSessionHook.FeeReason reason
    ) internal view {
        bool zeroForOne = buyStock != rwaIsCurrency0();
        (uint24 quoted, IMarketCalendar.Session quotedSession, RwaSessionHook.FeeReason quotedReason) =
            hook.quoteFee(key, zeroForOne);
        assertEq(quoted, fee, "fee");
        assertEq(uint256(quotedSession), uint256(session), "session");
        assertEq(uint256(quotedReason), uint256(reason), "reason");
    }

    /// Quotes, then swaps and checks the hook's event: the fee a swap pays is the fee quoted.
    function _assertSwapFee(
        bool buyStock,
        uint24 fee,
        IMarketCalendar.Session session,
        RwaSessionHook.FeeReason reason
    ) internal {
        _assertQuote(buyStock, fee, session, reason);
        uint256 amountIn = buyStock ? 100e18 : 0.5e18;
        fundSwap(buyStock, amountIn);
        vm.expectEmit(address(hook));
        emit SwapFeeApplied(id, session, reason, fee);
        rawSwap(buyStock, amountIn);
    }

    // ---------------------------------------------------------------- session fees

    function test_theFeeFollowsTheNyseSession() public {
        vm.warp(TUE_REGULAR);
        _assertSwapFee(true, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
        vm.warp(TUE_PRE);
        _assertSwapFee(true, 3000, IMarketCalendar.Session.Pre, RwaSessionHook.FeeReason.Extended);
        vm.warp(TUE_POST);
        _assertSwapFee(false, 3000, IMarketCalendar.Session.Post, RwaSessionHook.FeeReason.Extended);
        vm.warp(TUE_OVERNIGHT);
        _assertSwapFee(true, 10_000, IMarketCalendar.Session.Overnight, RwaSessionHook.FeeReason.Closed);
        vm.warp(SATURDAY);
        _assertSwapFee(false, 10_000, IMarketCalendar.Session.Weekend, RwaSessionHook.FeeReason.Closed);
        vm.warp(THANKSGIVING);
        _assertSwapFee(true, 10_000, IMarketCalendar.Session.Holiday, RwaSessionHook.FeeReason.Closed);
    }

    function test_theClosedSessionFeeIsWhatTheSwapPays() public {
        vm.warp(SATURDAY);
        // A 1% fee on 10 USDT in leaves 9.90 to trade; compare with the same trade at a 0.05% fee.
        uint256 snapshot = vm.snapshotState();
        uint256 closedOut = _stockOut(swapExactIn(true, 10e18));
        vm.revertToState(snapshot);
        vm.warp(TUE_REGULAR);
        uint256 regularOut = _stockOut(swapExactIn(true, 10e18));
        assertApproxEqRel(closedOut * 1e6 / regularOut, uint256(990_000) * 1e6 / 999_500, 1e14);
    }

    function test_theOpeningRampFallsFromTheClosedToTheRegularFee() public {
        vm.warp(TUE_OPEN);
        _assertQuote(true, 10_000, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.OpeningRamp);
        vm.warp(TUE_OPEN + 15 minutes);
        _assertQuote(true, 5250, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.OpeningRamp);
        vm.warp(TUE_OPEN + 30 minutes - 1);
        _assertQuote(true, 506, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.OpeningRamp);
        vm.warp(TUE_OPEN + 30 minutes);
        _assertQuote(true, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
    }

    // ---------------------------------------------------------------- reference gap

    function _gapFee(uint256 referenceE18) internal view returns (uint24) {
        uint256 fee = 500 + PoolPriceMath.gapPips(poolPriceE18(), referenceE18) * 5000 / 10_000;
        return fee > 30_000 ? 30_000 : uint24(fee);
    }

    function test_onlyTheSwapThatClosesTheGapPaysForIt() public {
        vm.warp(TUE_REGULAR);
        postReference(220e18); // the pool (225) is dear: selling the stock closes the gap
        _assertSwapFee(false, _gapFee(220e18), IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.ReferenceGap);
        _assertSwapFee(true, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);

        vm.warp(TUE_REGULAR + 60);
        postReference(232e18); // now the pool is cheap: buying closes the gap
        _assertSwapFee(true, _gapFee(232e18), IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.ReferenceGap);
        _assertSwapFee(false, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
    }

    function test_theGapSurchargeIsCappedAtMaxFee() public {
        vm.warp(TUE_REGULAR);
        postReference(150e18);
        _assertSwapFee(false, 30_000, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.ReferenceGap);
    }

    function test_theGapSurchargeStacksOnTheOpeningRamp() public {
        vm.warp(TUE_OPEN + 15 minutes);
        postReference(220e18);
        uint256 expected = 5250 + PoolPriceMath.gapPips(poolPriceE18(), 220e18) * 5000 / 10_000;
        _assertQuote(false, uint24(expected), IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.ReferenceGap);
    }

    function test_aStaleReferenceIsIgnored() public {
        vm.warp(TUE_REGULAR);
        postReference(220e18);
        vm.warp(TUE_REGULAR + 15 minutes);
        _assertQuote(false, _gapFee(220e18), IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.ReferenceGap);
        vm.warp(TUE_REGULAR + 15 minutes + 1);
        _assertQuote(false, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
    }

    function test_theReferenceOnlyCountsInTheRegularSession() public {
        vm.warp(TUE_POST);
        postReference(150e18);
        _assertSwapFee(false, 3000, IMarketCalendar.Session.Post, RwaSessionHook.FeeReason.Extended);
    }

    function test_aFailingOrFutureReferenceNeverBlocksASwap() public {
        vm.warp(TUE_REGULAR);
        IReferencePriceSource[7] memory sources = [
            IReferencePriceSource(new RevertingSource()),
            IReferencePriceSource(address(new MalformedSource())),
            new GasBurningSource(),
            new FixedSource(150e18, block.timestamp + 1), // observed in the future
            new FixedSource(0, block.timestamp), // no price
            IReferencePriceSource(makeAddr("no code")),
            IReferencePriceSource(address(0)) // no source at all
        ];
        for (uint256 i; i < sources.length; ++i) {
            vm.prank(owner);
            hook.setReferenceSource(sources[i]);
            _assertSwapFee(false, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
        }
    }

    /// The swap's gas when `target` answers `call` with `answer` (mocked, so the answer itself
    /// costs nothing to produce), measured from the same state each time.
    function _swapGasWhenAnswered(address target, bytes memory call, bytes memory answer)
        internal
        returns (uint256 used)
    {
        uint256 snapshot = vm.snapshotState();
        vm.mockCall(target, call, answer);
        fundSwap(false, 0.5e18);
        uint256 gasBefore = gasleft();
        rawSwap(false, 0.5e18);
        used = gasBefore - gasleft();
        vm.clearMockedCalls();
        vm.revertToState(snapshot);
    }

    /// A reference source or a token that answers at length (a return-data bomb) costs the swap no
    /// more than one that answers nothing: the hook copies at most two words of any answer.
    function test_aLongAnswerCostsTheSwapNothingExtra() public {
        // Coverage builds are unoptimized and instrumented; their gas says nothing about the hook.
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) vm.skip(true);
        vm.warp(TUE_REGULAR);
        swapExactIn(false, 0.5e18); // warm the pool and the tokens
        bytes memory long = new bytes(150_000);
        bytes memory askPrice = abi.encodeCall(IReferencePriceSource.referencePrice, (address(stock)));
        bytes memory askEffectiveAt = abi.encodeCall(IBStockMultiplier.effectiveAt, ());
        uint256 silentSource = _swapGasWhenAnswered(address(oracle), askPrice, "");
        uint256 longSource = _swapGasWhenAnswered(address(oracle), askPrice, long);
        uint256 silentToken = _swapGasWhenAnswered(address(stock), askEffectiveAt, "");
        uint256 longToken = _swapGasWhenAnswered(address(stock), askEffectiveAt, long);
        console2.log("swap gas, reference answer empty / 150 kB:", silentSource, longSource);
        console2.log("swap gas, effectiveAt answer empty / 150 kB:", silentToken, longToken);
        assertApproxEqAbs(longSource, silentSource, 1_000);
        assertApproxEqAbs(longToken, silentToken, 1_000);
    }

    // ---------------------------------------------------------------- corporate actions

    function test_aScheduledMultiplierChangeChargesTheClosedFee() public {
        vm.warp(TUE_REGULAR);
        stock.schedule(1.01e18, TUE_REGULAR + 12 hours); // a dividend folded into the multiplier
        _assertSwapFee(true, 10_000, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.CorporateAction);
        vm.warp(TUE_REGULAR + 7 days); // the next Tuesday, well after the window
        _assertQuote(true, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
    }

    function test_theCorporateActionWindowIsInclusiveOnBothSides() public {
        stock.schedule(2e18, TUE_REGULAR + 1 days);
        vm.warp(TUE_REGULAR);
        _assertQuote(true, 10_000, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.CorporateAction);
        vm.warp(TUE_REGULAR - 1);
        _assertQuote(true, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
        vm.warp(TUE_REGULAR + 2 days);
        _assertQuote(true, 10_000, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.CorporateAction);
        vm.warp(TUE_REGULAR + 2 days + 1);
        _assertQuote(true, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
    }

    function test_anAbsurdEffectiveAtNeitherOverflowsNorBlocks() public {
        vm.warp(TUE_REGULAR);
        stock.schedule(2e18, type(uint256).max);
        _assertSwapFee(true, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
    }

    function test_anUnreadableMultiplierChargesTheClosedFee() public {
        vm.warp(TUE_REGULAR);
        stock.setBroken(true);
        _assertSwapFee(false, 10_000, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.CorporateAction);
    }

    function test_aZeroWindowIgnoresTheMultiplier() public {
        RwaSessionHook.FeeSchedule memory fees = defaultFees();
        fees.corporateActionWindow = 0;
        vm.prank(owner);
        hook.setFeeSchedule(id, fees);
        stock.setBroken(true);
        vm.warp(TUE_REGULAR);
        _assertQuote(false, 500, IMarketCalendar.Session.Regular, RwaSessionHook.FeeReason.Regular);
    }

    // ---------------------------------------------------------------- halts and gates

    function test_aHaltStopsSwapsAndDepositsButNotWithdrawals() public {
        vm.prank(guardian);
        hook.setHalted(id, true);

        fundSwap(true, 1e18);
        vm.expectRevert(
            hookError(IHooks.beforeSwap.selector, abi.encodeWithSelector(RwaSessionHook.PoolHalted.selector, id))
        );
        rawSwap(true, 1e18);

        (uint256 need0, uint256 need1) = vault.previewDeposit(1e18);
        _fund(bob, need0, need1);
        vm.startPrank(bob);
        _approve(need0, need1);
        vm.expectRevert(
            hookError(
                IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(RwaSessionHook.PoolHalted.selector, id)
            )
        );
        vault.deposit(1e18, need0, need1, ANY_LOWEST, ANY_HIGHEST, bob, block.timestamp);
        vm.stopPrank();

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        (uint256 out0, uint256 out1) = vault.withdraw(shares, 0, 0, alice, block.timestamp);
        assertGt(out0, 0);
        assertGt(out1, 0);

        vm.prank(owner);
        hook.setHalted(id, false);
        swapExactIn(true, 1e18);
    }

    function test_onlyTheGateMayAddLiquidity() public {
        ModifyLiquidityParams memory params = ModifyLiquidityParams({
            tickLower: TickMath.minUsableTick(60),
            tickUpper: TickMath.maxUsableTick(60),
            liquidityDelta: 1e18,
            salt: bytes32(0)
        });
        vm.expectRevert(
            hookError(
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(RwaSessionHook.LiquidityGated.selector, address(lpRouter))
            )
        );
        lpRouter.modifyLiquidity(key, params, "");

        vm.prank(owner);
        hook.setLiquidityGate(id, address(0)); // open to everyone
        stock.mint(address(this), 100e18);
        usdt.mint(address(this), 100_000e18);
        stock.approve(address(lpRouter), type(uint256).max);
        usdt.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(key, params, "");
    }

    function test_poolsWithThisHookAreOnlyCreatedByTheHook() public {
        PoolKey memory other = key;
        other.tickSpacing = 10;
        vm.expectRevert(
            hookError(
                IHooks.beforeInitialize.selector, abi.encodeWithSelector(RwaSessionHook.PoolsAreCreatedByTheHook.selector)
            )
        );
        manager.initialize(other, sqrtPriceAt(START_PRICE));
    }

    function test_createPoolWritesTheConfigAndUsesADynamicFee() public view {
        RwaSessionHook.PoolConfig memory config = hook.poolConfig(id);
        assertEq(config.rwaToken, address(stock));
        assertEq(config.rwaIsCurrency0, rwaIsCurrency0());
        assertEq(config.liquidityGate, address(vault));
        assertTrue(config.bStockMultiplier);
        assertEq(config.rwaDecimals, 18);
        assertEq(key.fee, LPFeeLibrary.DYNAMIC_FEE_FLAG);
        assertEq(address(key.hooks), address(hook));
        assertEq(lpFeeInSlot0(), 0);
    }

    function test_createPoolRejectsBadSettings() public {
        RwaSessionHook.PoolSettings memory s = RwaSessionHook.PoolSettings({
            rwaToken: address(stock),
            quoteToken: address(usdt),
            tickSpacing: 10,
            sqrtPriceX96: sqrtPriceAt(START_PRICE),
            bStockMultiplier: false,
            liquidityGate: address(0),
            fees: defaultFees()
        });
        vm.startPrank(owner);

        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        s.quoteToken = address(dai);
        vm.expectRevert(abi.encodeWithSelector(RwaSessionHook.QuoteTokenNotAllowed.selector, address(dai)));
        hook.createPool(s);

        s.quoteToken = address(usdt);
        s.rwaToken = address(usdt);
        vm.expectRevert(abi.encodeWithSelector(RwaSessionHook.InvalidRwaToken.selector, address(usdt)));
        hook.createPool(s);

        MockERC20 wide = new MockERC20("Wide", "WIDE", 24);
        s.rwaToken = address(wide);
        vm.expectRevert(abi.encodeWithSelector(RwaSessionHook.UnsupportedDecimals.selector, address(wide), uint8(24)));
        hook.createPool(s);

        MockERC20 plain = new MockERC20("Plain", "PLAIN", 18);
        s.rwaToken = address(plain);
        s.bStockMultiplier = true; // a token without the multiplier getters
        vm.expectRevert();
        hook.createPool(s);

        s.bStockMultiplier = false;
        s.fees.regularFee = 4000; // above the extended fee
        vm.expectRevert(RwaSessionHook.InvalidFeeSchedule.selector);
        hook.createPool(s);

        s.fees = defaultFees();
        s.fees.maxFee = 50_001;
        vm.expectRevert(RwaSessionHook.InvalidFeeSchedule.selector);
        hook.createPool(s);

        s.fees = defaultFees();
        s.rwaToken = address(stock);
        s.tickSpacing = 60; // the pool from setUp
        vm.expectRevert(Pool.PoolAlreadyInitialized.selector);
        hook.createPool(s);
        vm.stopPrank();

        s.tickSpacing = 10;
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        hook.createPool(s);
    }

    function test_feeScheduleBounds() public {
        vm.startPrank(owner);
        RwaSessionHook.FeeSchedule memory f = defaultFees();
        f.openingRamp = 2 hours + 1;
        vm.expectRevert(RwaSessionHook.InvalidFeeSchedule.selector);
        hook.setFeeSchedule(id, f);
        f = defaultFees();
        f.gapCaptureBps = 10_001;
        vm.expectRevert(RwaSessionHook.InvalidFeeSchedule.selector);
        hook.setFeeSchedule(id, f);
        f = defaultFees();
        f.maxReferenceAge = 1 hours + 1;
        vm.expectRevert(RwaSessionHook.InvalidFeeSchedule.selector);
        hook.setFeeSchedule(id, f);
        f = defaultFees();
        f.corporateActionWindow = 3 days + 1;
        vm.expectRevert(RwaSessionHook.InvalidFeeSchedule.selector);
        hook.setFeeSchedule(id, f);
        f = defaultFees();
        f.extendedFee = 20_000; // above the closed fee
        vm.expectRevert(RwaSessionHook.InvalidFeeSchedule.selector);
        hook.setFeeSchedule(id, f);
        f = defaultFees();
        f.closedFee = 40_000; // above the max fee
        vm.expectRevert(RwaSessionHook.InvalidFeeSchedule.selector);
        hook.setFeeSchedule(id, f);
        vm.stopPrank();
    }

    function test_adminFunctionsAreGuarded() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.expectRevert(notOwner);
        hook.setFeeSchedule(id, defaultFees());
        vm.expectRevert(notOwner);
        hook.setLiquidityGate(id, stranger);
        vm.expectRevert(notOwner);
        hook.setGuardian(stranger);
        vm.expectRevert(notOwner);
        hook.setReferenceSource(IReferencePriceSource(stranger));
        vm.expectRevert(notOwner);
        hook.setQuoteToken(stranger, true);
        vm.expectRevert(RwaSessionHook.NotGuardian.selector);
        hook.setHalted(id, true);
        vm.stopPrank();

        PoolId unknown = PoolId.wrap(bytes32(uint256(1)));
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(RwaSessionHook.UnknownPool.selector, unknown));
        hook.setHalted(unknown, true);
        vm.expectRevert(abi.encodeWithSelector(RwaSessionHook.UnknownPool.selector, unknown));
        hook.setFeeSchedule(unknown, defaultFees());
        vm.expectRevert(abi.encodeWithSelector(RwaSessionHook.UnknownPool.selector, unknown));
        hook.setLiquidityGate(unknown, address(0));
        vm.stopPrank();
    }

    function test_hookEntryPointsOnlyAnswerThePoolManager() public {
        SwapParams memory swapParams = SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0});
        ModifyLiquidityParams memory lpParams =
            ModifyLiquidityParams({tickLower: 0, tickUpper: 60, liquidityDelta: 1, salt: bytes32(0)});
        vm.expectRevert(RwaSessionHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, swapParams, "");
        vm.expectRevert(RwaSessionHook.NotPoolManager.selector);
        hook.beforeAddLiquidity(address(this), key, lpParams, "");
        vm.expectRevert(RwaSessionHook.NotPoolManager.selector);
        hook.beforeInitialize(address(this), key, 1);

        BalanceDelta zero;
        vm.expectRevert(RwaSessionHook.HookNotImplemented.selector);
        hook.afterInitialize(address(this), key, 1, 0);
        vm.expectRevert(RwaSessionHook.HookNotImplemented.selector);
        hook.afterAddLiquidity(address(this), key, lpParams, zero, zero, "");
        vm.expectRevert(RwaSessionHook.HookNotImplemented.selector);
        hook.beforeRemoveLiquidity(address(this), key, lpParams, "");
        vm.expectRevert(RwaSessionHook.HookNotImplemented.selector);
        hook.afterRemoveLiquidity(address(this), key, lpParams, zero, zero, "");
        vm.expectRevert(RwaSessionHook.HookNotImplemented.selector);
        hook.afterSwap(address(this), key, swapParams, zero, "");
        vm.expectRevert(RwaSessionHook.HookNotImplemented.selector);
        hook.beforeDonate(address(this), key, 0, 0, "");
        vm.expectRevert(RwaSessionHook.HookNotImplemented.selector);
        hook.afterDonate(address(this), key, 0, 0, "");
    }

    function test_theHookMustLiveAtAnAddressWithItsFlags() public {
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        assertTrue(uint160(next) & Hooks.ALL_HOOK_MASK != hookFlags());
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, next));
        new RwaSessionHook(manager, calendar, owner);
    }

    function test_quoteFeeRejectsAnUnknownPool() public {
        PoolKey memory other = key;
        other.tickSpacing = 1;
        vm.expectRevert(abi.encodeWithSelector(RwaSessionHook.UnknownPool.selector, other.toId()));
        hook.quoteFee(other, true);
    }

    /// Whatever the time, the reference and the direction: the fee stays inside the schedule and
    /// the swap goes through.
    function testFuzz_feeStaysInsideTheScheduleAndSwapsGoThrough(
        uint32 secondsIntoWeek,
        uint96 referenceE18,
        bool buyStock,
        uint64 amountIn
    ) public {
        vm.warp(TUE_OPEN - 2 days + bound(secondsIntoWeek, 0, 7 days));
        postReference(bound(referenceE18, 1e15, 1e24), 1e18, uint64(block.timestamp));
        bool zeroForOne = buyStock != rwaIsCurrency0();
        (uint24 fee, IMarketCalendar.Session session, RwaSessionHook.FeeReason reason) = hook.quoteFee(key, zeroForOne);
        assertGe(fee, 500);
        assertLe(fee, 30_000);
        uint256 amount = buyStock ? bound(amountIn, 1e12, 1000e18) : bound(amountIn, 1e9, 5e18);
        fundSwap(buyStock, amount);
        vm.expectEmit(address(hook));
        emit SwapFeeApplied(id, session, reason, fee);
        rawSwap(buyStock, amount);
    }

    /// What the hook adds to a swap in its most expensive state (regular session, fresh reference,
    /// bStocks multiplier read), against a hookless pool with the same liquidity on the same manager.
    function test_swapGasOverheadIsBounded() public {
        // Coverage builds are unoptimized and instrumented; their gas says nothing about the hook.
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) vm.skip(true);
        vm.warp(TUE_REGULAR);
        postReference(220e18);
        PoolKey memory plain = PoolKey({
            currency0: key.currency0,
            currency1: key.currency1,
            fee: 500,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(plain, sqrtPriceAt(START_PRICE));
        stock.mint(address(this), 1000e18);
        usdt.mint(address(this), 100_000e18);
        stock.approve(address(lpRouter), type(uint256).max);
        usdt.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            plain,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: int256(LIQUIDITY),
                salt: bytes32(0)
            }),
            ""
        );
        bool zeroForOne = rwaIsCurrency0(); // sell the stock: the side that closes the gap
        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -1e18,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        PoolSwapTest.TestSettings memory settings = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        stock.mint(address(this), 4e18);
        // Warm both pools once so neither measurement pays first-touch storage costs.
        swapRouter.swap(plain, params, settings, "");
        swapRouter.swap(key, params, settings, "");

        uint256 gasBefore = gasleft();
        swapRouter.swap(plain, params, settings, "");
        uint256 plainGas = gasBefore - gasleft();
        gasBefore = gasleft();
        swapRouter.swap(key, params, settings, "");
        uint256 hookedGas = gasBefore - gasleft();
        console2.log("swap gas, hookless pool:", plainGas);
        console2.log("swap gas, RwaSessionHook pool:", hookedGas);
        console2.log("hook overhead:", hookedGas - plainGas);
        assertLt(hookedGas - plainGas, 60_000);
    }

    function _stockOut(BalanceDelta delta) internal pure returns (uint256) {
        int128 out = rwaIsCurrency0() ? delta.amount0() : delta.amount1();
        return uint256(int256(out));
    }
}

/// The same suite with the stock token on the currency1 side (like NVDAon/USDT on BSC).
contract RwaSessionHookCurrency1Test is RwaSessionHookTest {
    function rwaIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
