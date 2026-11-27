// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test doubles for the vault: a token anyone can mint in tests, a Uniswap V3 pool whose price now and 10-minute
/// average can be set apart, and a router that swaps at the pool's price now minus its 0.3% fee.

contract MockERC20 {
    string public name;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, uint8 decimals_) {
        name = name_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

library TickMathRef {
    /// Uniswap V3 TickMath.getSqrtRatioAtTick.
    function sqrtAt(int24 tick) internal pure returns (uint160) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
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
}

contract MockPool {
    address public immutable token0;
    address public immutable token1;
    uint24 public constant fee = 3000;
    int24 public tick; // the price now
    int24 public avgTick; // what observe() reports as the 10-minute average

    constructor(address token0_, address token1_, int24 tick_) {
        token0 = token0_;
        token1 = token1_;
        tick = tick_;
        avgTick = tick_;
    }

    function setTicks(int24 now_, int24 average) external {
        tick = now_;
        avgTick = average;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (TickMathRef.sqrtAt(tick), tick, 0, 240, 240, 0, true);
    }

    function observe(uint32[] calldata ago) external view returns (int56[] memory cumulative, uint160[] memory perLiquidity) {
        cumulative = new int56[](ago.length);
        perLiquidity = new uint160[](ago.length);
        for (uint256 i = 0; i < ago.length; i++) cumulative[i] = int56(avgTick) * int56(uint56(block.timestamp - ago[i]));
    }
}

/// Swaps at the pool's price now, minus 0.3%. It takes the input from the caller and mints the output.
contract MockRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    MockPool public immutable pool;

    constructor(MockPool pool_) {
        pool = pool_;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        uint256 sqrtP = TickMathRef.sqrtAt(pool.tick());
        uint256 q96 = 1 << 96;
        out = p.tokenIn == pool.token0() ? ((p.amountIn * sqrtP) / q96) * sqrtP / q96 : ((p.amountIn * q96) / sqrtP) * q96 / sqrtP;
        out = (out * 997) / 1000;
        require(out >= p.amountOutMinimum, "Too little received");
        MockERC20(p.tokenOut).mint(p.recipient, out);
    }
}
