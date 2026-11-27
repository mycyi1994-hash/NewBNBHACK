// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title MoaVault
/// @notice Holds one user's funds on HSK Chain. The owner deposits and withdraws; the Moa agent key may only
///         swap between USDT and an allow-listed token on HSKSwap (Uniswap V3), inside what the owner allows:
///         a per-trade and a per-day limit on what it may spend (both in USDT), and a price floor checked against
///         the pool's own 10-minute time-weighted average price. Selling back to USDT is never held up by the
///         spending limits.
///         The owner can also set a stop-loss: once a holding is worth that much less than it cost, anyone may
///         make the vault sell it, so the stop does not depend on Moa's server being up.
///         The agent can never move funds out of the vault.
///         Version 3 adds, for the owner:
///          - a creator fee: the owner may approve the person who made one agent they hired, for that agent only,
///            at a rate of at most 1%. Trades the agent key makes for that agent then pay that creator that share in
///            USDT. Nothing is ever paid to an address the owner did not approve, for an agent they did not name.
///          - per-agent budgets: once the owner turns them on, every buy names an agent and spends from the budget
///            the owner gave that agent; a buy over it is refused.
///          - the price floor of every trade taken from the pool's 10-minute average instead of its price now, so a
///            price pushed around inside one block cannot be traded against.
///          - a global halt: the factory's guardian may stop agent trading on every vault at once (never withdrawals,
///            never the stop-loss, never any funds).

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

/// The one switch the factory holds over its vaults: the guardian's halt of agent trading.
interface IMoaHalt {
    function halted() external view returns (bool);
}

contract MoaVault {
    struct Market {
        address pool; // HSKSwap pool of token/USDT
        uint24 fee;
        bool tokenIsToken0; // price math direction
        bool enabled;
    }

    /// The creator the owner approved for one agent, and the most it may be paid, in basis points of a trade.
    struct CreatorFee {
        address creator;
        uint16 bps;
    }

    /// Trades and the stop-loss compare against the pool's average price over this long, so that a price pushed
    /// around inside one block can neither be traded against nor set a stop off.
    uint32 public constant STOP_WINDOW = 10 minutes;
    /// Version 1 had no stop-loss, version 2 no creator fee. Older vaults have no VERSION at all.
    uint16 public constant VERSION = 3;
    /// The highest creator fee an owner can approve: 100 basis points = 1% of a trade.
    uint16 public constant MAX_CREATOR_FEE_BPS = 100;

    address public immutable owner;
    address public immutable usdt;
    ISwapRouter02 public immutable router;
    /// The factory that made this vault; its guardian may halt agent trading (see IMoaHalt), nothing else.
    address public immutable factory;

    address public agent;
    bool public paused;
    uint256 public maxTradeUsdt; // most USDT the agent may spend in one buy (6 decimals)
    uint256 public maxDailyUsdt; // most USDT the agent may spend on buys per UTC day
    uint16 public maxSlippageBps; // worst price accepted, against the pool's 10-minute average price
    uint16 public stopLossBps; // 0 = no stop-loss; otherwise the loss on a holding at which anyone may sell it
    /// When on, every buy names an agent and must fit in what is left of that agent's budget.
    bool public budgetsOn;
    /// Set while a trade, a stop-out or a withdrawal runs, so none of them can be entered again from inside a call.
    bool private _busy;

    mapping(address token => Market) public markets;
    mapping(uint256 day => uint256 usdt) public spentOnDay;
    /// What the token the vault holds now cost, in USDT. Buys add to it; sells and withdrawals take their share out.
    mapping(address token => uint256 usdt) public costUsdt;
    /// Per agent (an id the app gives each hired agent): the creator the owner approved for it, and the rate.
    mapping(bytes32 agentId => CreatorFee) public creatorOf;
    /// Per agent: the USDT it may still spend on buys while budgets are on.
    mapping(bytes32 agentId => uint256 usdt) public budgetLeft;

    event AgentSet(address indexed agent);
    event LimitsSet(uint256 maxTradeUsdt, uint256 maxDailyUsdt, uint16 maxSlippageBps);
    event StopLossSet(uint16 stopLossBps);
    event MarketSet(address indexed token, address pool, uint24 fee, bool enabled);
    event Paused(bool paused);
    event Withdrawn(address indexed token, uint256 amount);
    event Traded(address indexed token, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 notionalUsdt, string note);
    event StoppedOut(address indexed token, address indexed caller, uint256 amountIn, uint256 amountOut, uint256 costUsdt);
    event CreatorFeeSet(bytes32 indexed agentId, address indexed creator, uint16 bps);
    event CreatorPaid(address indexed creator, bytes32 indexed agentId, bool isBuy, uint256 feeUsdt, uint16 bps);
    event BudgetSet(bytes32 indexed agentId, uint256 usdt);
    event BudgetsOn(bool on);
    event BudgetSpent(bytes32 indexed agentId, uint256 usdt, uint256 left);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error Halted();
    error MarketDisabled();
    error TradeTooLarge(uint256 notionalUsdt, uint256 cap);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error OverBudget(bytes32 agentId, uint256 notionalUsdt, uint256 left);
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

    modifier oneAtATime() {
        require(!_busy, "reentered");
        _busy = true;
        _;
        _busy = false;
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
        require(usdt_ != address(0) && router_ != address(0), "zero address");
        owner = owner_;
        agent = agent_;
        usdt = usdt_;
        router = ISwapRouter02(router_);
        factory = msg.sender;
        _setLimits(maxTrade_, maxDaily_, slippageBps_);
        _setStopLoss(stopLossBps_);
        emit AgentSet(agent_);
        for (uint256 i = 0; i < tokens.length; i++) _setMarket(tokens[i], pools[i], true);
    }

    // ----- owner -----

    /// @notice Replace (or, with any address you control, revoke) the agent key of this vault alone.
    function setAgent(address agent_) external onlyOwner {
        require(agent_ != owner, "bad agent");
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

    /// @notice Approve the maker of one agent you hired, at up to MAX_CREATOR_FEE_BPS of each trade the agent key
    ///         makes for that agent. bps 0 withdraws it. The agent key can neither call this nor be approved.
    function setCreatorFee(bytes32 agentId, address creator, uint16 bps) external onlyOwner {
        if (bps == 0) {
            delete creatorOf[agentId];
            emit CreatorFeeSet(agentId, address(0), 0);
            return;
        }
        if (creator == address(0) || creator == address(this) || creator == agent) revert BadCreator();
        if (bps > MAX_CREATOR_FEE_BPS) revert FeeTooHigh(bps, MAX_CREATOR_FEE_BPS);
        creatorOf[agentId] = CreatorFee({creator: creator, bps: bps});
        emit CreatorFeeSet(agentId, creator, bps);
    }

    /// @notice What one agent may still spend on buys, in USDT (6 decimals). Counts only while budgets are on.
    function setBudget(bytes32 agentId, uint256 usdt_) external onlyOwner {
        budgetLeft[agentId] = usdt_;
        emit BudgetSet(agentId, usdt_);
    }

    /// @notice With budgets on, every buy must name an agent that has budget left (agent id 0 is the plain `trade`).
    function setBudgetsOn(bool on) external onlyOwner {
        budgetsOn = on;
        emit BudgetsOn(on);
    }

    /// @notice Only the owner can take funds out, and only to the owner.
    function withdraw(address token, uint256 amount) external onlyOwner oneAtATime {
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held > 0 && costUsdt[token] > 0) costUsdt[token] = amount >= held ? 0 : (costUsdt[token] * (held - amount)) / held;
        require(IERC20(token).transfer(owner, amount), "transfer failed");
        emit Withdrawn(token, amount);
    }

    // ----- agent -----

    /// @param token     allow-listed token (e.g. WHSK, WETH, WBTC)
    /// @param isBuy     true: spend USDT for token; false: sell token for USDT
    /// @param amountIn  input amount in the input token's base units
    /// @param minOut    minimum output of the swap; must be within maxSlippageBps of the pool's 10-minute average
    /// @param note      short human-readable reason, stored in the event
    function trade(address token, bool isBuy, uint256 amountIn, uint256 minOut, string calldata note)
        external
        oneAtATime
        returns (uint256 amountOut)
    {
        return _trade(token, isBuy, amountIn, minOut, note, bytes32(0), 0);
    }

    /// @notice The same trade, made for one hired agent. It spends from that agent's budget (when budgets are on),
    ///         and pays that agent's approved creator min(feeBps, the approved rate) in USDT; nothing when the owner
    ///         approved no creator for this agent. On a buy the fee comes out of amountIn.
    function tradeFor(address token, bool isBuy, uint256 amountIn, uint256 minOut, string calldata note, bytes32 agentId, uint16 feeBps)
        external
        oneAtATime
        returns (uint256 amountOut)
    {
        return _trade(token, isBuy, amountIn, minOut, note, agentId, feeBps);
    }

    // ----- anyone -----

    /// @notice Sell the whole holding of `token` for USDT once it is worth less than the owner's stop-loss allows.
    ///         Anyone may call this; the proceeds stay in the vault. It works while the vault is paused or halted,
    ///         because those stop the agent, not a falling position.
    ///         It refuses while the pool price is away from its recent average, so a price pushed around for one
    ///         transaction can neither set the stop off nor make the sale cheap.
    function stopOut(address token) external oneAtATime returns (uint256 amountOut) {
        if (stopLossBps == 0) revert NoStopLoss();
        Market memory m = markets[token];
        if (m.pool == address(0)) revert MarketDisabled();
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 cost = costUsdt[token];
        if (held == 0 || cost == 0) revert NothingToSell();

        (uint160 sqrtP, int24 tickNow,,,,,) = IUniswapV3Pool(m.pool).slot0();
        int24 tickAverage = _averageTick(m.pool);
        int24 gap = tickNow > tickAverage ? tickNow - tickAverage : tickAverage - tickNow;
        // one tick is 0.01% in price, the same size as one basis point
        if (uint24(gap) > maxSlippageBps) revert PriceMoving(tickNow, tickAverage);

        uint256 value = _quoteAt(m, false, held, sqrtP);
        uint256 stopAt = (cost * (10_000 - stopLossBps)) / 10_000;
        if (value >= stopAt) revert StopNotReached(value, stopAt);

        costUsdt[token] = 0;
        amountOut = _swap(token, usdt, m.fee, held, (value * (10_000 - maxSlippageBps)) / 10_000);
        emit StoppedOut(token, msg.sender, held, amountOut, cost);
    }

    // ----- views -----

    /// @notice Output for amountIn at the current pool price, before fees and price impact.
    function quote(address token, bool isBuy, uint256 amountIn) external view returns (uint256) {
        Market memory m = markets[token];
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(m.pool).slot0();
        return _quoteAt(m, isBuy, amountIn, sqrtP);
    }

    /// @notice Output for amountIn at the pool's 10-minute average price, before fees and price impact.
    function quoteTwap(address token, bool isBuy, uint256 amountIn) public view returns (uint256) {
        Market memory m = markets[token];
        return _quoteAt(m, isBuy, amountIn, _sqrtAtTick(_averageTick(m.pool)));
    }

    /// @notice The least minOut a trade of amountIn may ask for (the swap's own input: on a buy, after any creator fee).
    function minOutFloor(address token, bool isBuy, uint256 amountIn) external view returns (uint256) {
        return (quoteTwap(token, isBuy, amountIn) * (10_000 - maxSlippageBps)) / 10_000;
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
        if (m.pool != address(0) && held > 0) {
            (uint160 sqrtP,,,,,,) = IUniswapV3Pool(m.pool).slot0();
            valueUsdt = _quoteAt(m, false, held, sqrtP);
        }
        stopUsdt = stopLossBps == 0 ? 0 : (cost * (10_000 - stopLossBps)) / 10_000;
    }

    // ----- internal -----

    /// Who is paid for this agent and at what rate: what the agent key asks for, never above what the owner approved
    /// for this agent, never to the agent key.
    function _creatorFee(bytes32 agentId, uint16 feeBps) internal view returns (address creator, uint16 bps) {
        CreatorFee memory c = creatorOf[agentId];
        if (c.creator == address(0) || c.creator == agent) return (address(0), 0);
        return (c.creator, feeBps < c.bps ? feeBps : c.bps);
    }

    function _payCreator(address creator, bytes32 agentId, uint16 bps, bool isBuy, uint256 fee) internal {
        if (fee == 0) return;
        require(IERC20(usdt).transfer(creator, fee), "fee transfer failed");
        emit CreatorPaid(creator, agentId, isBuy, fee, bps);
    }

    /// minOut must be within maxSlippageBps of the pool's 10-minute average; a pool price now that is already worse
    /// than that is refused as moving before anything is swapped.
    function _checkFloor(Market memory m, bool isBuy, uint256 swapIn, uint256 minOut) internal view {
        int24 tickAverage = _averageTick(m.pool);
        uint256 floor = (_quoteAt(m, isBuy, swapIn, _sqrtAtTick(tickAverage)) * (10_000 - maxSlippageBps)) / 10_000;
        if (minOut < floor) revert SlippageTooLoose(minOut, floor);
        (uint160 sqrtP, int24 tickNow,,,,,) = IUniswapV3Pool(m.pool).slot0();
        if (_quoteAt(m, isBuy, swapIn, sqrtP) < floor) revert PriceMoving(tickNow, tickAverage);
    }

    function _trade(address token, bool isBuy, uint256 amountIn, uint256 minOut, string calldata note, bytes32 agentId, uint16 feeBps)
        internal
        returns (uint256 amountOut)
    {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        if (IMoaHalt(factory).halted()) revert Halted();
        Market memory m = markets[token];
        if (!m.enabled) revert MarketDisabled();
        (address creator, uint16 bps) = _creatorFee(agentId, feeBps);

        uint256 notional;
        if (isBuy) {
            // The fee comes out of the USDT the agent spends, so the limits cover everything that leaves the vault.
            uint256 fee = (amountIn * bps) / 10_000;
            uint256 swapIn = amountIn - fee;
            _checkFloor(m, true, swapIn, minOut);
            notional = amountIn;
            // The limits are on what the agent may spend. Getting back out to USDT is never held up by them.
            if (notional > maxTradeUsdt) revert TradeTooLarge(notional, maxTradeUsdt);
            uint256 day = block.timestamp / 1 days;
            uint256 wouldSpend = spentOnDay[day] + notional;
            if (wouldSpend > maxDailyUsdt) revert DailyCapExceeded(wouldSpend, maxDailyUsdt);
            spentOnDay[day] = wouldSpend;
            if (budgetsOn) {
                uint256 left = budgetLeft[agentId];
                if (notional > left) revert OverBudget(agentId, notional, left);
                budgetLeft[agentId] = left - notional;
                emit BudgetSpent(agentId, notional, left - notional);
            }
            // The holding cost what went into the pool; the fee is not a fall in price, so it never brings a stop-loss closer.
            costUsdt[token] += swapIn;
            amountOut = _swap(usdt, token, m.fee, swapIn, minOut);
            _payCreator(creator, agentId, bps, true, fee);
        } else {
            _checkFloor(m, false, amountIn, minOut);
            (uint160 sqrtP,,,,,,) = IUniswapV3Pool(m.pool).slot0();
            notional = _quoteAt(m, false, amountIn, sqrtP);
            uint256 held = IERC20(token).balanceOf(address(this));
            costUsdt[token] = amountIn >= held ? 0 : (costUsdt[token] * (held - amountIn)) / held;
            uint256 gross = _swap(token, usdt, m.fee, amountIn, minOut);
            uint256 fee = (gross * bps) / 10_000;
            amountOut = gross - fee;
            _payCreator(creator, agentId, bps, false, fee);
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

    /// sqrt(1.0001^tick) * 2^96: Uniswap V3's TickMath.getSqrtRatioAtTick.
    function _sqrtAtTick(int24 tick) internal pure returns (uint160) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= 887272, "tick");
            uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
            if (tick > 0) ratio = type(uint256).max / ratio;
            return uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }

    /// Output for amountIn at the price sqrtP (price of token0 in token1 = (sqrtP / 2^96)^2).
    function _quoteAt(Market memory m, bool isBuy, uint256 amountIn, uint160 sqrtP) internal pure returns (uint256) {
        uint256 q96 = 1 << 96;
        // selling token0 or buying token1 means converting token0 -> token1: multiply by price
        bool zeroForOne = isBuy ? !m.tokenIsToken0 : m.tokenIsToken0;
        if (zeroForOne) return ((amountIn * sqrtP) / q96) * sqrtP / q96;
        return ((amountIn * q96) / sqrtP) * q96 / sqrtP;
    }
}
