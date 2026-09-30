// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice New York wall-clock arithmetic for UTC timestamps (proleptic Gregorian calendar, US
/// daylight-saving rules in force since 2007). Pure; the holiday table lives in NyseMarketCalendar.
/// @dev Date conversions are Howard Hinnant's days_from_civil / civil_from_days, restricted to
/// dates on or after 1970-01-01 so every intermediate value stays unsigned.
library NyseTime {
    uint256 internal constant DAY = 86_400;
    uint256 internal constant HOUR = 3600;
    uint256 internal constant EDT_OFFSET = 4 * HOUR;
    uint256 internal constant EST_OFFSET = 5 * HOUR;

    /// @notice Days since 1970-01-01 of the date `y`-`m`-`d` (1 <= m <= 12, 1 <= d <= 31, y >= 1970).
    function daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = (m + 9) % 12; // March = 0 … February = 11
        uint256 doy = (153 * mp + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    /// @notice The date of day `z` since 1970-01-01.
    function civilFromDays(uint256 z) internal pure returns (uint256 y, uint256 m, uint256 d) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }

    /// @notice 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday).
    function weekday(uint256 epochDay) internal pure returns (uint256) {
        return (epochDay + 4) % 7;
    }

    /// @notice Day number of the `n`-th Sunday of month `m` of year `y`.
    function nthSunday(uint256 y, uint256 m, uint256 n) internal pure returns (uint256) {
        uint256 first = daysFromCivil(y, m, 1);
        return first + (7 - weekday(first)) % 7 + 7 * (n - 1);
    }

    /// @notice Whether New York is on daylight time at `timestamp`: from 02:00 EST on the second
    /// Sunday of March (07:00 UTC) to 02:00 EDT on the first Sunday of November (06:00 UTC).
    function isDaylightSaving(uint256 timestamp) internal pure returns (bool) {
        (uint256 y,,) = civilFromDays(timestamp / DAY);
        uint256 start = nthSunday(y, 3, 2) * DAY + 7 * HOUR;
        uint256 end = nthSunday(y, 11, 1) * DAY + 6 * HOUR;
        return timestamp >= start && timestamp < end;
    }

    /// @notice New York local date (days since 1970-01-01) and minute of the day at `timestamp`.
    /// Seconds are dropped, as packages/core/src/session.ts does. `timestamp` >= 5 hours.
    function newYork(uint256 timestamp) internal pure returns (uint256 localDay, uint256 minuteOfDay) {
        uint256 local = timestamp - (isDaylightSaving(timestamp) ? EDT_OFFSET : EST_OFFSET);
        localDay = local / DAY;
        minuteOfDay = (local % DAY) / 60;
    }

    /// @notice UTC timestamp of `minuteOfDay` New York time on local date `localDay`. Exact for
    /// wall times outside the 01:00–03:00 daylight-saving switch window.
    function utcOf(uint256 localDay, uint256 minuteOfDay) internal pure returns (uint256) {
        uint256 wall = localDay * DAY + minuteOfDay * 60;
        uint256 asDaylight = wall + EDT_OFFSET;
        return isDaylightSaving(asDaylight) ? asDaylight : wall + EST_OFFSET;
    }
}
