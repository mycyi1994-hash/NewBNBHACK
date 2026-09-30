// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NyseMarketCalendar} from "../NyseMarketCalendar.sol";
import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";
import {NyseTime} from "../libraries/NyseTime.sol";

contract NyseTimeHarness {
    function isDaylightSaving(uint256 timestamp) external pure returns (bool) {
        return NyseTime.isDaylightSaving(timestamp);
    }

    function civilFromDays(uint256 z) external pure returns (uint256, uint256, uint256) {
        return NyseTime.civilFromDays(z);
    }

    function daysFromCivil(uint256 y, uint256 m, uint256 d) external pure returns (uint256) {
        return NyseTime.daysFromCivil(y, m, d);
    }
}

contract NyseMarketCalendarTest is Test {
    NyseMarketCalendar internal calendar;
    NyseTimeHarness internal time;

    event DaySet(uint256 indexed ymd, NyseMarketCalendar.DayKind kind);
    event YearCoverageSet(uint256 indexed year, bool covered);

    function setUp() public {
        calendar = new NyseMarketCalendar(address(this));
        time = new NyseTimeHarness();
    }

    function _session(uint256 timestamp) internal view returns (IMarketCalendar.Session session) {
        (session,) = calendar.sessionAt(timestamp);
    }

    /// Every vector generated from packages/core/src/session.ts (the agent's calendar).
    function test_matchesTheAgentCalendarVectors() public view {
        string memory json = vm.readFile("vectors/nyse-sessions.json");
        uint256[] memory timestamps = vm.parseJsonUintArray(json, ".timestamps");
        uint256[] memory sessions = vm.parseJsonUintArray(json, ".sessions");
        uint256[] memory openedAt = vm.parseJsonUintArray(json, ".openedAt");
        assertEq(sessions.length, timestamps.length);
        assertEq(openedAt.length, timestamps.length);
        assertGt(timestamps.length, 10_000);
        for (uint256 i; i < timestamps.length; ++i) {
            (IMarketCalendar.Session session, uint256 opened) = calendar.sessionAt(timestamps[i]);
            if (uint256(session) != sessions[i] || opened != openedAt[i]) {
                string memory at = vm.toString(timestamps[i]);
                assertEq(uint256(session), sessions[i], string.concat("session at ", at));
                assertEq(opened, openedAt[i], string.concat("openedAt at ", at));
            }
        }
    }

    function test_regularSessionInDaylightTime() public view {
        // Thu 24 Sep 2026, EDT (UTC-4): 09:30 New York is 13:30 UTC.
        assertEq(uint256(_session(1_790_256_540)), uint256(IMarketCalendar.Session.Pre)); // 13:29 UTC
        (IMarketCalendar.Session session, uint256 openedAt) = calendar.sessionAt(1_790_256_600); // 13:30
        assertEq(uint256(session), uint256(IMarketCalendar.Session.Regular));
        assertEq(openedAt, 1_790_256_600);
        assertEq(uint256(_session(1_790_279_999)), uint256(IMarketCalendar.Session.Regular)); // 19:59:59
        assertEq(uint256(_session(1_790_280_000)), uint256(IMarketCalendar.Session.Post)); // 20:00
        assertEq(uint256(_session(1_790_294_400)), uint256(IMarketCalendar.Session.Overnight)); // Fri 00:00 UTC = Thu 20:00 New York
    }

    function test_regularSessionInStandardTime() public view {
        // Mon 2 Nov 2026, EST (UTC-5): 09:30 New York is 14:30 UTC.
        assertEq(uint256(_session(1_793_629_740)), uint256(IMarketCalendar.Session.Pre)); // 14:29 UTC
        (IMarketCalendar.Session session, uint256 openedAt) = calendar.sessionAt(1_793_629_800);
        assertEq(uint256(session), uint256(IMarketCalendar.Session.Regular));
        assertEq(openedAt, 1_793_629_800);
    }

    function test_weekendsHolidaysAndEarlyCloses() public view {
        assertEq(uint256(_session(1_790_434_800)), uint256(IMarketCalendar.Session.Weekend)); // Sat 26 Sep 2026
        assertEq(uint256(_session(1_795_705_200)), uint256(IMarketCalendar.Session.Holiday)); // Thu 26 Nov 2026
        // Fri 27 Nov 2026 closes at 13:00 New York (18:00 UTC).
        assertEq(uint256(_session(1_795_802_340)), uint256(IMarketCalendar.Session.Regular)); // 17:59 UTC
        assertEq(uint256(_session(1_795_802_400)), uint256(IMarketCalendar.Session.Post)); // 18:00 UTC
    }

    function test_aYearWithoutATableIsClosedUntilCovered() public {
        uint256 tuesday2028 = 1_830_610_800; // Tue 4 Jan 2028 15:00 UTC = 10:00 New York
        assertEq(uint256(_session(tuesday2028)), uint256(IMarketCalendar.Session.Holiday));
        vm.expectEmit(address(calendar));
        emit YearCoverageSet(2028, true);
        calendar.setYearCovered(2028, true);
        assertEq(uint256(_session(tuesday2028)), uint256(IMarketCalendar.Session.Regular));
    }

    function test_ownerMarksAnUnscheduledClosure() public {
        uint256 wednesday = 1_791_990_000; // Wed 14 Oct 2026 15:00 UTC
        assertEq(uint256(_session(wednesday)), uint256(IMarketCalendar.Session.Regular));
        uint256[] memory days_ = new uint256[](1);
        days_[0] = 20_261_014;
        vm.expectEmit(address(calendar));
        emit DaySet(20_261_014, NyseMarketCalendar.DayKind.Holiday);
        calendar.setDays(days_, NyseMarketCalendar.DayKind.Holiday);
        assertEq(uint256(_session(wednesday)), uint256(IMarketCalendar.Session.Holiday));
        calendar.setDays(days_, NyseMarketCalendar.DayKind.Normal);
        assertEq(uint256(_session(wednesday)), uint256(IMarketCalendar.Session.Regular));
    }

    function test_onlyTheOwnerEditsTheTable() public {
        uint256[] memory days_ = new uint256[](1);
        days_[0] = 20_261_014;
        vm.startPrank(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBEEF)));
        calendar.setDays(days_, NyseMarketCalendar.DayKind.Holiday);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBEEF)));
        calendar.setYearCovered(2028, true);
        vm.stopPrank();
    }

    function test_ownershipMovesInTwoSteps() public {
        calendar.transferOwnership(address(0xBEEF));
        assertEq(calendar.owner(), address(this));
        vm.prank(address(0xBEEF));
        calendar.acceptOwnership();
        assertEq(calendar.owner(), address(0xBEEF));
    }

    function test_rejectsDatesThatDoNotExist() public {
        uint256[5] memory bad = [uint256(20_260_230), 20_261_301, 20_260_000, 19_691_231, 20_270_229];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(NyseMarketCalendar.InvalidDate.selector, bad[i]));
            calendar.epochDayOf(bad[i]);
        }
        assertEq(calendar.epochDayOf(20_280_229), 21_243); // 2028 is a leap year
        assertEq(calendar.epochDayOf(19_700_101), 0);
    }

    function test_daylightSavingSwitchesAtTheLegalInstants() public view {
        assertFalse(time.isDaylightSaving(1_772_953_199)); // 2026-03-08 06:59:59 UTC
        assertTrue(time.isDaylightSaving(1_772_953_200)); // 2026-03-08 07:00:00 UTC
        assertTrue(time.isDaylightSaving(1_793_512_799)); // 2026-11-01 05:59:59 UTC
        assertFalse(time.isDaylightSaving(1_793_512_800)); // 2026-11-01 06:00:00 UTC
        assertFalse(time.isDaylightSaving(1_767_225_600)); // 2026-01-01
        assertTrue(time.isDaylightSaving(1_782_864_000)); // 2026-07-01
    }

    function test_theTimeBeforeTheFirstNewYorkDayIsClosed() public view {
        assertEq(uint256(_session(0)), uint256(IMarketCalendar.Session.Holiday));
        assertEq(uint256(_session(5 hours - 1)), uint256(IMarketCalendar.Session.Holiday));
    }

    function testFuzz_dateConversionRoundTrips(uint32 epochDay) public view {
        uint256 day = bound(epochDay, 0, 2_932_896); // up to 9999-12-31
        (uint256 y, uint256 m, uint256 d) = time.civilFromDays(day);
        assertEq(time.daysFromCivil(y, m, d), day);
        assertEq(calendar.epochDayOf(y * 10_000 + m * 100 + d), day);
    }

    function testFuzz_neverRevertsAndOnlyRegularHasAnOpen(uint64 timestamp) public view {
        (IMarketCalendar.Session session, uint256 openedAt) = calendar.sessionAt(timestamp);
        if (session == IMarketCalendar.Session.Regular) {
            assertLe(openedAt, timestamp);
            assertLt(timestamp - openedAt, 6.5 hours);
        } else {
            assertEq(openedAt, 0);
        }
    }
}
