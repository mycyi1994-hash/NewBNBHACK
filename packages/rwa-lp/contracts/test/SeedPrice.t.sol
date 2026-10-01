// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {RwaLiquidityVault} from "../RwaLiquidityVault.sol";
import {RwaLpTestBase} from "./utils/RwaLpTestBase.sol";

/// @notice The seed deposit's price bounds (third review, docs/RWA_LP.md §5). The pool starts
/// empty, and one wei with a price limit moves an empty pool's price anywhere for free; maxima read
/// from `previewDeposit` then follow the move. Without bounds, a seed made at a price moved 100x
/// keeps about a fifth of its value once the mover trades back ($2,272.50 paid, $450.10 kept).
/// With bounds taken from the reference price, that seed reverts and nothing is paid; at the right
/// price it goes through.
contract SeedPriceTest is RwaLpTestBase {
    using StateLibrary for IPoolManager;

    address internal mover = makeAddr("mover");
    address internal seeder = makeAddr("seeder");

    /// @dev The mover swaps toward `priceE18` with that price as the limit. In an empty pool one wei
    /// lands the price on the limit at no cost.
    function _moveTo(uint256 priceE18, uint256 amountIn) internal {
        (uint160 sqrtNow,,,) = manager.getSlot0(id);
        uint160 target = sqrtPriceAt(priceE18);
        stock.mint(mover, 1e24);
        usdt.mint(mover, 1e24);
        vm.startPrank(mover);
        stock.approve(address(swapRouter), type(uint256).max);
        usdt.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            // A lower sqrt price is zeroForOne, whichever side the stock is on.
            SwapParams({zeroForOne: target < sqrtNow, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    /// @dev What a seeder takes from the reference price (not from the pool): ±1 %.
    function _referenceBounds() internal pure returns (uint160 lowest, uint160 highest) {
        uint160 a = sqrtPriceAt(START_PRICE * 99 / 100);
        uint160 b = sqrtPriceAt(START_PRICE * 101 / 100);
        (lowest, highest) = a < b ? (a, b) : (b, a);
    }

    /// @dev The runbook's seed: sharesForAmounts → previewDeposit → exact approvals → deposit. A
    /// non-empty `revertData` is what the deposit itself must revert with.
    function _seed(uint160 lowest, uint160 highest, bytes memory revertData)
        internal
        returns (uint256 shares, uint256 paid0, uint256 paid1)
    {
        (uint256 max0, uint256 max1) =
            rwaIsCurrency0() ? (uint256(10e18), uint256(2250e18)) : (uint256(2250e18), uint256(10e18));
        shares = vault.sharesForAmounts(max0, max1);
        (uint256 need0, uint256 need1) = vault.previewDeposit(shares);
        _fund(seeder, need0, need1);
        vm.startPrank(seeder);
        _approve(need0, need1);
        if (revertData.length != 0) vm.expectRevert(revertData);
        (paid0, paid1) = vault.deposit(shares, need0, need1, lowest, highest, seeder, block.timestamp);
        vm.stopPrank();
    }

    /// @dev USD value of token amounts at the reference price.
    function _value(uint256 amount0, uint256 amount1) internal pure returns (uint256) {
        (uint256 stockAmount, uint256 usdtAmount) = rwaIsCurrency0() ? (amount0, amount1) : (amount1, amount0);
        return stockAmount * START_PRICE / 1e18 + usdtAmount;
    }

    function test_withoutBoundsASeedAtAMovedPriceIsTakenOnTheWayBack() public {
        _moveTo(100 * START_PRICE, 1);
        (, uint256 paid0, uint256 paid1) = _seed(ANY_LOWEST, ANY_HIGHEST, "");
        _moveTo(START_PRICE, 1e24); // the mover sells the stock back down to the real price
        (uint256 out0, uint256 out1) = vault.previewWithdraw(vault.balanceOf(seeder));
        uint256 paid = _value(paid0, paid1);
        uint256 kept = _value(out0, out1);
        emit log_named_decimal_uint("seed paid (USD)", paid, 18);
        emit log_named_decimal_uint("seed kept (USD)", kept, 18);
        assertLt(kept * 2, paid, "the seed kept less than half its value");
    }

    function test_aSeedAtAPriceMovedUpRevertsAndPaysNothing() public {
        _moveTo(100 * START_PRICE, 1);
        (uint160 lowest, uint160 highest) = _referenceBounds();
        (uint160 moved,,,) = manager.getSlot0(id);
        _seed(lowest, highest, abi.encodeWithSelector(RwaLiquidityVault.PriceOutOfBounds.selector, moved));
        assertEq(vault.totalSupply(), 0, "nothing was minted");
        assertEq(stock.balanceOf(address(vault)) + usdt.balanceOf(address(vault)), 0, "nothing was paid");
    }

    function test_aSeedAtAPriceMovedDownRevertsAndPaysNothing() public {
        _moveTo(START_PRICE / 4, 1);
        (uint160 lowest, uint160 highest) = _referenceBounds();
        (uint160 moved,,,) = manager.getSlot0(id);
        _seed(lowest, highest, abi.encodeWithSelector(RwaLiquidityVault.PriceOutOfBounds.selector, moved));
        assertEq(vault.totalSupply(), 0, "nothing was minted");
        assertEq(stock.balanceOf(address(vault)) + usdt.balanceOf(address(vault)), 0, "nothing was paid");
    }

    function test_aSeedAtTheReferencePriceGoesThrough() public {
        (uint160 lowest, uint160 highest) = _referenceBounds();
        (uint256 shares,,) = _seed(lowest, highest, "");
        assertEq(vault.balanceOf(seeder), shares - vault.MINIMUM_SHARES());
        assertApproxEqRel(poolPriceE18(), START_PRICE, 1e12);
    }
}

contract SeedPriceFlippedTest is SeedPriceTest {
    function rwaIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
