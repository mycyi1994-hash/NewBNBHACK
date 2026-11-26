// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title MoaVault
/// @notice Holds a user's funds on HSK Chain. The owner deposits and withdraws; the Moa agent key may only
///         swap between USDT and an allow-listed token on HSKSwap (Uniswap V3), within hard limits:
///         a per-trade cap, a per-day cap (both in USDT), and a slippage floor checked against the pool price.
///         The agent can never move funds out of the vault.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV3Pool {
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract MoaVault {
    struct Market {
        address pool; // HSKSwap pool of token/USDT
        uint24 fee;
        bool tokenIsToken0; // price math direction
        bool enabled;
    }

    address public immutable owner;
    address public immutable usdt;
    ISwapRouter02 public immutable router;

    address public agent;
    bool public paused;
    uint256 public maxTradeUsdt; // per trade, USDT base units (6 decimals)
    uint256 public maxDailyUsdt; // per UTC day
    uint16 public maxSlippageBps; // vs the pool price at execution time

    mapping(address token => Market) public markets;
    mapping(uint256 day => uint256 usdt) public spentOnDay;

    event AgentSet(address agent);
    event LimitsSet(uint256 maxTradeUsdt, uint256 maxDailyUsdt, uint16 maxSlippageBps);
    event MarketSet(address token, address pool, uint24 fee, bool enabled);
    event Paused(bool paused);
    event Withdrawn(address token, uint256 amount);
    event Traded(address indexed token, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 notionalUsdt, string note);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error MarketDisabled();
    error TradeTooLarge(uint256 notionalUsdt, uint256 cap);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error SlippageTooLoose(uint256 minOut, uint256 floor);
    error BadLimits();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param tokens  tokens the agent may trade against USDT from the start
    /// @param pools   the HSKSwap pool of each token against USDT, in the same order
    constructor(
        address owner_,
        address agent_,
        address usdt_,
        address router_,
        uint256 maxTrade_,
        uint256 maxDaily_,
        uint16 slippageBps_,
        address[] memory tokens,
        address[] memory pools
    ) {
        require(owner_ != address(0) && owner_ != agent_, "bad owner");
        require(tokens.length == pools.length, "markets mismatch");
        owner = owner_;
        agent = agent_;
        usdt = usdt_;
        router = ISwapRouter02(router_);
        _setLimits(maxTrade_, maxDaily_, slippageBps_);
        emit AgentSet(agent_);
        for (uint256 i = 0; i < tokens.length; i++) _setMarket(tokens[i], pools[i], true);
    }

    // ----- owner -----

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentSet(agent_);
    }

    function setLimits(uint256 maxTrade_, uint256 maxDaily_, uint16 slippageBps_) external onlyOwner {
        _setLimits(maxTrade_, maxDaily_, slippageBps_);
    }

    function setMarket(address token, address pool, bool enabled) external onlyOwner {
        _setMarket(token, pool, enabled);
    }

    function _setMarket(address token, address pool, bool enabled) internal {
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        address t0 = p.token0();
        address t1 = p.token1();
        require((t0 == token && t1 == usdt) || (t1 == token && t0 == usdt), "pool is not token/USDT");
        uint24 fee = p.fee();
        markets[token] = Market({pool: pool, fee: fee, tokenIsToken0: t0 == token, enabled: enabled});
        emit MarketSet(token, pool, fee, enabled);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    /// @notice Only the owner can take funds out, and only to the owner.
    function withdraw(address token, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(owner, amount), "transfer failed");
        emit Withdrawn(token, amount);
    }

    // ----- agent -----

    /// @param token     allow-listed token (e.g. WHSK, WETH, WBTC)
    /// @param isBuy     true: spend USDT for token; false: sell token for USDT
    /// @param amountIn  input amount in the input token's base units
    /// @param minOut    minimum output; must be within maxSlippageBps of the pool price
    /// @param note      short human-readable reason, stored in the event
    function trade(address token, bool isBuy, uint256 amountIn, uint256 minOut, string calldata note)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        Market memory m = markets[token];
        if (!m.enabled) revert MarketDisabled();

        uint256 expectedOut = _quote(m, isBuy, amountIn);
        uint256 floor = (expectedOut * (10_000 - maxSlippageBps)) / 10_000;
        if (minOut < floor) revert SlippageTooLoose(minOut, floor);

        uint256 notional = isBuy ? amountIn : expectedOut;
        if (notional > maxTradeUsdt) revert TradeTooLarge(notional, maxTradeUsdt);
        uint256 day = block.timestamp / 1 days;
        uint256 wouldSpend = spentOnDay[day] + notional;
        if (wouldSpend > maxDailyUsdt) revert DailyCapExceeded(wouldSpend, maxDailyUsdt);
        spentOnDay[day] = wouldSpend;

        address tokenIn = isBuy ? usdt : token;
        address tokenOut = isBuy ? token : usdt;
        require(IERC20(tokenIn).approve(address(router), amountIn), "approve failed"); // exact amount only
        amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: m.fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        emit Traded(token, isBuy, amountIn, amountOut, notional, note);
    }

    // ----- views -----

    /// @notice Output for amountIn at the current pool price, before fees and price impact.
    function quote(address token, bool isBuy, uint256 amountIn) external view returns (uint256) {
        return _quote(markets[token], isBuy, amountIn);
    }

    function remainingToday() external view returns (uint256) {
        uint256 spent = spentOnDay[block.timestamp / 1 days];
        return spent >= maxDailyUsdt ? 0 : maxDailyUsdt - spent;
    }

    // ----- internal -----

    function _setLimits(uint256 maxTrade_, uint256 maxDaily_, uint16 slippageBps_) internal {
        if (maxTrade_ == 0 || maxDaily_ < maxTrade_ || slippageBps_ == 0 || slippageBps_ > 1_000) revert BadLimits();
        maxTradeUsdt = maxTrade_;
        maxDailyUsdt = maxDaily_;
        maxSlippageBps = slippageBps_;
        emit LimitsSet(maxTrade_, maxDaily_, slippageBps_);
    }

    /// price of token0 in token1 = (sqrtP / 2^96)^2
    function _quote(Market memory m, bool isBuy, uint256 amountIn) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(m.pool).slot0();
        uint256 q96 = 1 << 96;
        // selling token0 or buying token1 means converting token0 -> token1: multiply by price
        bool zeroForOne = isBuy ? !m.tokenIsToken0 : m.tokenIsToken0;
        if (zeroForOne) return ((amountIn * sqrtP) / q96) * sqrtP / q96;
        return ((amountIn * q96) / sqrtP) * q96 / sqrtP;
    }
}
