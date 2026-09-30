// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullRangeLiquidity} from "../libraries/FullRangeLiquidity.sol";

/// The three cases of Uniswap v4 Pool.modifyLiquidity: below, inside and above the range.
contract FullRangeLiquidityTest is Test {
    uint160 internal lower = TickMath.getSqrtPriceAtTick(-887_220);
    uint160 internal upper = TickMath.getSqrtPriceAtTick(887_220);

    function test_belowTheRangeOnlyToken0Counts() public view {
        uint160 below = lower - 1;
        (uint256 a0, uint256 a1) = FullRangeLiquidity.amountsForLiquidity(below, lower, upper, 1e18, true);
        assertEq(a0, SqrtPriceMath.getAmount0Delta(lower, upper, 1e18, true));
        assertEq(a1, 0);
        assertApproxEqAbs(FullRangeLiquidity.liquidityForAmounts(below, lower, upper, a0, 0), 1e18, 1);
    }

    /// Regression: the CI fuzz profile found `liquidityForAmounts` dividing by zero here.
    function test_exactlyAtTheLowerBoundOnlyToken0Counts() public view {
        (uint256 a0, uint256 a1) = FullRangeLiquidity.amountsForLiquidity(lower, lower, upper, 6392, false);
        assertEq(a1, 0);
        assertEq(a0, SqrtPriceMath.getAmount0Delta(lower, upper, 6392, false));
        assertLe(FullRangeLiquidity.liquidityForAmounts(lower, lower, upper, a0, a1), 6392);
        assertEq(FullRangeLiquidity.liquidityForAmounts(lower, lower, upper, 0, 1e18), 0);
    }

    function test_aboveTheRangeOnlyToken1Counts() public view {
        uint160 above = upper;
        (uint256 a0, uint256 a1) = FullRangeLiquidity.amountsForLiquidity(above, lower, upper, 1e18, false);
        assertEq(a0, 0);
        assertEq(a1, SqrtPriceMath.getAmount1Delta(lower, upper, 1e18, false));
        assertApproxEqAbs(FullRangeLiquidity.liquidityForAmounts(above, lower, upper, 0, a1), 1e18, 1);
    }

    function test_insideTheRangeTheScarcerTokenLimits() public view {
        uint160 mid = TickMath.getSqrtPriceAtTick(54_000);
        (uint256 a0, uint256 a1) = FullRangeLiquidity.amountsForLiquidity(mid, lower, upper, 1e18, false);
        // Rounded down both ways: a few units short of the liquidity the amounts came from.
        assertApproxEqAbs(FullRangeLiquidity.liquidityForAmounts(mid, lower, upper, a0, a1 * 2), 1e18, 20);
        assertApproxEqAbs(FullRangeLiquidity.liquidityForAmounts(mid, lower, upper, a0 * 2, a1), 1e18, 20);
    }

    function test_liquidityIsCappedAtUint128() public view {
        uint128 liquidity =
            FullRangeLiquidity.liquidityForAmounts(lower - 1, lower, upper, type(uint128).max * uint256(1e30), 0);
        assertEq(liquidity, type(uint128).max);
    }

    function testFuzz_roundTripNeverCreatesLiquidity(uint128 liquidity, int24 tick) public pure {
        liquidity = uint128(bound(liquidity, 1, 1e30));
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(int24(bound(tick, -887_272, 887_271)));
        uint160 lo = TickMath.getSqrtPriceAtTick(-887_220);
        uint160 hi = TickMath.getSqrtPriceAtTick(887_220);
        (uint256 a0, uint256 a1) = FullRangeLiquidity.amountsForLiquidity(sqrtPriceX96, lo, hi, liquidity, false);
        assertLe(FullRangeLiquidity.liquidityForAmounts(sqrtPriceX96, lo, hi, a0, a1), liquidity);
    }
}
