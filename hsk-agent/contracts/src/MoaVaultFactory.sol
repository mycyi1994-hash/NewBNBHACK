// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MoaVault, IMoaTerms} from "./MoaVault.sol";

/// @title MoaVaultFactory
/// @notice Makes one MoaVault per owner, the same way for everyone: the same USDT, router, agent, markets and
///         starting limits and stop-loss. Anyone may pay to create a vault for an address; that address is the
///         vault's owner and the only one who can withdraw, change its limits and stop-loss, replace its agent or pause it.
///         Every vault starts with real limits and a stop-loss (the constructor refuses "no limit" or "no stop-loss" as a
///         default); each owner may change or remove them afterwards.
///         The `guardian` (the factory's owner) holds two switches and nothing else:
///          - halt agent trading on every vault at once, for example if the shared agent key may have leaked. The halt
///            never touches funds: withdrawals, deposits and the stop-loss keep working;
///          - a platform fee, 0 unless set, never above MAX_PLATFORM_FEE_BPS (0.2%), paid in USDT by each vault to the
///            treasury on each agent trade and counted toward the vault's limits.
///         The guardian is fixed at deployment (zero for none); nothing else can change, and the factory never holds funds.
contract MoaVaultFactory is IMoaTerms {
    address public immutable usdt;
    address public immutable router;
    address public immutable agent;
    uint256 public immutable maxTradeUsdt;
    uint256 public immutable maxDailyUsdt;
    uint16 public immutable maxSlippageBps;
    uint16 public immutable stopLossBps;
    /// May halt and resume agent trading on every vault this factory made. Nothing else.
    address public immutable guardian;
    /// Starting limits above this would be no limit at all: 10,000 USDT a day.
    uint256 public constant MAX_START_DAILY_USDT = 10_000e6;
    bool public halted;
    /// 20 basis points = 0.2% of a trade: the most the platform fee can ever be.
    uint16 public constant MAX_PLATFORM_FEE_BPS = 20;
    uint16 public platformFeeBps;
    address public treasury;

    address[] private _tokens;
    address[] private _pools;

    mapping(address owner => address vault) public vaultOf;
    uint256 public vaultCount;

    event VaultCreated(address indexed owner, address vault);
    event Halted(bool halted);
    event PlatformFeeSet(uint16 bps, address indexed treasury);

    constructor(
        address agent_,
        address usdt_,
        address router_,
        uint256 maxTrade_,
        uint256 maxDaily_,
        uint16 slippageBps_,
        uint16 stopLossBps_,
        address[] memory tokens_,
        address[] memory pools_,
        address guardian_
    ) {
        require(agent_ != address(0) && usdt_ != address(0) && router_ != address(0), "zero address");
        require(tokens_.length > 0 && tokens_.length == pools_.length, "markets mismatch");
        // Safe starting values: a real per-trade and daily limit and a stop-loss; owners loosen them if they want.
        require(maxTrade_ > 0 && maxDaily_ >= maxTrade_ && maxDaily_ <= MAX_START_DAILY_USDT, "unsafe starting limits");
        require(stopLossBps_ >= 100 && stopLossBps_ <= 5_000, "unsafe starting stop-loss");
        require(slippageBps_ > 0 && slippageBps_ <= 300, "unsafe starting slippage");
        guardian = guardian_;
        agent = agent_;
        usdt = usdt_;
        router = router_;
        maxTradeUsdt = maxTrade_;
        maxDailyUsdt = maxDaily_;
        maxSlippageBps = slippageBps_;
        stopLossBps = stopLossBps_;
        _tokens = tokens_;
        _pools = pools_;
    }

    /// @notice The vault of `owner_`, created now if it does not exist yet. One per owner.
    function createVault(address owner_) external returns (address vault) {
        vault = vaultOf[owner_];
        if (vault != address(0)) return vault;
        vault = address(
            new MoaVault{salt: bytes32(uint256(uint160(owner_)))}(
                owner_, agent, usdt, router, maxTradeUsdt, maxDailyUsdt, maxSlippageBps, stopLossBps, _tokens, _pools
            )
        );
        vaultOf[owner_] = vault;
        vaultCount++;
        emit VaultCreated(owner_, vault);
    }

    /// @notice Stop (true) or allow (false) agent trading on every vault at once. Guardian only.
    function setHalted(bool halted_) external {
        require(msg.sender == guardian && guardian != address(0), "not guardian");
        halted = halted_;
        emit Halted(halted_);
    }

    /// @notice Set the platform fee (0 turns it off) and where it goes. Guardian only; never above 0.2%.
    function setPlatformFee(uint16 bps, address treasury_) external {
        require(msg.sender == guardian && guardian != address(0), "not guardian");
        require(bps <= MAX_PLATFORM_FEE_BPS, "fee too high");
        require(bps == 0 || treasury_ != address(0), "no treasury");
        platformFeeBps = bps;
        treasury = treasury_;
        emit PlatformFeeSet(bps, treasury_);
    }

    /// @notice What every vault reads on each agent trade: the halt, and the platform fee with its treasury.
    function tradeTerms() external view returns (bool, uint16, address) {
        return (halted, platformFeeBps, treasury);
    }

    /// @notice The markets every new vault starts with.
    function markets() external view returns (address[] memory tokens, address[] memory pools) {
        return (_tokens, _pools);
    }
}
