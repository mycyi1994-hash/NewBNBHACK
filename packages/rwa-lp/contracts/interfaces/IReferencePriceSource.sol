// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A reference (off-pool) price for a tokenized stock.
interface IReferencePriceSource {
    /// @return priceE18 USD value of one whole token (share price × shares per token), 18 decimals;
    /// 0 when there is no valid observation.
    /// @return observedAt Unix second the underlying share price was observed; 0 with a 0 price.
    function referencePrice(address token) external view returns (uint256 priceE18, uint256 observedAt);
}
