// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {KeeperReferenceOracle} from "../KeeperReferenceOracle.sol";
import {MockBStock} from "./utils/RwaLpTestBase.sol";

contract KeeperReferenceOracleTest is Test {
    KeeperReferenceOracle internal oracle;
    MockBStock internal bstock;
    MockERC20 internal ondo;
    address internal owner = makeAddr("owner");
    address internal reporter = makeAddr("reporter");

    event ReferencePosted(
        address indexed token, uint256 sharePriceE18, uint256 multiplierE18, uint256 observedAt, address reporter
    );

    function setUp() public {
        vm.warp(1_791_298_800); // Tue 6 Oct 2026 11:00 New York
        oracle = new KeeperReferenceOracle(owner, 5 minutes);
        bstock = new MockBStock();
        bstock.schedule(1.000778223752807865e18, 1); // NVDAB's multiplier (DECISIONS Q-13), already in force
        ondo = new MockERC20("NVIDIA (Ondo)", "NVDAon", 18);
        vm.startPrank(owner);
        oracle.setReporter(reporter, true);
        oracle.configureToken(address(bstock), KeeperReferenceOracle.MultiplierSource.BStockOnChain);
        oracle.configureToken(address(ondo), KeeperReferenceOracle.MultiplierSource.Reported);
        vm.stopPrank();
    }

    function _report(address token, uint256 sharePrice, uint256 multiplier, uint256 observedAt)
        internal
        pure
        returns (KeeperReferenceOracle.Report[] memory reports)
    {
        reports = new KeeperReferenceOracle.Report[](1);
        reports[0] = KeeperReferenceOracle.Report({
            token: token,
            sharePriceE18: uint128(sharePrice),
            multiplierE18: uint128(multiplier),
            observedAt: uint64(observedAt)
        });
    }

    function _post(address token, uint256 sharePrice, uint256 multiplier, uint256 observedAt) internal {
        vm.prank(reporter);
        oracle.post(_report(token, sharePrice, multiplier, observedAt));
    }

    function test_theTokenPriceIsTheSharePriceTimesTheMultiplier() public {
        vm.expectEmit(address(oracle));
        emit ReferencePosted(address(ondo), 180e18, 1.0017152487959898e18, block.timestamp - 30, reporter);
        _post(address(ondo), 180e18, 1.0017152487959898e18, block.timestamp - 30);
        (uint256 price, uint256 observedAt) = oracle.referencePrice(address(ondo));
        assertEq(price, 180e18 * 1.0017152487959898e18 / 1e18);
        assertEq(observedAt, block.timestamp - 30);
    }

    function test_aBStocksReportMustCarryTheOnChainMultiplier() public {
        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeeperReferenceOracle.MultiplierMismatch.selector, address(bstock), 1e18, 1.000778223752807865e18
            )
        );
        oracle.post(_report(address(bstock), 180e18, 1e18, block.timestamp));
        _post(address(bstock), 180e18, 1.000778223752807865e18, block.timestamp);
        (uint256 price,) = oracle.referencePrice(address(bstock));
        assertEq(price, 180e18 * 1.000778223752807865e18 / 1e18);
    }

    function test_anObservationDiesWhenTheMultiplierChanges() public {
        _post(address(bstock), 180e18, 1.000778223752807865e18, block.timestamp);
        bstock.schedule(10.00778223752807865e18, block.timestamp + 1 hours); // a 10:1 split
        (uint256 price,) = oracle.referencePrice(address(bstock));
        assertGt(price, 0);
        vm.warp(block.timestamp + 1 hours);
        (price,) = oracle.referencePrice(address(bstock));
        assertEq(price, 0, "a pre-split share price must not meet the post-split multiplier");
        _post(address(bstock), 18e18, 10.00778223752807865e18, block.timestamp);
        (price,) = oracle.referencePrice(address(bstock));
        assertEq(price, 18e18 * 10.00778223752807865e18 / 1e18);
    }

    function test_anUnreadableMultiplierInvalidatesTheObservation() public {
        _post(address(bstock), 180e18, 1.000778223752807865e18, block.timestamp);
        bstock.setBroken(true);
        (uint256 price, uint256 observedAt) = oracle.referencePrice(address(bstock));
        assertEq(price, 0);
        assertEq(observedAt, 0);
    }

    function test_reportsMoveForwardInTimeAndArriveInTime() public {
        _post(address(ondo), 180e18, 1e18, block.timestamp - 60);
        vm.startPrank(reporter);
        KeeperReferenceOracle.Report[] memory sameTime = _report(address(ondo), 181e18, 1e18, block.timestamp - 60);
        vm.expectRevert(
            abi.encodeWithSelector(KeeperReferenceOracle.StaleReport.selector, address(ondo), block.timestamp - 60)
        );
        oracle.post(sameTime);
        vm.warp(block.timestamp + 10 minutes);
        KeeperReferenceOracle.Report[] memory late = _report(address(ondo), 181e18, 1e18, block.timestamp - 5 minutes - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeeperReferenceOracle.StaleReport.selector, address(ondo), block.timestamp - 5 minutes - 1
            )
        );
        oracle.post(late);
        oracle.post(_report(address(ondo), 181e18, 1e18, block.timestamp - 5 minutes)); // exactly on the limit
        vm.stopPrank();
    }

    function test_rejectsEmptyAndFutureReports() public {
        vm.startPrank(reporter);
        vm.expectRevert(abi.encodeWithSelector(KeeperReferenceOracle.InvalidReport.selector, address(ondo)));
        oracle.post(_report(address(ondo), 0, 1e18, block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(KeeperReferenceOracle.InvalidReport.selector, address(ondo)));
        oracle.post(_report(address(ondo), 180e18, 0, block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(KeeperReferenceOracle.InvalidReport.selector, address(ondo)));
        oracle.post(_report(address(ondo), 180e18, 1e18, block.timestamp + 1));
        vm.stopPrank();
    }

    function test_onlyReportersPostAndOnlyForConfiguredTokens() public {
        vm.expectRevert(KeeperReferenceOracle.NotReporter.selector);
        oracle.post(_report(address(ondo), 180e18, 1e18, block.timestamp));
        address unknown = makeAddr("unknown");
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(KeeperReferenceOracle.TokenNotConfigured.selector, unknown));
        oracle.post(_report(unknown, 180e18, 1e18, block.timestamp));
        (uint256 price, uint256 observedAt) = oracle.referencePrice(unknown);
        assertEq(price, 0);
        assertEq(observedAt, 0);
    }

    function test_disablingATokenHidesItsPrice() public {
        _post(address(ondo), 180e18, 1e18, block.timestamp);
        vm.prank(owner);
        oracle.configureToken(address(ondo), KeeperReferenceOracle.MultiplierSource.Disabled);
        (uint256 price,) = oracle.referencePrice(address(ondo));
        assertEq(price, 0);
    }

    function test_aBStocksSourceNeedsTheMultiplierGetter() public {
        vm.prank(owner);
        vm.expectRevert();
        oracle.configureToken(address(ondo), KeeperReferenceOracle.MultiplierSource.BStockOnChain);
    }

    function test_postsSeveralTokensAtOnce() public {
        KeeperReferenceOracle.Report[] memory reports = new KeeperReferenceOracle.Report[](2);
        reports[0] = _report(address(ondo), 180e18, 1e18, block.timestamp)[0];
        reports[1] = _report(address(bstock), 181e18, 1.000778223752807865e18, block.timestamp)[0];
        vm.prank(reporter);
        oracle.post(reports);
        (uint256 a,) = oracle.referencePrice(address(ondo));
        (uint256 b,) = oracle.referencePrice(address(bstock));
        assertEq(a, 180e18);
        assertEq(b, 181e18 * 1.000778223752807865e18 / 1e18);
    }

    function test_onlyTheOwnerConfigures() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.setReporter(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.configureToken(address(ondo), KeeperReferenceOracle.MultiplierSource.Reported);
        vm.stopPrank();
        vm.prank(owner);
        oracle.setReporter(reporter, false);
        vm.prank(reporter);
        vm.expectRevert(KeeperReferenceOracle.NotReporter.selector);
        oracle.post(_report(address(ondo), 180e18, 1e18, block.timestamp));
    }
}
