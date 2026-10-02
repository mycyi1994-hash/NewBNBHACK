// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {PoolPriceMath} from "../libraries/PoolPriceMath.sol";
import {RwaSessionHook} from "../RwaSessionHook.sol";
import {DeployRwaLp} from "../script/DeployRwaLp.s.sol";
import {MockBStock} from "./utils/RwaLpTestBase.sol";

contract DeployRwaLpTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager internal manager;
    MockBStock internal stock;
    MockERC20 internal usdt;

    function setUp() public {
        vm.warp(1_791_298_800);
        manager = IPoolManager(
            deployCode("node_modules/@uniswap/v4-core/out/PoolManager.sol/PoolManager.json", abi.encode(address(this)))
        );
        stock = new MockBStock();
        usdt = new MockERC20("Tether USD", "USDT", 18);
        script = new DeployRwaLp();
    }

    DeployRwaLp internal script;

    function _params() internal view returns (DeployRwaLp.Params memory) {
        return script.params(manager, address(usdt), address(stock), 228147411668927608984, true, 60, 300);
    }

    /// The environment path: RWA_TOKEN and RWA_PRICE_E18 required, the rest defaulted or probed.
    function test_runReadsTheEnvironment() public {
        vm.setEnv("POOL_MANAGER", vm.toString(address(manager)));
        vm.setEnv("QUOTE_TOKEN", vm.toString(address(usdt)));
        vm.setEnv("RWA_TOKEN", vm.toString(address(stock)));
        vm.setEnv("RWA_PRICE_E18", "228147411668927608984");
        DeployRwaLp.Deployment memory d = script.run();
        assertTrue(d.hook.poolConfig(d.id).bStockMultiplier, "the multiplier getters were probed");
        assertEq(d.hook.owner(), d.vault.owner());
    }

    function test_deploysAWiredStackAtTheRequestedPrice() public {
        DeployRwaLp.Deployment memory d = script.deploy(_params(), address(0));

        assertEq(uint160(address(d.hook)) & Hooks.ALL_HOOK_MASK, uint160(0x2880), "hook flags");
        assertEq(address(d.hook.calendar()), address(d.calendar));
        assertEq(address(d.hook.referenceSource()), address(d.oracle));
        assertTrue(d.hook.isQuoteToken(address(usdt)));
        RwaSessionHook.PoolConfig memory config = d.hook.poolConfig(d.id);
        assertEq(config.rwaToken, address(stock));
        assertTrue(config.bStockMultiplier);
        assertEq(config.liquidityGate, address(d.vault));
        assertEq(d.key.fee, LPFeeLibrary.DYNAMIC_FEE_FLAG);

        (uint160 sqrtPriceX96,,,) = manager.getSlot0(d.id);
        bool rwaIsCurrency0 = Currency.unwrap(d.key.currency0) == address(stock);
        assertApproxEqRel(
            PoolPriceMath.rwaPriceE18(sqrtPriceX96, rwaIsCurrency0, 18, 18), 228147411668927608984, 1e9
        );
        assertEq(d.vault.totalSupply(), 0, "the script moves no tokens");
        assertEq(d.vault.name(), "Yieldvest NVDAB-USDT LP");
    }

    function test_handsOwnershipToLpOwnerInTwoSteps() public {
        address multisig = makeAddr("multisig");
        DeployRwaLp.Deployment memory d = script.deploy(_params(), multisig);
        assertEq(d.hook.pendingOwner(), multisig);
        assertEq(d.vault.pendingOwner(), multisig);
        assertEq(d.oracle.pendingOwner(), multisig);
        assertEq(d.calendar.pendingOwner(), multisig);
        vm.prank(multisig);
        d.hook.acceptOwnership();
        assertEq(d.hook.owner(), multisig);
    }

    function testFuzz_sqrtPriceAtE18InvertsRwaPriceE18(uint96 priceE18, bool rwaIsCurrency0, uint8 decimals) public pure {
        uint256 price = bound(priceE18, 1e12, 1e27);
        uint8 rwaDecimals = uint8(bound(decimals, 6, 18));
        uint160 sqrtPriceX96 = PoolPriceMath.sqrtPriceAtE18(price, rwaIsCurrency0, rwaDecimals, 18);
        assertApproxEqRel(PoolPriceMath.rwaPriceE18(sqrtPriceX96, rwaIsCurrency0, rwaDecimals, 18), price, 1e12);
    }
}
