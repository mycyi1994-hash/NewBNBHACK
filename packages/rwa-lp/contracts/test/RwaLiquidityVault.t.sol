// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {RwaLiquidityVault} from "../RwaLiquidityVault.sol";
import {RwaLpTestBase} from "./utils/RwaLpTestBase.sol";

contract RwaLiquidityVaultTest is RwaLpTestBase {
    using StateLibrary for IPoolManager;

    event Deposit(address indexed sender, address indexed to, uint256 shares, uint256 amount0, uint256 amount1);
    event Withdraw(address indexed sender, address indexed to, uint256 shares, uint256 amount0, uint256 amount1);

    /// Trades both ways during the regular session so fees are pending and the price has moved.
    function _churn() internal {
        vm.warp(TUE_REGULAR);
        for (uint256 i; i < 6; ++i) {
            swapExactIn(true, 400e18);
            swapExactIn(false, 1.5e18);
        }
    }

    // ---------------------------------------------------------------- deposits

    function test_theFirstDepositLocksMinimumShares() public {
        (uint256 p0, uint256 p1) = vault.previewDeposit(1e21);
        _fund(alice, p0, p1);
        vm.startPrank(alice);
        _approve(p0, p1);
        vm.expectEmit(address(vault));
        emit Deposit(alice, alice, 1e21 - 1000, p0, p1);
        (uint256 a0, uint256 a1) = vault.deposit(1e21, p0, p1, ANY_LOWEST, ANY_HIGHEST, alice, block.timestamp);
        vm.stopPrank();
        assertEq(a0, p0);
        assertEq(a1, p1);
        assertEq(vault.balanceOf(alice), 1e21 - 1000);
        assertEq(vault.balanceOf(vault.DEAD()), 1000);
        assertEq(vault.totalSupply(), 1e21);
        assertEq(vault.positionLiquidity(), 1e21);
        // Full range at 225 USD: L/√225 stock and L·√225 USDT.
        (uint256 stockPaid, uint256 usdtPaid) = rwaIsCurrency0() ? (a0, a1) : (a1, a0);
        assertApproxEqRel(stockPaid, uint256(1e21) / 15, 1e15);
        assertApproxEqRel(usdtPaid, uint256(1e21) * 15, 1e15);
    }

    function test_theFirstDepositMustExceedTheLockedShares() public {
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.FirstDepositTooSmall.selector, 1000));
        vault.deposit(1000, type(uint256).max, type(uint256).max, ANY_LOWEST, ANY_HIGHEST, alice, block.timestamp);
    }

    function test_zeroSharesAreRejected() public {
        vm.expectRevert(RwaLiquidityVault.ZeroShares.selector);
        vault.deposit(0, 0, 0, ANY_LOWEST, ANY_HIGHEST, alice, block.timestamp);
        vm.expectRevert(RwaLiquidityVault.ZeroShares.selector);
        vault.withdraw(0, 0, 0, alice, block.timestamp);
    }

    function test_laterDepositsArePaidProRataAndPreviewIsExact() public {
        depositAs(alice, 1e21);
        _churn();
        (uint256 p0, uint256 p1) = vault.previewDeposit(3e20);
        uint256 liquidityBefore = vault.positionLiquidity();
        uint256 supplyBefore = vault.totalSupply();
        (uint256 a0, uint256 a1) = depositAs(bob, 3e20);
        assertEq(a0, p0);
        assertEq(a1, p1);
        assertEq(vault.balanceOf(bob), 3e20);
        assertEq(
            vault.positionLiquidity(), liquidityBefore + FullMath.mulDivRoundingUp(liquidityBefore, 3e20, supplyBefore)
        );
    }

    function test_sharesForAmountsIsTheMostThoseAmountsBuy() public {
        (MockERC20 token0, MockERC20 token1) = _tokens();
        (uint256 stockMax, uint256 usdtMax) = (10e18, 5000e18);
        (uint256 max0, uint256 max1) = rwaIsCurrency0() ? (stockMax, usdtMax) : (usdtMax, stockMax);
        uint256 first = vault.sharesForAmounts(max0, max1);
        (uint256 c0, uint256 c1) = vault.previewDeposit(first);
        assertLe(c0, max0);
        assertLe(c1, max1);
        _fund(alice, max0, max1);
        vm.startPrank(alice);
        _approve(max0, max1);
        vault.deposit(first, max0, max1, ANY_LOWEST, ANY_HIGHEST, alice, block.timestamp);
        vm.stopPrank();
        assertEq(token0.allowance(alice, address(vault)), max0 - c0);
        assertEq(token1.allowance(alice, address(vault)), max1 - c1);

        _churn();
        uint256 later = vault.sharesForAmounts(max0, max1);
        (c0, c1) = vault.previewDeposit(later);
        assertLe(c0, max0);
        assertLe(c1, max1);
        (uint256 d0, uint256 d1) = vault.previewDeposit(later + 1);
        assertTrue(d0 > max0 || d1 > max1, "one more share would not fit");
        assertEq(vault.sharesForAmounts(1, 1), 0);
    }

    function test_slippageAndDeadlineProtectBothWays() public {
        depositAs(alice, 1e21);
        (uint256 need0, uint256 need1) = vault.previewDeposit(1e20);
        _fund(bob, need0, need1);
        vm.startPrank(bob);
        _approve(need0, need1);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.SlippageExceeded.selector, need0, need1));
        vault.deposit(1e20, need0 - 1, need1, ANY_LOWEST, ANY_HIGHEST, bob, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.SlippageExceeded.selector, need0, need1));
        vault.deposit(1e20, need0, need1 - 1, ANY_LOWEST, ANY_HIGHEST, bob, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.DeadlinePassed.selector, block.timestamp - 1));
        vault.deposit(1e20, need0, need1, ANY_LOWEST, ANY_HIGHEST, bob, block.timestamp - 1);
        vault.deposit(1e20, need0, need1, ANY_LOWEST, ANY_HIGHEST, bob, block.timestamp);

        (uint256 out0, uint256 out1) = vault.previewWithdraw(1e20);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.SlippageExceeded.selector, out0, out1));
        vault.withdraw(1e20, out0 + 1, out1, bob, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.SlippageExceeded.selector, out0, out1));
        vault.withdraw(1e20, out0, out1 + 1, bob, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.DeadlinePassed.selector, block.timestamp - 1));
        vault.withdraw(1e20, 0, 0, bob, block.timestamp - 1);
        vm.stopPrank();
    }

    /// The caller's price bounds hold for every deposit, inclusive at both ends (SeedPrice.t.sol
    /// shows why the seed needs them).
    function test_everyDepositChecksThePoolPriceAgainstTheCallersBounds() public {
        depositAs(alice, 1e21);
        _churn();
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(id);
        (uint256 need0, uint256 need1) = vault.previewDeposit(1e20);
        _fund(bob, need0, need1);
        vm.startPrank(bob);
        _approve(need0, need1);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.PriceOutOfBounds.selector, sqrtPriceX96));
        vault.deposit(1e20, need0, need1, sqrtPriceX96 + 1, ANY_HIGHEST, bob, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.PriceOutOfBounds.selector, sqrtPriceX96));
        vault.deposit(1e20, need0, need1, ANY_LOWEST, sqrtPriceX96 - 1, bob, block.timestamp);
        vault.deposit(1e20, need0, need1, sqrtPriceX96, sqrtPriceX96, bob, block.timestamp);
        vm.stopPrank();
        assertEq(vault.balanceOf(bob), 1e20);
    }

    // ---------------------------------------------------------------- withdrawals and fees

    function test_withdrawPaysWhatPreviewSaysToTheRecipient() public {
        depositAs(alice, 1e21);
        _churn();
        uint256 shares = vault.balanceOf(alice) / 3;
        (uint256 p0, uint256 p1) = vault.previewWithdraw(shares);
        (MockERC20 token0, MockERC20 token1) = _tokens();
        vm.expectEmit(address(vault));
        emit Withdraw(alice, bob, shares, p0, p1);
        vm.prank(alice);
        (uint256 a0, uint256 a1) = vault.withdraw(shares, p0, p1, bob, block.timestamp);
        assertEq(a0, p0);
        assertEq(a1, p1);
        assertEq(token0.balanceOf(bob), p0);
        assertEq(token1.balanceOf(bob), p1);
    }

    function test_feesGoToWhoeverHeldSharesWhileTheyAccrued() public {
        depositAs(alice, 1e21);
        _churn();
        (uint256 fees0, uint256 fees1) = vault.pendingFees();
        assertGt(fees0, 0);
        assertGt(fees1, 0);

        // Bob arrives after the fees: in and straight out returns no more than he paid.
        (uint256 in0, uint256 in1) = depositAs(bob, 5e20);
        (MockERC20 token0, MockERC20 token1) = _tokens();
        assertGe(token0.balanceOf(address(vault)), fees0); // collected into idle before Bob paid in
        assertGe(token1.balanceOf(address(vault)), fees1);
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        (uint256 out0, uint256 out1) = vault.withdraw(bobShares, 0, 0, bob, block.timestamp);
        assertLe(out0, in0);
        assertLe(out1, in1);
        assertApproxEqAbs(out0, in0, 100);
        assertApproxEqAbs(out1, in1, 100);

        // Alice leaves with her share of the position and nearly all of the fees (the dead shares
        // keep 1000/1e21 of them).
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 idle0 = token0.balanceOf(address(vault));
        uint256 idle1 = token1.balanceOf(address(vault));
        vm.prank(alice);
        vault.withdraw(aliceShares, 0, 0, alice, block.timestamp);
        assertLe(token0.balanceOf(address(vault)), idle0 - FullMath.mulDiv(idle0, aliceShares, 1e21) + 1);
        assertLe(token1.balanceOf(address(vault)), idle1 - FullMath.mulDiv(idle1, aliceShares, 1e21) + 1);
    }

    function test_totalAmountsCountsThePositionIdleAndPendingFees() public {
        depositAs(alice, 1e21);
        _churn();
        (uint256 t0, uint256 t1) = vault.totalAmounts();
        (uint256 w0, uint256 w1) = vault.previewWithdraw(vault.totalSupply());
        assertApproxEqAbs(t0, w0, 2);
        assertApproxEqAbs(t1, w1, 2);
        (uint256 none0, uint256 none1) = vault.previewWithdraw(0);
        assertEq(none0 + none1, 0);
    }

    // ---------------------------------------------------------------- compounding

    function test_compoundTurnsIdleFeesIntoLiquidityInsideTheBand() public {
        depositAs(alice, 1e21);
        _churn();
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(id);

        vm.expectRevert(RwaLiquidityVault.NotOperator.selector);
        vault.compound(0, type(uint160).max);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.PriceOutOfBounds.selector, sqrtPriceX96));
        vault.compound(sqrtPriceX96 + 1, type(uint160).max);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.PriceOutOfBounds.selector, sqrtPriceX96));
        vault.compound(0, sqrtPriceX96 - 1);

        uint256 liquidityBefore = vault.positionLiquidity();
        vm.prank(operator);
        (uint128 added,,) = vault.compound(sqrtPriceX96, sqrtPriceX96);
        assertGt(added, 0);
        assertEq(vault.positionLiquidity(), liquidityBefore + added);
        // The limiting side of the idle balance is used up, save the wei held back and less than
        // one unit of liquidity's worth (≈ 15 wei of USDT at 225).
        (MockERC20 token0, MockERC20 token1) = _tokens();
        assertTrue(token0.balanceOf(address(vault)) <= 20 || token1.balanceOf(address(vault)) <= 20);
    }

    function test_compoundWithNothingIdleIsANoOp() public {
        depositAs(alice, 1e21);
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(id);
        vm.prank(operator);
        (uint128 added, uint256 paid0, uint256 paid1) = vault.compound(sqrtPriceX96, sqrtPriceX96);
        assertEq(added, 0);
        assertEq(paid0 + paid1, 0);
    }

    /// A sale large enough to push the price past the bottom of the full range: the vault's position
    /// is then all currency0, and deposits and withdrawals still settle with one side at zero.
    function test_theVaultStillWorksWithThePriceBeyondItsRange() public {
        depositAs(alice, 1e18); // small enough for one swap (amounts are int128) to empty one side
        vm.warp(TUE_REGULAR);
        swapExactIn(!rwaIsCurrency0(), 1e38); // pay currency0 until the price leaves the range
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(id);
        assertLt(sqrtPriceX96, TickMath.getSqrtPriceAtTick(vault.tickLower()));

        (, uint256 need1) = vault.previewDeposit(1e17);
        assertEq(need1, 0, "nothing of currency1 is behind the position or idle");
        depositAs(bob, 1e17);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        (uint256 out0, uint256 out1) = vault.withdraw(shares, 0, 0, alice, block.timestamp);
        assertGt(out0, 0);
        assertEq(out1, 0);
        assertGt(vault.positionLiquidity(), 0);
    }

    // ---------------------------------------------------------------- allowlist and admin

    function test_theFirstDepositLocksSharesEvenWithTheAllowlistOn() public {
        address[] memory list = new address[](1);
        list[0] = alice;
        vm.startPrank(owner);
        vault.setAllowlistEnabled(true);
        vault.setAllowed(list, true);
        vm.stopPrank();
        depositAs(alice, 1e21);
        assertEq(vault.balanceOf(vault.DEAD()), vault.MINIMUM_SHARES());
    }

    function test_theAllowlistGatesEntryButNeverExit() public {
        depositAs(alice, 1e21);
        address[] memory list = new address[](1);
        list[0] = alice;
        vm.startPrank(owner);
        vault.setAllowlistEnabled(true);
        vault.setAllowed(list, true);
        vm.stopPrank();

        (uint256 need0, uint256 need1) = vault.previewDeposit(1e20);
        _fund(bob, need0, need1);
        vm.startPrank(bob);
        _approve(need0, need1);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.NotAllowed.selector, bob));
        vault.deposit(1e20, need0, need1, ANY_LOWEST, ANY_HIGHEST, bob, block.timestamp);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.NotAllowed.selector, bob));
        vault.transfer(bob, 1);
        address dead = vault.DEAD();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.NotAllowed.selector, dead));
        vault.transfer(dead, 1); // only the first deposit's lock may mint to the dead address

        (need0, need1) = vault.previewDeposit(1e20);
        _fund(alice, need0, need1);
        vm.startPrank(alice);
        _approve(need0, need1);
        vm.expectRevert(abi.encodeWithSelector(RwaLiquidityVault.NotAllowed.selector, bob));
        // shares to an unlisted account
        vault.deposit(1e20, need0, need1, ANY_LOWEST, ANY_HIGHEST, bob, block.timestamp);
        vault.deposit(1e20, need0, need1, ANY_LOWEST, ANY_HIGHEST, alice, block.timestamp);
        vm.stopPrank();

        vm.prank(owner);
        vault.setAllowed(list, false);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(shares, 0, 0, alice, block.timestamp); // delisted, still free to leave
        assertEq(vault.balanceOf(alice), 0);
    }

    function test_adminIsGuardedAndCannotTouchFunds() public {
        address stranger = makeAddr("stranger");
        address[] memory list = new address[](1);
        list[0] = stranger;
        vm.startPrank(stranger);
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.expectRevert(notOwner);
        vault.setOperator(stranger);
        vm.expectRevert(notOwner);
        vault.setAllowlistEnabled(true);
        vm.expectRevert(notOwner);
        vault.setAllowed(list, true);
        vm.stopPrank();
    }

    function test_onlyThePoolManagerCallsBack() public {
        vm.expectRevert(RwaLiquidityVault.NotPoolManager.selector);
        vault.unlockCallback("");
    }

    function test_theVaultNeedsAnInitializedErc20Pool() public {
        PoolKey memory other = key;
        other.tickSpacing = 10;
        vm.expectRevert(RwaLiquidityVault.PoolNotInitialized.selector);
        new RwaLiquidityVault(manager, other, "x", "x", owner);
        other = key;
        other.currency0 = Currency.wrap(address(0));
        vm.expectRevert(RwaLiquidityVault.NativeCurrencyUnsupported.selector);
        new RwaLiquidityVault(manager, other, "x", "x", owner);
    }

    function test_theVaultDescribesItsPool() public view {
        PoolKey memory k = vault.poolKey();
        assertEq(Currency.unwrap(k.currency0), Currency.unwrap(key.currency0));
        assertEq(Currency.unwrap(k.currency1), Currency.unwrap(key.currency1));
        assertEq(k.fee, key.fee);
        assertEq(k.tickSpacing, key.tickSpacing);
        assertEq(address(k.hooks), address(hook));
        assertEq(vault.tickLower(), -887_220);
        assertEq(vault.tickUpper(), 887_220);
    }

    // ---------------------------------------------------------------- fuzz

    /// Someone else's deposit and withdrawal, at any price, never shrinks an existing holder's claim,
    /// and never returns more than was paid.
    function testFuzz_aRoundTripNeitherProfitsNorHurtsOthers(
        uint96 aliceShares,
        uint96 bobShares,
        uint64 swapIn,
        bool buyStock,
        uint32 secondsIntoWeek
    ) public {
        depositAs(alice, bound(aliceShares, 1e18, 1e22));
        vm.warp(TUE_OPEN - 2 days + bound(secondsIntoWeek, 0, 7 days));
        swapExactIn(buyStock, buyStock ? bound(swapIn, 1e15, 1000e18) : bound(swapIn, 1e12, 4e18));

        (uint256 before0, uint256 before1) = vault.previewWithdraw(vault.balanceOf(alice));
        (uint256 in0, uint256 in1) = depositAs(bob, bound(bobShares, 1e12, 1e22));
        uint256 shares = vault.balanceOf(bob);
        vm.prank(bob);
        (uint256 out0, uint256 out1) = vault.withdraw(shares, 0, 0, bob, block.timestamp);
        assertLe(out0, in0);
        assertLe(out1, in1);
        (uint256 after0, uint256 after1) = vault.previewWithdraw(vault.balanceOf(alice));
        assertGe(after0, before0);
        assertGe(after1, before1);
    }
}

/// The same suite with the stock token on the currency1 side.
contract RwaLiquidityVaultCurrency1Test is RwaLiquidityVaultTest {
    function rwaIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
