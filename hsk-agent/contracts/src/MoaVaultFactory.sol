// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MoaVault} from "./MoaVault.sol";

/// @title MoaVaultFactory
/// @notice Makes one MoaVault per owner, the same way for everyone: the same USDT, router, agent, markets and
///         starting limits. Anyone may pay to create a vault for an address; that address is the vault's owner and
///         the only one who can withdraw, change its limits, replace its agent or pause it.
///         The factory has no owner and no setting that can change after deployment, and it never holds funds.
contract MoaVaultFactory {
    address public immutable usdt;
    address public immutable router;
    address public immutable agent;
    uint256 public immutable maxTradeUsdt;
    uint256 public immutable maxDailyUsdt;
    uint16 public immutable maxSlippageBps;

    address[] private _tokens;
    address[] private _pools;

    mapping(address owner => address vault) public vaultOf;
    uint256 public vaultCount;

    event VaultCreated(address indexed owner, address vault);

    constructor(
        address agent_,
        address usdt_,
        address router_,
        uint256 maxTrade_,
        uint256 maxDaily_,
        uint16 slippageBps_,
        address[] memory tokens_,
        address[] memory pools_
    ) {
        require(agent_ != address(0) && usdt_ != address(0) && router_ != address(0), "zero address");
        require(tokens_.length > 0 && tokens_.length == pools_.length, "markets mismatch");
        agent = agent_;
        usdt = usdt_;
        router = router_;
        maxTradeUsdt = maxTrade_;
        maxDailyUsdt = maxDaily_;
        maxSlippageBps = slippageBps_;
        _tokens = tokens_;
        _pools = pools_;
    }

    /// @notice The vault of `owner_`, created now if it does not exist yet. One per owner.
    function createVault(address owner_) external returns (address vault) {
        vault = vaultOf[owner_];
        if (vault != address(0)) return vault;
        vault = address(
            new MoaVault{salt: bytes32(uint256(uint160(owner_)))}(
                owner_, agent, usdt, router, maxTradeUsdt, maxDailyUsdt, maxSlippageBps, _tokens, _pools
            )
        );
        vaultOf[owner_] = vault;
        vaultCount++;
        emit VaultCreated(owner_, vault);
    }

    /// @notice The markets every new vault starts with.
    function markets() external view returns (address[] memory tokens, address[] memory pools) {
        return (_tokens, _pools);
    }
}
