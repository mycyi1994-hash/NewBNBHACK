// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The share multiplier of a bStocks token (BEP-677). The names come from the selectors in
/// the implementation behind the token's beacon proxy (DECISIONS Q-13): `uiMultiplier` is shares per
/// token (1e18 scale), `newUIMultiplier` the value scheduled for `effectiveAt` (unix seconds, 0 =
/// nothing scheduled). A corporate action (dividend, split) changes the multiplier, not balances.
interface IBStockMultiplier {
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}
