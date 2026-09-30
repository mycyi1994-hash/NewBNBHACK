// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The US equity session at a point in time, New York time.
/// @dev The names and their order are the session codes in vectors/nyse-sessions.json, which is
/// generated from packages/core/src/session.ts (`UsSession`): the on-chain calendar and the agent's
/// calendar are checked against the same vectors.
interface IMarketCalendar {
    enum Session {
        Regular,
        Pre,
        Post,
        Overnight,
        Weekend,
        Holiday
    }

    /// @return session The session in progress at `timestamp`.
    /// @return openedAt UTC second at which the regular session in progress opened (09:30 New York),
    /// or 0 when `session` is not `Regular`.
    function sessionAt(uint256 timestamp) external view returns (Session session, uint256 openedAt);
}
