// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolPriceMath} from "../libraries/PoolPriceMath.sol";

/// The vectors of packages/rwa-lp/src/price.test.ts: the TypeScript reader and the hook agree to the wei.
contract PoolPriceMathTest is Test {
    function test_sharedVectors() public pure {
        assertEq(PoolPriceMath.rwaPriceE18(1188023726335105040460539685827, true, 18, 18), 224849051972264035718);
        assertEq(PoolPriceMath.rwaPriceE18(5243580102571863231091329464, false, 18, 18), 228298655511218691868);
        assertEq(
            PoolPriceMath.rwaPriceE18(1188023726335105040460539685827, true, 18, 6), 224849051972264035718473096178098
        );
        assertEq(
            PoolPriceMath.rwaPriceE18(TickMath.MIN_SQRT_PRICE, false, 18, 18),
            340256786698763678858396856460488307819979090561317864144
        );
        assertEq(
            PoolPriceMath.rwaPriceE18(TickMath.MAX_SQRT_PRICE - 1, true, 18, 18),
            340256786836388094070642339899681172762184831912254825631
        );
        assertEq(PoolPriceMath.rwaPriceE18(TickMath.MIN_SQRT_PRICE, true, 6, 18), 0);
        assertEq(PoolPriceMath.gapPips(224849100000000000000, 220000000000000000000), 22041);
        assertEq(PoolPriceMath.gapPips(1e18, 3e18), 666666);
        assertEq(PoolPriceMath.gapPips(3e18, 1e18), 1e6);
    }

    /// Any valid sqrt price and decimals up to 18: no overflow, whichever side the stock is on.
    function testFuzz_neverOverflows(uint160 sqrtPriceX96, bool rwaIsCurrency0, uint8 rwaDecimals, uint8 quoteDecimals)
        public
        pure
    {
        sqrtPriceX96 = uint160(bound(sqrtPriceX96, TickMath.MIN_SQRT_PRICE, TickMath.MAX_SQRT_PRICE - 1));
        PoolPriceMath.rwaPriceE18(sqrtPriceX96, rwaIsCurrency0, uint8(bound(rwaDecimals, 0, 18)), uint8(bound(quoteDecimals, 0, 18)));
    }
}
