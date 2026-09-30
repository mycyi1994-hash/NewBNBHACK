// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IBStockMultiplier} from "./interfaces/IBStockMultiplier.sol";
import {IReferencePriceSource} from "./interfaces/IReferencePriceSource.sol";

/// @title Reference prices pushed by a keeper
/// @notice Reporters post the independent US share price of a stock (for example the public RWA
/// Dynamic V2 `stockInfo.price` the agent already reads, which is null outside trading hours) and
/// the shares-per-token multiplier it was converted with. The token's reference price is
/// share price × multiplier.
/// @dev For a bStocks token the multiplier is on-chain: a report must carry the token's current
/// `uiMultiplier()`, and an observation stops being valid the moment the multiplier changes, so a
/// share price from before a split or dividend is never combined with the multiplier after it.
contract KeeperReferenceOracle is IReferencePriceSource, Ownable2Step {
    enum MultiplierSource {
        Disabled,
        Reported, // the reporter's multiplier is used as posted (Ondo: API tokenToShareRatio)
        BStockOnChain // must equal the token's uiMultiplier(), at posting and at reading
    }

    struct Observation {
        uint128 sharePriceE18;
        uint64 observedAt;
        uint128 multiplierE18;
    }

    struct Report {
        address token;
        uint128 sharePriceE18;
        uint128 multiplierE18;
        uint64 observedAt;
    }

    /// @notice How long after its observation a report may still be posted.
    uint64 public immutable maxReportDelay;

    mapping(address token => MultiplierSource) public multiplierSource;
    mapping(address token => Observation) public latest;
    mapping(address reporter => bool) public isReporter;

    event ReporterSet(address indexed reporter, bool allowed);
    event TokenConfigured(address indexed token, MultiplierSource source);
    event ReferencePosted(
        address indexed token, uint256 sharePriceE18, uint256 multiplierE18, uint256 observedAt, address reporter
    );

    error NotReporter();
    error TokenNotConfigured(address token);
    error InvalidReport(address token);
    error StaleReport(address token, uint256 observedAt);
    error MultiplierMismatch(address token, uint256 reported, uint256 onChain);

    constructor(address initialOwner, uint64 maxReportDelay_) Ownable(initialOwner) {
        maxReportDelay = maxReportDelay_;
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        isReporter[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    function configureToken(address token, MultiplierSource source) external onlyOwner {
        if (source == MultiplierSource.BStockOnChain) IBStockMultiplier(token).uiMultiplier();
        multiplierSource[token] = source;
        emit TokenConfigured(token, source);
    }

    function post(Report[] calldata reports) external {
        if (!isReporter[msg.sender]) revert NotReporter();
        for (uint256 i; i < reports.length; ++i) {
            _post(reports[i]);
        }
    }

    /// @inheritdoc IReferencePriceSource
    function referencePrice(address token) external view returns (uint256 priceE18, uint256 observedAt) {
        MultiplierSource source = multiplierSource[token];
        Observation memory o = latest[token];
        if (source == MultiplierSource.Disabled || o.observedAt == 0) return (0, 0);
        if (source == MultiplierSource.BStockOnChain && _onChainMultiplier(token) != o.multiplierE18) return (0, 0);
        return (uint256(o.sharePriceE18) * o.multiplierE18 / 1e18, o.observedAt);
    }

    function _post(Report calldata r) internal {
        MultiplierSource source = multiplierSource[r.token];
        if (source == MultiplierSource.Disabled) revert TokenNotConfigured(r.token);
        if (r.sharePriceE18 == 0 || r.multiplierE18 == 0 || r.observedAt > block.timestamp) {
            revert InvalidReport(r.token);
        }
        if (r.observedAt <= latest[r.token].observedAt || block.timestamp - r.observedAt > maxReportDelay) {
            revert StaleReport(r.token, r.observedAt);
        }
        if (source == MultiplierSource.BStockOnChain) {
            uint256 onChain = _onChainMultiplier(r.token);
            if (onChain != r.multiplierE18) revert MultiplierMismatch(r.token, r.multiplierE18, onChain);
        }
        latest[r.token] =
            Observation({sharePriceE18: r.sharePriceE18, observedAt: r.observedAt, multiplierE18: r.multiplierE18});
        emit ReferencePosted(r.token, r.sharePriceE18, r.multiplierE18, r.observedAt, msg.sender);
    }

    function _onChainMultiplier(address token) internal view returns (uint256) {
        try IBStockMultiplier(token).uiMultiplier() returns (uint256 multiplier) {
            return multiplier;
        } catch {
            return 0;
        }
    }
}
