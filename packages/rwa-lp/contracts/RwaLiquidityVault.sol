// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FixedPoint128} from "@uniswap/v4-core/src/libraries/FixedPoint128.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {FullRangeLiquidity} from "./libraries/FullRangeLiquidity.sol";

/// @title Liquidity vault for one tokenized-stock pool
/// @notice Holds one full-range Uniswap v4 position and issues ERC-20 shares for it. A share is a
/// pro-rata claim on the position's liquidity and on the tokens the vault holds idle (collected
/// swap fees and rounding dust), so deposits and withdrawals are value-neutral for the other holders
/// at any pool price.
/// @dev
/// - `deposit(shares, …)` adds liquidity ⌈L·s/S⌉ and takes ⌈idle·s/S⌉ of each token; the depositor
///   caps what they pay with `amount0Max/amount1Max` (their price protection) and a deadline.
/// - `withdraw(shares, …)` removes ⌊L·s/S⌋ and pays ⌊idle·s/S⌋ with `amount0Min/amount1Min`. It
///   never touches the hook's add-liquidity check, so a halted pool never locks LP funds.
/// - Every deposit and withdrawal first collects the position's fees into idle balances.
/// - The first deposit locks MINIMUM_SHARES at a dead address (share-price inflation guard).
/// - `compound` turns idle balances into liquidity; only the operator may call it, inside a price
///   band it checked off-chain, because adding liquidity at a manipulated price loses value.
/// - With the allowlist on, only listed accounts may deposit or receive shares; leaving (burning
///   shares) is always allowed.
/// The owner and the operator cannot move depositors' funds.
contract RwaLiquidityVault is ERC20, Ownable2Step, ReentrancyGuardTransient, IUnlockCallback {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    uint256 public constant MINIMUM_SHARES = 1000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 internal constant SALT = bytes32(0);

    IPoolManager public immutable poolManager;
    Currency public immutable currency0;
    Currency public immutable currency1;
    PoolId public immutable poolId;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint24 internal immutable _fee;
    int24 internal immutable _tickSpacing;
    IHooks internal immutable _hooks;
    uint160 internal immutable _sqrtPriceLowerX96;
    uint160 internal immutable _sqrtPriceUpperX96;

    address public operator;
    bool public allowlistEnabled;
    mapping(address account => bool) public isAllowed;

    enum Action {
        Deposit,
        Withdraw,
        Compound
    }

    event Deposit(address indexed sender, address indexed to, uint256 shares, uint256 amount0, uint256 amount1);
    event Withdraw(address indexed sender, address indexed to, uint256 shares, uint256 amount0, uint256 amount1);
    event FeesCollected(uint256 amount0, uint256 amount1);
    event Compounded(uint128 liquidity, uint256 amount0, uint256 amount1);
    event OperatorSet(address operator);
    event AllowlistEnabled(bool enabled);
    event AllowedSet(address indexed account, bool allowed);

    error NotPoolManager();
    error NotOperator();
    error NotAllowed(address account);
    error ZeroShares();
    error FirstDepositTooSmall(uint256 shares);
    error DeadlinePassed(uint256 deadline);
    error SlippageExceeded(uint256 amount0, uint256 amount1);
    error PriceOutOfBounds(uint160 sqrtPriceX96);
    error NativeCurrencyUnsupported();
    error PoolNotInitialized();

    constructor(
        IPoolManager poolManager_,
        PoolKey memory key,
        string memory name_,
        string memory symbol_,
        address initialOwner
    ) ERC20(name_, symbol_) Ownable(initialOwner) {
        if (key.currency0.isAddressZero()) revert NativeCurrencyUnsupported();
        PoolId id = key.toId();
        (uint160 sqrtPriceX96,,,) = poolManager_.getSlot0(id);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        int24 lower = TickMath.minUsableTick(key.tickSpacing);
        int24 upper = TickMath.maxUsableTick(key.tickSpacing);
        poolManager = poolManager_;
        currency0 = key.currency0;
        currency1 = key.currency1;
        poolId = id;
        tickLower = lower;
        tickUpper = upper;
        _fee = key.fee;
        _tickSpacing = key.tickSpacing;
        _hooks = key.hooks;
        _sqrtPriceLowerX96 = TickMath.getSqrtPriceAtTick(lower);
        _sqrtPriceUpperX96 = TickMath.getSqrtPriceAtTick(upper);
    }

    modifier checkDeadline(uint256 deadline) {
        _checkDeadline(deadline);
        _;
    }

    // ---------------------------------------------------------------- deposits and withdrawals

    /// @notice Mints `shares` to `to` (the first deposit mints `shares - MINIMUM_SHARES`), paying at
    /// most `amount0Max` / `amount1Max`. Approve this vault for exactly what `previewDeposit` returns
    /// plus your slippage tolerance.
    function deposit(uint256 shares, uint256 amount0Max, uint256 amount1Max, address to, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        if (shares == 0) revert ZeroShares();
        if (allowlistEnabled && !isAllowed[msg.sender]) revert NotAllowed(msg.sender);
        uint256 supply = totalSupply();
        if (supply == 0 && shares <= MINIMUM_SHARES) revert FirstDepositTooSmall(shares);
        (amount0, amount1) = abi.decode(
            poolManager.unlock(abi.encode(Action.Deposit, abi.encode(msg.sender, shares, supply))), (uint256, uint256)
        );
        if (amount0 > amount0Max || amount1 > amount1Max) revert SlippageExceeded(amount0, amount1);
        if (supply == 0) {
            _mint(DEAD, MINIMUM_SHARES);
            shares -= MINIMUM_SHARES;
        }
        _mint(to, shares);
        emit Deposit(msg.sender, to, shares, amount0, amount1);
    }

    /// @notice Burns `shares` of the caller and sends the tokens behind them to `to`.
    function withdraw(uint256 shares, uint256 amount0Min, uint256 amount1Min, address to, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        if (shares == 0) revert ZeroShares();
        uint256 supply = totalSupply();
        _burn(msg.sender, shares);
        (amount0, amount1) = abi.decode(
            poolManager.unlock(abi.encode(Action.Withdraw, abi.encode(to, shares, supply))), (uint256, uint256)
        );
        if (amount0 < amount0Min || amount1 < amount1Min) revert SlippageExceeded(amount0, amount1);
        emit Withdraw(msg.sender, to, shares, amount0, amount1);
    }

    /// @notice Adds the idle balances to the position while the pool price is inside the band.
    function compound(uint160 minSqrtPriceX96, uint160 maxSqrtPriceX96)
        external
        nonReentrant
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (msg.sender != operator) revert NotOperator();
        (liquidity, amount0, amount1) = abi.decode(
            poolManager.unlock(abi.encode(Action.Compound, abi.encode(minSqrtPriceX96, maxSqrtPriceX96))),
            (uint128, uint256, uint256)
        );
        emit Compounded(liquidity, amount0, amount1);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, bytes memory args) = abi.decode(data, (Action, bytes));
        PoolKey memory key = poolKey();
        if (action == Action.Deposit) {
            (address payer, uint256 shares, uint256 supply) = abi.decode(args, (address, uint256, uint256));
            (uint256 amount0, uint256 amount1) = _depositUnlocked(key, payer, shares, supply);
            return abi.encode(amount0, amount1);
        }
        if (action == Action.Withdraw) {
            (address recipient, uint256 shares, uint256 supply) = abi.decode(args, (address, uint256, uint256));
            (uint256 amount0, uint256 amount1) = _withdrawUnlocked(key, recipient, shares, supply);
            return abi.encode(amount0, amount1);
        }
        (uint160 minSqrtPriceX96, uint160 maxSqrtPriceX96) = abi.decode(args, (uint160, uint160));
        (uint128 liquidity, uint256 paid0, uint256 paid1) = _compoundUnlocked(key, minSqrtPriceX96, maxSqrtPriceX96);
        return abi.encode(liquidity, paid0, paid1);
    }

    // ---------------------------------------------------------------- admin

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setAllowlistEnabled(bool enabled) external onlyOwner {
        allowlistEnabled = enabled;
        emit AllowlistEnabled(enabled);
    }

    function setAllowed(address[] calldata accounts, bool allowed) external onlyOwner {
        for (uint256 i; i < accounts.length; ++i) {
            isAllowed[accounts[i]] = allowed;
            emit AllowedSet(accounts[i], allowed);
        }
    }

    // ---------------------------------------------------------------- views

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({currency0: currency0, currency1: currency1, fee: _fee, tickSpacing: _tickSpacing, hooks: _hooks});
    }

    /// @notice Liquidity of the vault's position.
    function positionLiquidity() public view returns (uint128 liquidity) {
        (liquidity,,) = poolManager.getPositionInfo(poolId, address(this), tickLower, tickUpper, SALT);
    }

    /// @notice Swap fees the position has earned since they were last collected.
    function pendingFees() public view returns (uint256 fees0, uint256 fees1) {
        (uint128 liquidity, uint256 last0, uint256 last1) =
            poolManager.getPositionInfo(poolId, address(this), tickLower, tickUpper, SALT);
        (uint256 inside0, uint256 inside1) = poolManager.getFeeGrowthInside(poolId, tickLower, tickUpper);
        unchecked {
            fees0 = FullMath.mulDiv(inside0 - last0, liquidity, FixedPoint128.Q128);
            fees1 = FullMath.mulDiv(inside1 - last1, liquidity, FixedPoint128.Q128);
        }
    }

    /// @notice Everything the shares are a claim on: the position at the current price, idle
    /// balances and uncollected fees.
    function totalAmounts() external view returns (uint256 amount0, uint256 amount1) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        (amount0, amount1) = FullRangeLiquidity.amountsForLiquidity(
            sqrtPriceX96, _sqrtPriceLowerX96, _sqrtPriceUpperX96, positionLiquidity(), false
        );
        (uint256 idle0, uint256 idle1) = _idleWithFees();
        amount0 += idle0;
        amount1 += idle1;
    }

    /// @notice What `deposit(shares, …)` would take right now.
    function previewDeposit(uint256 shares) public view returns (uint256 amount0, uint256 amount1) {
        uint256 supply = totalSupply();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (supply == 0) {
            return FullRangeLiquidity.amountsForLiquidity(
                sqrtPriceX96, _sqrtPriceLowerX96, _sqrtPriceUpperX96, shares.toUint128(), true
            );
        }
        uint128 add = FullMath.mulDivRoundingUp(positionLiquidity(), shares, supply).toUint128();
        (amount0, amount1) =
            FullRangeLiquidity.amountsForLiquidity(sqrtPriceX96, _sqrtPriceLowerX96, _sqrtPriceUpperX96, add, true);
        (uint256 idle0, uint256 idle1) = _idleWithFees();
        amount0 += FullMath.mulDivRoundingUp(idle0, shares, supply);
        amount1 += FullMath.mulDivRoundingUp(idle1, shares, supply);
    }

    /// @notice What `withdraw(shares, …)` would pay right now.
    function previewWithdraw(uint256 shares) external view returns (uint256 amount0, uint256 amount1) {
        uint256 supply = totalSupply();
        if (supply == 0) return (0, 0);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        uint128 remove = FullMath.mulDiv(positionLiquidity(), shares, supply).toUint128();
        (amount0, amount1) =
            FullRangeLiquidity.amountsForLiquidity(sqrtPriceX96, _sqrtPriceLowerX96, _sqrtPriceUpperX96, remove, false);
        (uint256 idle0, uint256 idle1) = _idleWithFees();
        amount0 += FullMath.mulDiv(idle0, shares, supply);
        amount1 += FullMath.mulDiv(idle1, shares, supply);
    }

    /// @notice The most shares `amount0Max` and `amount1Max` buy right now (0 if too little).
    function sharesForAmounts(uint256 amount0Max, uint256 amount1Max) external view returns (uint256 shares) {
        uint256 supply = totalSupply();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (supply == 0) {
            // One wei of each is held back so the rounded-up amounts owed stay within the maxima.
            shares = FullRangeLiquidity.liquidityForAmounts(
                sqrtPriceX96,
                _sqrtPriceLowerX96,
                _sqrtPriceUpperX96,
                amount0Max == 0 ? 0 : amount0Max - 1,
                amount1Max == 0 ? 0 : amount1Max - 1
            );
            return shares > MINIMUM_SHARES ? shares : 0;
        }
        // Upper bound from the liquidity alone, then the largest share count whose rounded-up cost fits.
        uint128 addable = FullRangeLiquidity.liquidityForAmounts(
            sqrtPriceX96, _sqrtPriceLowerX96, _sqrtPriceUpperX96, amount0Max, amount1Max
        );
        uint256 hi = FullMath.mulDiv(addable, supply, positionLiquidity());
        uint256 lo;
        while (lo < hi) {
            uint256 mid = hi - (hi - lo) / 2;
            (uint256 cost0, uint256 cost1) = previewDeposit(mid);
            if (cost0 <= amount0Max && cost1 <= amount1Max) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    // ---------------------------------------------------------------- internals

    function _depositUnlocked(PoolKey memory key, address payer, uint256 shares, uint256 supply)
        internal
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 liquidityToAdd = shares;
        uint256 idle0;
        uint256 idle1;
        if (supply > 0) {
            uint128 liquidity = _collectFees(key);
            liquidityToAdd = FullMath.mulDivRoundingUp(liquidity, shares, supply);
            idle0 = FullMath.mulDivRoundingUp(currency0.balanceOfSelf(), shares, supply);
            idle1 = FullMath.mulDivRoundingUp(currency1.balanceOfSelf(), shares, supply);
        }
        BalanceDelta delta = _modifyLiquidity(key, liquidityToAdd.toInt256());
        uint256 owed0 = uint256(-int256(delta.amount0()));
        uint256 owed1 = uint256(-int256(delta.amount1()));
        _settle(currency0, payer, owed0);
        _settle(currency1, payer, owed1);
        if (idle0 > 0) IERC20(Currency.unwrap(currency0)).safeTransferFrom(payer, address(this), idle0);
        if (idle1 > 0) IERC20(Currency.unwrap(currency1)).safeTransferFrom(payer, address(this), idle1);
        return (owed0 + idle0, owed1 + idle1);
    }

    function _withdrawUnlocked(PoolKey memory key, address recipient, uint256 shares, uint256 supply)
        internal
        returns (uint256 amount0, uint256 amount1)
    {
        uint128 liquidity = _collectFees(key);
        uint256 idle0 = FullMath.mulDiv(currency0.balanceOfSelf(), shares, supply);
        uint256 idle1 = FullMath.mulDiv(currency1.balanceOfSelf(), shares, supply);
        uint256 liquidityToRemove = FullMath.mulDiv(liquidity, shares, supply);
        if (liquidityToRemove > 0) {
            BalanceDelta delta = _modifyLiquidity(key, -liquidityToRemove.toInt256());
            amount0 = uint128(delta.amount0());
            amount1 = uint128(delta.amount1());
            if (amount0 > 0) poolManager.take(currency0, recipient, amount0);
            if (amount1 > 0) poolManager.take(currency1, recipient, amount1);
        }
        if (idle0 > 0) currency0.transfer(recipient, idle0);
        if (idle1 > 0) currency1.transfer(recipient, idle1);
        return (amount0 + idle0, amount1 + idle1);
    }

    function _compoundUnlocked(PoolKey memory key, uint160 minSqrtPriceX96, uint160 maxSqrtPriceX96)
        internal
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        _collectFees(key);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 < minSqrtPriceX96 || sqrtPriceX96 > maxSqrtPriceX96) revert PriceOutOfBounds(sqrtPriceX96);
        uint256 balance0 = currency0.balanceOfSelf();
        uint256 balance1 = currency1.balanceOfSelf();
        // One wei of each is held back so the rounded-up amounts owed stay within the balances.
        liquidity = FullRangeLiquidity.liquidityForAmounts(
            sqrtPriceX96,
            _sqrtPriceLowerX96,
            _sqrtPriceUpperX96,
            balance0 == 0 ? 0 : balance0 - 1,
            balance1 == 0 ? 0 : balance1 - 1
        );
        if (liquidity == 0) return (0, 0, 0);
        BalanceDelta delta = _modifyLiquidity(key, uint256(liquidity).toInt256());
        amount0 = uint256(-int256(delta.amount0()));
        amount1 = uint256(-int256(delta.amount1()));
        _settle(currency0, address(this), amount0);
        _settle(currency1, address(this), amount1);
    }

    /// @dev Pokes the position so its fees move into the vault's idle balances; returns its liquidity.
    function _collectFees(PoolKey memory key) internal returns (uint128 liquidity) {
        liquidity = positionLiquidity();
        if (liquidity == 0) return 0;
        BalanceDelta fees = _modifyLiquidity(key, 0);
        uint256 fees0 = uint128(fees.amount0());
        uint256 fees1 = uint128(fees.amount1());
        if (fees0 > 0) poolManager.take(currency0, address(this), fees0);
        if (fees1 > 0) poolManager.take(currency1, address(this), fees1);
        if (fees0 > 0 || fees1 > 0) emit FeesCollected(fees0, fees1);
    }

    function _modifyLiquidity(PoolKey memory key, int256 liquidityDelta) internal returns (BalanceDelta delta) {
        (delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: SALT}),
            ""
        );
    }

    /// @dev Pays `amount` of `currency` owed to the PoolManager, from `payer` (or the vault itself).
    function _settle(Currency currency, address payer, uint256 amount) internal {
        if (amount == 0) return;
        poolManager.sync(currency);
        if (payer == address(this)) {
            IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        } else {
            IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(poolManager), amount);
        }
        poolManager.settle();
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert DeadlinePassed(deadline);
    }

    function _idleWithFees() internal view returns (uint256 idle0, uint256 idle1) {
        (uint256 fees0, uint256 fees1) = pendingFees();
        idle0 = currency0.balanceOfSelf() + fees0;
        idle1 = currency1.balanceOfSelf() + fees1;
    }

    /// @dev Allowlist on share transfers and mints; burns (leaving) and the first deposit's locked
    /// shares are never blocked.
    function _update(address from, address to, uint256 value) internal override {
        bool exit = to == address(0);
        bool lock = from == address(0) && to == DEAD;
        if (allowlistEnabled && !exit && !lock) {
            if (from != address(0) && !isAllowed[from]) revert NotAllowed(from);
            if (!isAllowed[to]) revert NotAllowed(to);
        }
        super._update(from, to, value);
    }
}
