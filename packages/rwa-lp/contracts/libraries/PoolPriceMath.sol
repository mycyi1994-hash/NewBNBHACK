// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Converts a pool's sqrt price into the USD price of its tokenized-stock side and measures
/// its gap to a reference price. The quote side is a USD stablecoin counted at 1 USD; its peg is
/// watched elsewhere (SPEC §7, USDT depeg guardian).
library PoolPriceMath {
    /// @notice USD value of one whole RWA token implied by `sqrtPriceX96`, 18 decimals.
    /// @dev currency1 per currency0 in base units is sqrtPrice² / 2^192. Decimals are at most 18,
    /// so every intermediate fits: the largest is 2^192 × 10^36 / MIN_SQRT_PRICE² ≈ 3.4e74.
    function rwaPriceE18(uint160 sqrtPriceX96, bool rwaIsCurrency0, uint8 rwaDecimals, uint8 quoteDecimals)
        internal
        pure
        returns (uint256)
    {
        uint256 rwaUnit = 10 ** (18 + uint256(rwaDecimals));
        uint256 quoteUnit = 10 ** uint256(quoteDecimals);
        if (rwaIsCurrency0) {
            // quote base units per RWA base unit = sqrtP² / 2^192
            uint256 priceX96 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, FixedPoint96.Q96);
            return FullMath.mulDiv(priceX96, rwaUnit, FixedPoint96.Q96 * quoteUnit);
        }
        // RWA base units per quote base unit = sqrtP² / 2^192, so its inverse is 2^192 / sqrtP².
        uint256 inverseX96 = FullMath.mulDiv(FixedPoint96.Q96, FixedPoint96.Q96, sqrtPriceX96);
        return FullMath.mulDiv(inverseX96, rwaUnit, uint256(sqrtPriceX96) * quoteUnit);
    }

    /// @notice |price − reference| / reference in hundredths of a bip (1e6 = 100%), capped at 1e6.
    function gapPips(uint256 priceE18, uint256 referenceE18) internal pure returns (uint256) {
        uint256 gap = priceE18 > referenceE18 ? priceE18 - referenceE18 : referenceE18 - priceE18;
        if (gap >= referenceE18) return 1e6;
        return FullMath.mulDiv(gap, 1e6, referenceE18);
    }

    /// @notice The largest sqrt price at which one whole RWA token is worth at most `priceE18` USD
    /// (currency0 side) or at least it (currency1 side): the inverse of `rwaPriceE18`, for scripts
    /// and tests that initialize a pool at a given USD price. A bisection over the valid range.
    function sqrtPriceAtE18(uint256 priceE18, bool rwaIsCurrency0, uint8 rwaDecimals, uint8 quoteDecimals)
        internal
        pure
        returns (uint160)
    {
        uint256 low = TickMath.MIN_SQRT_PRICE;
        uint256 high = TickMath.MAX_SQRT_PRICE;
        while (high - low > 1) {
            uint256 mid = (low + high) / 2;
            // forge-lint: disable-next-line(unsafe-typecast) mid < MAX_SQRT_PRICE < 2^160
            uint256 price = rwaPriceE18(uint160(mid), rwaIsCurrency0, rwaDecimals, quoteDecimals);
            // The USD price rises with the sqrt price when the RWA is currency0, and falls otherwise.
            if (rwaIsCurrency0 ? price > priceE18 : price < priceE18) high = mid;
            else low = mid;
        }
        // forge-lint: disable-next-line(unsafe-typecast) low < MAX_SQRT_PRICE < 2^160
        return uint160(low);
    }
}
