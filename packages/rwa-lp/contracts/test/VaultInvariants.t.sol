// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {RwaLiquidityVault} from "../RwaLiquidityVault.sol";
import {RwaLpTestBase} from "./utils/RwaLpTestBase.sol";

/// @notice Random deposits, withdrawals, swaps and the passage of time against one vault.
/// Tracks the claim behind one share (liquidity, and idle tokens including uncollected fees):
/// neither may ever shrink, whatever anyone else does.
contract VaultHandler is Test {
    RwaLiquidityVault internal immutable vault;
    PoolSwapTest internal immutable router;
    MockERC20 internal immutable token0;
    MockERC20 internal immutable token1;
    PoolKey internal key;
    address[] internal actors;

    uint256 internal lastSupply;
    uint256 internal lastLiquidity;
    uint256 internal lastIdle0;
    uint256 internal lastIdle1;
    uint256 public shrinks;
    uint256 public calls;

    constructor(RwaLiquidityVault vault_, PoolSwapTest router_, MockERC20 token0_, MockERC20 token1_) {
        vault = vault_;
        router = router_;
        token0 = token0_;
        token1 = token1_;
        key = vault_.poolKey();
        actors.push(makeAddr("lp1"));
        actors.push(makeAddr("lp2"));
        actors.push(makeAddr("lp3"));
        token0.approve(address(router), type(uint256).max);
        token1.approve(address(router), type(uint256).max);
    }

    function actorList() external view returns (address[] memory) {
        return actors;
    }

    function deposit(uint256 actorSeed, uint256 shares) external {
        address actor = actors[actorSeed % actors.length];
        shares = bound(shares, vault.totalSupply() == 0 ? 1e18 : 1e9, 1e22);
        (uint256 need0, uint256 need1) = vault.previewDeposit(shares);
        token0.mint(actor, need0);
        token1.mint(actor, need1);
        vm.startPrank(actor);
        token0.approve(address(vault), need0);
        token1.approve(address(vault), need1);
        vault.deposit(shares, need0, need1, TickMath.MIN_SQRT_PRICE, TickMath.MAX_SQRT_PRICE, actor, block.timestamp);
        vm.stopPrank();
        _check();
    }

    function withdraw(uint256 actorSeed, uint256 shares) external {
        address actor = actors[actorSeed % actors.length];
        uint256 balance = vault.balanceOf(actor);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        (uint256 min0, uint256 min1) = vault.previewWithdraw(shares);
        vm.prank(actor);
        vault.withdraw(shares, min0, min1, actor, block.timestamp);
        _check();
    }

    function swap(bool zeroForOne, uint256 amountIn) external {
        if (vault.totalSupply() == 0) return;
        (uint256 reserve0, uint256 reserve1) = vault.totalAmounts();
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        if (reserveIn < 1e6) return;
        amountIn = bound(amountIn, 1e3, reserveIn / 10);
        (zeroForOne ? token0 : token1).mint(address(this), amountIn);
        router.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        _check();
    }

    function wait(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 2 days));
    }

    /// Per-share liquidity and per-share idle (with pending fees) against the previous snapshot,
    /// compared by cross-multiplication so no rounding hides a shrink.
    function _check() internal {
        ++calls;
        uint256 supply = vault.totalSupply();
        uint256 liquidity = vault.positionLiquidity();
        (uint256 fees0, uint256 fees1) = vault.pendingFees();
        uint256 idle0 = token0.balanceOf(address(vault)) + fees0;
        uint256 idle1 = token1.balanceOf(address(vault)) + fees1;
        if (lastSupply != 0) {
            if (liquidity * lastSupply < lastLiquidity * supply) ++shrinks;
            if (idle0 * lastSupply < lastIdle0 * supply) ++shrinks;
            if (idle1 * lastSupply < lastIdle1 * supply) ++shrinks;
        }
        (lastSupply, lastLiquidity, lastIdle0, lastIdle1) = (supply, liquidity, idle0, idle1);
    }
}

contract VaultInvariantsTest is RwaLpTestBase {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        (MockERC20 token0, MockERC20 token1) = _tokens();
        handler = new VaultHandler(vault, swapRouter, token0, token1);
        targetContract(address(handler));
    }

    function invariant_sharesAddUp() public view {
        address[] memory actors = handler.actorList();
        uint256 sum = vault.balanceOf(vault.DEAD());
        for (uint256 i; i < actors.length; ++i) {
            sum += vault.balanceOf(actors[i]);
        }
        assertEq(sum, vault.totalSupply());
    }

    function invariant_theClaimBehindAShareNeverShrinks() public view {
        assertEq(handler.shrinks(), 0);
    }

    /// A share starts as one unit of liquidity and only ever gains.
    function invariant_everyShareIsBackedByAtLeastOneUnitOfLiquidity() public view {
        assertGe(vault.positionLiquidity(), vault.totalSupply());
    }

    /// At the end of every run, everyone can still leave with what the preview promised.
    function afterInvariant() public {
        address[] memory actors = handler.actorList();
        for (uint256 i; i < actors.length; ++i) {
            uint256 shares = vault.balanceOf(actors[i]);
            if (shares == 0) continue;
            (uint256 min0, uint256 min1) = vault.previewWithdraw(shares);
            vm.prank(actors[i]);
            vault.withdraw(shares, min0, min1, actors[i], block.timestamp);
        }
        uint256 supply = vault.totalSupply();
        assertTrue(supply == 0 || supply == vault.MINIMUM_SHARES());
    }
}
