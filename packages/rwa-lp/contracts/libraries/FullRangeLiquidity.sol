// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";

/// @notice Token amounts ↔ liquidity for one position, with the same case split and rounding as
/// Uniswap v4 `Pool.modifyLiquidity` (below, inside or above the range).
library FullRangeLiquidity {
    /// @notice The most liquidity `amount0` and `amount1` pay for at `sqrtPriceX96`, rounded down.
    function liquidityForAmounts(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        uint256 liquidity;
        // At exactly the lower bound only token0 is behind liquidity (and the in-range formula for
        // token1 would divide by zero), so that price counts as below the range, as in Uniswap's
        // LiquidityAmounts.
        if (sqrtPriceX96 <= sqrtPriceLowerX96) {
            liquidity = _fromAmount0(sqrtPriceLowerX96, sqrtPriceUpperX96, amount0);
        } else if (sqrtPriceX96 < sqrtPriceUpperX96) {
            uint256 fromAmount0 = _fromAmount0(sqrtPriceX96, sqrtPriceUpperX96, amount0);
            uint256 fromAmount1 = _fromAmount1(sqrtPriceLowerX96, sqrtPriceX96, amount1);
            liquidity = fromAmount0 < fromAmount1 ? fromAmount0 : fromAmount1;
        } else {
            liquidity = _fromAmount1(sqrtPriceLowerX96, sqrtPriceUpperX96, amount1);
        }
        // forge-lint: disable-next-line(unsafe-typecast) liquidity <= type(uint128).max in that branch
        return liquidity > type(uint128).max ? type(uint128).max : uint128(liquidity);
    }

    /// @notice Token amounts behind `liquidity` at `sqrtPriceX96`; `roundUp` for amounts paid in.
    function amountsForLiquidity(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint128 liquidity,
        bool roundUp
    ) internal pure returns (uint256 amount0, uint256 amount1) {
        if (sqrtPriceX96 < sqrtPriceLowerX96) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceLowerX96, sqrtPriceUpperX96, liquidity, roundUp);
        } else if (sqrtPriceX96 < sqrtPriceUpperX96) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, sqrtPriceUpperX96, liquidity, roundUp);
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtPriceLowerX96, sqrtPriceX96, liquidity, roundUp);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtPriceLowerX96, sqrtPriceUpperX96, liquidity, roundUp);
        }
    }

    function _fromAmount0(uint160 sqrtPriceAX96, uint160 sqrtPriceBX96, uint256 amount0)
        private
        pure
        returns (uint256)
    {
        uint256 intermediate = FullMath.mulDiv(sqrtPriceAX96, sqrtPriceBX96, FixedPoint96.Q96);
        return FullMath.mulDiv(amount0, intermediate, sqrtPriceBX96 - sqrtPriceAX96);
    }

    function _fromAmount1(uint160 sqrtPriceAX96, uint160 sqrtPriceBX96, uint256 amount1)
        private
        pure
        returns (uint256)
    {
        return FullMath.mulDiv(amount1, FixedPoint96.Q96, sqrtPriceBX96 - sqrtPriceAX96);
    }
}
