// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IMarketCalendar} from "./interfaces/IMarketCalendar.sol";
import {NyseTime} from "./libraries/NyseTime.sol";

/// @title NYSE session calendar
/// @notice The on-chain twin of packages/core/src/session.ts: New York time, weekends, NYSE full-day
/// holidays and 13:00 early closes. A year without a holiday table is treated as closed rather than
/// guessed, exactly like the TypeScript calendar. Both are checked against vectors/nyse-sessions.json.
/// @dev Sessions (New York time): pre 04:00–09:30, regular 09:30–16:00 (13:00 on early closes),
/// post until 20:00, overnight otherwise. The owner maintains the holiday table (nyse.com holidays
/// page, one year at a time) and can mark an unscheduled closure; it cannot change weekends, DST or
/// session hours.
contract NyseMarketCalendar is IMarketCalendar, Ownable2Step {
    enum DayKind {
        Normal,
        Holiday,
        EarlyClose
    }

    uint256 internal constant PRE_OPEN_MINUTE = 4 * 60;
    uint256 internal constant REGULAR_OPEN_MINUTE = 9 * 60 + 30;
    uint256 internal constant CLOSE_MINUTE = 16 * 60;
    uint256 internal constant EARLY_CLOSE_MINUTE = 13 * 60;
    uint256 internal constant POST_CLOSE_MINUTE = 20 * 60;

    /// @notice Holiday or early close by New York date (days since 1970-01-01).
    mapping(uint256 epochDay => DayKind) public dayKind;
    /// @notice Years whose holiday table has been entered. Any other year counts as closed.
    mapping(uint256 year => bool) public yearCovered;

    event DaySet(uint256 indexed ymd, DayKind kind);
    event YearCoverageSet(uint256 indexed year, bool covered);

    error InvalidDate(uint256 ymd);

    constructor(address initialOwner) Ownable(initialOwner) {
        // The same tables as packages/core/src/session.ts (NYSE_HOLIDAYS, NYSE_EARLY_CLOSE).
        uint256[10] memory holidays2026 =
            [uint256(20260101), 20260119, 20260216, 20260403, 20260525, 20260619, 20260703, 20260907, 20261126, 20261225];
        uint256[10] memory holidays2027 =
            [uint256(20270101), 20270118, 20270215, 20270326, 20270531, 20270618, 20270705, 20270906, 20271125, 20271224];
        uint256[3] memory earlyCloses = [uint256(20261127), 20261224, 20271126];
        for (uint256 i; i < 10; ++i) {
            _setDay(holidays2026[i], DayKind.Holiday);
            _setDay(holidays2027[i], DayKind.Holiday);
        }
        for (uint256 i; i < 3; ++i) {
            _setDay(earlyCloses[i], DayKind.EarlyClose);
        }
        _setYearCovered(2026, true);
        _setYearCovered(2027, true);
    }

    /// @inheritdoc IMarketCalendar
    function sessionAt(uint256 timestamp) public view returns (Session session, uint256 openedAt) {
        // Before 05:00 UTC on 1 Jan 1970 the New York date is 31 Dec 1969: a Wednesday, no table.
        if (timestamp < NyseTime.EST_OFFSET) return (Session.Holiday, 0);
        (uint256 localDay, uint256 minute) = NyseTime.newYork(timestamp);
        uint256 weekday = NyseTime.weekday(localDay);
        if (weekday == 0 || weekday == 6) return (Session.Weekend, 0);
        (uint256 year,,) = NyseTime.civilFromDays(localDay);
        DayKind kind = dayKind[localDay];
        if (!yearCovered[year] || kind == DayKind.Holiday) return (Session.Holiday, 0);
        uint256 close = kind == DayKind.EarlyClose ? EARLY_CLOSE_MINUTE : CLOSE_MINUTE;
        if (minute >= PRE_OPEN_MINUTE && minute < REGULAR_OPEN_MINUTE) return (Session.Pre, 0);
        if (minute >= REGULAR_OPEN_MINUTE && minute < close) {
            return (Session.Regular, NyseTime.utcOf(localDay, REGULAR_OPEN_MINUTE));
        }
        if (minute >= close && minute < POST_CLOSE_MINUTE) return (Session.Post, 0);
        return (Session.Overnight, 0);
    }

    /// @notice Marks New York dates (yyyymmdd) as holidays, early closes, or back to normal.
    function setDays(uint256[] calldata ymds, DayKind kind) external onlyOwner {
        for (uint256 i; i < ymds.length; ++i) {
            _setDay(ymds[i], kind);
        }
    }

    /// @notice Declares that a year's holiday table is complete (or withdraws it).
    function setYearCovered(uint256 year, bool covered) external onlyOwner {
        _setYearCovered(year, covered);
    }

    /// @notice Days since 1970-01-01 of a yyyymmdd date; reverts on a date that does not exist.
    function epochDayOf(uint256 ymd) public pure returns (uint256 epochDay) {
        uint256 y = ymd / 10_000;
        uint256 m = (ymd / 100) % 100;
        uint256 d = ymd % 100;
        if (y < 1970 || y > 9999 || m == 0 || m > 12 || d == 0 || d > 31) revert InvalidDate(ymd);
        epochDay = NyseTime.daysFromCivil(y, m, d);
        (uint256 y2, uint256 m2, uint256 d2) = NyseTime.civilFromDays(epochDay);
        if (y2 != y || m2 != m || d2 != d) revert InvalidDate(ymd);
    }

    function _setDay(uint256 ymd, DayKind kind) internal {
        dayKind[epochDayOf(ymd)] = kind;
        emit DaySet(ymd, kind);
    }

    function _setYearCovered(uint256 year, bool covered) internal {
        yearCovered[year] = covered;
        emit YearCoverageSet(year, covered);
    }
}
