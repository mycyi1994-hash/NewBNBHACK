// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title MoaVault
/// @notice Holds one user's funds on HSK Chain. The owner deposits and withdraws; the Moa agent key may only
///         swap between USDT and an allow-listed token on HSKSwap (Uniswap V3), inside what the owner allows:
///         a per-trade and a per-day limit on what it may spend (both in USDT), and a price floor checked against
///         the pool price. Selling back to USDT is never held up by the spending limits.
///         The owner can also set a stop-loss: once a holding is worth that much less than it cost, anyone may
///         make the vault sell it, so the stop does not depend on Moa's server being up.
///         The agent can never move funds out of the vault.
///         Version 3 adds a creator fee: the owner may approve the person who made an agent they hired, at a rate of
///         at most 1%. Trades the agent makes for that agent then pay the creator that share in USDT, from the USDT
///         going in on a buy or coming out on a sell. Nothing is ever paid to an address the owner did not approve,
///         at more than the owner approved.

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
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory);
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

    /// The stop-loss compares the pool price now with its average over this long, so that a price pushed around
    /// inside one block cannot set a stop off.
    uint32 public constant STOP_WINDOW = 10 minutes;
    /// Version 1 had no stop-loss, version 2 no creator fee. Older vaults have no VERSION at all.
    uint16 public constant VERSION = 3;
    /// The highest creator fee an owner can approve: 100 basis points = 1% of a trade.
    uint16 public constant MAX_CREATOR_FEE_BPS = 100;

    address public immutable owner;
    address public immutable usdt;
    ISwapRouter02 public immutable router;

    address public agent;
    bool public paused;
    uint256 public maxTradeUsdt; // most USDT the agent may spend in one buy (6 decimals)
    uint256 public maxDailyUsdt; // most USDT the agent may spend on buys per UTC day
    uint16 public maxSlippageBps; // worst price accepted, against the pool price at execution time
    uint16 public stopLossBps; // 0 = no stop-loss; otherwise the loss on a holding at which anyone may sell it

    mapping(address token => Market) public markets;
    mapping(uint256 day => uint256 usdt) public spentOnDay;
    /// What the token the vault holds now cost, in USDT. Buys add to it; sells and withdrawals take their share out.
    mapping(address token => uint256 usdt) public costUsdt;
    /// The most the owner lets the agent pay each creator, in basis points of a trade. 0 = not approved.
    mapping(address creator => uint16 bps) public creatorFeeBps;

    event AgentSet(address agent);
    event LimitsSet(uint256 maxTradeUsdt, uint256 maxDailyUsdt, uint16 maxSlippageBps);
    event StopLossSet(uint16 stopLossBps);
    event MarketSet(address token, address pool, uint24 fee, bool enabled);
    event Paused(bool paused);
    event Withdrawn(address token, uint256 amount);
    event Traded(address indexed token, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 notionalUsdt, string note);
    event StoppedOut(address indexed token, address indexed caller, uint256 amountIn, uint256 amountOut, uint256 costUsdt);
    event CreatorFeeSet(address indexed creator, uint16 bps);
    event CreatorPaid(address indexed creator, address indexed token, bool isBuy, uint256 feeUsdt, uint16 bps);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error MarketDisabled();
    error TradeTooLarge(uint256 notionalUsdt, uint256 cap);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error SlippageTooLoose(uint256 minOut, uint256 floor);
    error BadLimits();
    error NoStopLoss();
    error NothingToSell();
    error StopNotReached(uint256 valueUsdt, uint256 stopUsdt);
    error PriceMoving(int24 tickNow, int24 tickAverage);
    error FeeTooHigh(uint16 bps, uint16 cap);
    error BadCreator();

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
        uint16 stopLossBps_,
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
        _setStopLoss(stopLossBps_);
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

    /// @param stopLossBps_ 0 turns the stop-loss off; 1000 means "sell a holding once it is worth 10% less than it cost"
    function setStopLoss(uint16 stopLossBps_) external onlyOwner {
        _setStopLoss(stopLossBps_);
    }

    function setMarket(address token, address pool, bool enabled) external onlyOwner {
        _setMarket(token, pool, enabled);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    /// @notice Approve the maker of an agent you hired, at up to MAX_CREATOR_FEE_BPS of each trade the agent makes for
    ///         it. 0 withdraws the approval. The agent key can neither call this nor be approved.
    function setCreatorFee(address creator, uint16 bps) external onlyOwner {
        if (creator == address(0) || creator == address(this) || creator == agent) revert BadCreator();
        if (bps > MAX_CREATOR_FEE_BPS) revert FeeTooHigh(bps, MAX_CREATOR_FEE_BPS);
        creatorFeeBps[creator] = bps;
        emit CreatorFeeSet(creator, bps);
    }

    /// @notice Only the owner can take funds out, and only to the owner.
    function withdraw(address token, uint256 amount) external onlyOwner {
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held > 0 && costUsdt[token] > 0) costUsdt[token] = amount >= held ? 0 : (costUsdt[token] * (held - amount)) / held;
        require(IERC20(token).transfer(owner, amount), "transfer failed");
        emit Withdrawn(token, amount);
    }

    // ----- agent -----

    /// @param token     allow-listed token (e.g. WHSK, WETH, WBTC)
    /// @param isBuy     true: spend USDT for token; false: sell token for USDT
    /// @param amountIn  input amount in the input token's base units (on a buy, any creator fee comes out of it)
    /// @param minOut    minimum output of the swap; must be within maxSlippageBps of the pool price
    /// @param note      short human-readable reason, stored in the event
    function trade(address token, bool isBuy, uint256 amountIn, uint256 minOut, string calldata note)
        external
        returns (uint256 amountOut)
    {
        return _trade(token, isBuy, amountIn, minOut, note, address(0), 0);
    }

    /// @notice The same trade, made for an agent that `creator` made. The creator is paid
    ///         min(feeBps, creatorFeeBps[creator]) of the trade in USDT: nothing when the owner has not approved them.
    function tradeFor(address token, bool isBuy, uint256 amountIn, uint256 minOut, string calldata note, address creator, uint16 feeBps)
        external
        returns (uint256 amountOut)
    {
        return _trade(token, isBuy, amountIn, minOut, note, creator, feeBps);
    }

    // ----- anyone -----

    /// @notice Sell the whole holding of `token` for USDT once it is worth less than the owner's stop-loss allows.
    ///         Anyone may call this; the proceeds stay in the vault. It works while the vault is paused, because
    ///         pausing is for stopping the agent, not for trapping a falling position.
    ///         It refuses while the pool price is away from its recent average, so a price pushed around for one
    ///         transaction can neither set the stop off nor make the sale cheap.
    function stopOut(address token) external returns (uint256 amountOut) {
        if (stopLossBps == 0) revert NoStopLoss();
        Market memory m = markets[token];
        if (m.pool == address(0)) revert MarketDisabled();
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 cost = costUsdt[token];
        if (held == 0 || cost == 0) revert NothingToSell();

        (, int24 tickNow,,,,,) = IUniswapV3Pool(m.pool).slot0();
        int24 tickAverage = _averageTick(m.pool);
        int24 gap = tickNow > tickAverage ? tickNow - tickAverage : tickAverage - tickNow;
        // one tick is 0.01% in price, the same size as one basis point
        if (uint24(gap) > maxSlippageBps) revert PriceMoving(tickNow, tickAverage);

        uint256 value = _quote(m, false, held);
        uint256 stopAt = (cost * (10_000 - stopLossBps)) / 10_000;
        if (value >= stopAt) revert StopNotReached(value, stopAt);

        amountOut = _swap(token, usdt, m.fee, held, (value * (10_000 - maxSlippageBps)) / 10_000);
        costUsdt[token] = 0;
        emit StoppedOut(token, msg.sender, held, amountOut, cost);
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

    /// @notice A holding at a glance: how much, what it cost, what it is worth at the pool price now, and the
    ///         value under which the stop-loss lets anyone sell it (0 when there is no stop-loss).
    function position(address token) external view returns (uint256 held, uint256 cost, uint256 valueUsdt, uint256 stopUsdt) {
        held = IERC20(token).balanceOf(address(this));
        cost = costUsdt[token];
        Market memory m = markets[token];
        valueUsdt = m.pool == address(0) || held == 0 ? 0 : _quote(m, false, held);
        stopUsdt = stopLossBps == 0 ? 0 : (cost * (10_000 - stopLossBps)) / 10_000;
    }

    // ----- internal -----

    /// The rate actually paid: what the agent asks for, never above what the owner approved, never to the agent.
    function _feeBps(address creator, uint16 feeBps) internal view returns (uint16) {
        if (creator == address(0) || creator == agent) return 0;
        uint16 approved = creatorFeeBps[creator];
        return feeBps < approved ? feeBps : approved;
    }

    function _payCreator(address creator, uint16 bps, bool isBuy, uint256 fee) internal {
        if (fee == 0) return;
        require(IERC20(usdt).transfer(creator, fee), "fee transfer failed");
        emit CreatorPaid(creator, usdt, isBuy, fee, bps);
    }

    function _trade(address token, bool isBuy, uint256 amountIn, uint256 minOut, string calldata note, address creator, uint16 feeBps)
        internal
        returns (uint256 amountOut)
    {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        Market memory m = markets[token];
        if (!m.enabled) revert MarketDisabled();
        uint16 bps = _feeBps(creator, feeBps);

        uint256 notional;
        if (isBuy) {
            // The fee comes out of the USDT the agent spends, so the limits cover everything that leaves the vault.
            uint256 fee = (amountIn * bps) / 10_000;
            uint256 swapIn = amountIn - fee;
            uint256 expectedOut = _quote(m, true, swapIn);
            uint256 floor = (expectedOut * (10_000 - maxSlippageBps)) / 10_000;
            if (minOut < floor) revert SlippageTooLoose(minOut, floor);
            notional = amountIn;
            // The limits are on what the agent may spend. Getting back out to USDT is never held up by them.
            if (notional > maxTradeUsdt) revert TradeTooLarge(notional, maxTradeUsdt);
            uint256 day = block.timestamp / 1 days;
            uint256 wouldSpend = spentOnDay[day] + notional;
            if (wouldSpend > maxDailyUsdt) revert DailyCapExceeded(wouldSpend, maxDailyUsdt);
            spentOnDay[day] = wouldSpend;
            amountOut = _swap(usdt, token, m.fee, swapIn, minOut);
            // The holding cost what went into the pool; the fee is not a fall in price, so it never brings a stop-loss closer.
            costUsdt[token] += swapIn;
            _payCreator(creator, bps, true, fee);
        } else {
            uint256 expectedOut = _quote(m, false, amountIn);
            uint256 floor = (expectedOut * (10_000 - maxSlippageBps)) / 10_000;
            if (minOut < floor) revert SlippageTooLoose(minOut, floor);
            notional = expectedOut;
            uint256 held = IERC20(token).balanceOf(address(this));
            uint256 gross = _swap(token, usdt, m.fee, amountIn, minOut);
            costUsdt[token] = amountIn >= held ? 0 : (costUsdt[token] * (held - amountIn)) / held;
            uint256 fee = (gross * bps) / 10_000;
            amountOut = gross - fee;
            _payCreator(creator, bps, false, fee);
        }
        emit Traded(token, isBuy, amountIn, amountOut, notional, note);
    }

    function _setLimits(uint256 maxTrade_, uint256 maxDaily_, uint16 slippageBps_) internal {
        if (maxTrade_ == 0 || maxDaily_ < maxTrade_ || slippageBps_ == 0 || slippageBps_ > 1_000) revert BadLimits();
        maxTradeUsdt = maxTrade_;
        maxDailyUsdt = maxDaily_;
        maxSlippageBps = slippageBps_;
        emit LimitsSet(maxTrade_, maxDaily_, slippageBps_);
    }

    function _setStopLoss(uint16 stopLossBps_) internal {
        if (stopLossBps_ > 9_000) revert BadLimits();
        stopLossBps = stopLossBps_;
        emit StopLossSet(stopLossBps_);
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

    function _swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut) internal returns (uint256) {
        require(IERC20(tokenIn).approve(address(router), amountIn), "approve failed"); // exact amount only
        return router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// The pool's own time-weighted average tick over STOP_WINDOW.
    function _averageTick(address pool) internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = STOP_WINDOW;
        ago[1] = 0;
        (int56[] memory cumulative,) = IUniswapV3Pool(pool).observe(ago);
        int56 delta = cumulative[1] - cumulative[0];
        int56 average = delta / int56(uint56(STOP_WINDOW));
        if (delta < 0 && (delta % int56(uint56(STOP_WINDOW)) != 0)) average--; // round towards the lower tick
        return int24(average);
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
