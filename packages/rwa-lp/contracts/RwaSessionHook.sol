// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IBStockMultiplier} from "./interfaces/IBStockMultiplier.sol";
import {IMarketCalendar} from "./interfaces/IMarketCalendar.sol";
import {IReferencePriceSource} from "./interfaces/IReferencePriceSource.sol";
import {PoolPriceMath} from "./libraries/PoolPriceMath.sol";

/// @title Session-aware liquidity hook for tokenized stocks (Uniswap v4)
/// @notice A tokenized stock trades on-chain around the clock, but its price is only discovered while
/// the US market is open. Liquidity providers in a plain pool sell the overnight and weekend gap to
/// whoever trades first at the open. This hook prices that risk into the swap fee:
/// - the fee follows the NYSE session from an on-chain calendar (regular < pre/post < closed), and
///   falls from the closed fee to the regular fee over an opening ramp;
/// - during the regular session, a swap that moves the pool toward a fresh reference price pays a
///   share of the gap it closes (arbitrage pays LPs), a swap that moves it away pays the session fee;
/// - around a scheduled bStocks multiplier change (dividend, split) the closed fee applies;
/// - a guardian can halt swaps and new liquidity for a pool (corporate action, issuer pause).
/// Liquidity can always be removed: the hook has no remove-liquidity permission at all.
/// @dev Pools are created only through `createPool`. `beforeInitialize` rejects every other caller;
/// the hook's own `initialize` call skips its hooks (Uniswap v4 `Hooks.noSelfCall`).
/// Worst case of a wrong reference price: fees stay within [session fee, maxFee]; swaps never revert
/// because of the oracle and LP funds are never touched.
contract RwaSessionHook is IHooks, Ownable2Step {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice Hard ceiling for any configured fee: 5% (Uniswap v4 fee unit, 1e6 = 100%).
    uint24 public constant MAX_FEE_CAP = 50_000;
    uint32 public constant MAX_OPENING_RAMP = 2 hours;
    uint32 public constant MAX_REFERENCE_AGE = 1 hours;
    uint32 public constant MAX_CORPORATE_ACTION_WINDOW = 3 days;
    /// @dev Gas for the calls a swap makes to contracts the hook does not own. A reference source or
    /// token that burns more, reverts or answers in the wrong shape is treated as having no answer.
    uint256 internal constant REFERENCE_CALL_GAS = 100_000;
    uint256 internal constant MULTIPLIER_CALL_GAS = 50_000;

    /// @notice Fees in hundredths of a bip (1_000_000 = 100%), the unit of Uniswap v4 LP fees.
    struct FeeSchedule {
        uint24 regularFee; // regular session, after the opening ramp
        uint24 extendedFee; // pre-market (04:00–09:30) and after-hours (to 20:00), New York time
        uint24 closedFee; // overnight, weekends, holidays, corporate-action windows
        uint24 maxFee; // ceiling of the session fee plus the reference-gap surcharge
        uint32 openingRamp; // seconds after the open during which the fee falls from closedFee to regularFee
        uint16 gapCaptureBps; // share of the reference gap charged to a swap that closes it (1e4 = 100%)
        uint32 maxReferenceAge; // seconds; an older reference price is ignored
        uint32 corporateActionWindow; // seconds on each side of a scheduled bStocks multiplier change
    }

    struct PoolConfig {
        address rwaToken;
        bool rwaIsCurrency0;
        bool halted;
        bool bStockMultiplier; // the token has uiMultiplier/newUIMultiplier/effectiveAt (bStocks)
        uint8 rwaDecimals;
        uint8 quoteDecimals;
        address liquidityGate; // if set, the only sender allowed to add liquidity (e.g. the vault)
        FeeSchedule fees;
    }

    struct PoolSettings {
        address rwaToken;
        address quoteToken;
        int24 tickSpacing;
        uint160 sqrtPriceX96;
        bool bStockMultiplier;
        address liquidityGate;
        FeeSchedule fees;
    }

    /// @notice Why a swap paid the fee it paid (emitted with every swap, shown by `quoteFee`).
    enum FeeReason {
        Regular,
        OpeningRamp,
        Extended,
        Closed,
        CorporateAction,
        ReferenceGap
    }

    IPoolManager public immutable poolManager;
    IMarketCalendar public immutable calendar;

    /// @notice Where the reference price comes from; zero disables the reference-gap surcharge.
    IReferencePriceSource public referenceSource;
    /// @notice May halt and resume pools, next to the owner.
    address public guardian;
    /// @notice USD stablecoins a tokenized stock may be paired with.
    mapping(address token => bool) public isQuoteToken;

    mapping(PoolId => PoolConfig) internal _pools;

    event PoolCreated(
        PoolId indexed id,
        address indexed rwaToken,
        address indexed quoteToken,
        int24 tickSpacing,
        bool bStockMultiplier,
        address liquidityGate
    );
    event FeeScheduleSet(PoolId indexed id, FeeSchedule fees);
    event LiquidityGateSet(PoolId indexed id, address gate);
    event HaltSet(PoolId indexed id, bool halted, address indexed by);
    event GuardianSet(address guardian);
    event ReferenceSourceSet(address source);
    event QuoteTokenSet(address indexed token, bool allowed);
    event SwapFeeApplied(PoolId indexed id, IMarketCalendar.Session session, FeeReason reason, uint24 fee);

    error NotPoolManager();
    error NotGuardian();
    error PoolsAreCreatedByTheHook();
    error HookNotImplemented();
    error UnknownPool(PoolId id);
    error PoolHalted(PoolId id);
    error LiquidityGated(address sender);
    error QuoteTokenNotAllowed(address token);
    error InvalidRwaToken(address token);
    error UnsupportedDecimals(address token, uint8 decimals);
    error InvalidFeeSchedule();

    modifier onlyPoolManager() {
        _checkPoolManager();
        _;
    }

    constructor(IPoolManager poolManager_, IMarketCalendar calendar_, address initialOwner) Ownable(initialOwner) {
        poolManager = poolManager_;
        calendar = calendar_;
        // Reverts unless this contract was deployed at an address carrying exactly these flags.
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------- admin

    /// @notice Creates and initializes a `rwaToken`/`quoteToken` pool with a dynamic fee.
    function createPool(PoolSettings calldata s) external onlyOwner returns (PoolKey memory key, PoolId id) {
        if (!isQuoteToken[s.quoteToken]) revert QuoteTokenNotAllowed(s.quoteToken);
        if (s.rwaToken == address(0) || isQuoteToken[s.rwaToken]) revert InvalidRwaToken(s.rwaToken);
        _validateFees(s.fees);
        uint8 rwaDecimals = _decimals(s.rwaToken);
        uint8 quoteDecimals = _decimals(s.quoteToken);
        // A bStocks flag on a token without the multiplier getters would charge the closed fee forever.
        if (s.bStockMultiplier) IBStockMultiplier(s.rwaToken).effectiveAt();

        bool rwaIsCurrency0 = s.rwaToken < s.quoteToken;
        key = PoolKey({
            currency0: Currency.wrap(rwaIsCurrency0 ? s.rwaToken : s.quoteToken),
            currency1: Currency.wrap(rwaIsCurrency0 ? s.quoteToken : s.rwaToken),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: s.tickSpacing,
            hooks: IHooks(address(this))
        });
        id = key.toId();
        _pools[id] = PoolConfig({
            rwaToken: s.rwaToken,
            rwaIsCurrency0: rwaIsCurrency0,
            halted: false,
            bStockMultiplier: s.bStockMultiplier,
            rwaDecimals: rwaDecimals,
            quoteDecimals: quoteDecimals,
            liquidityGate: s.liquidityGate,
            fees: s.fees
        });
        poolManager.initialize(key, s.sqrtPriceX96);
        emit PoolCreated(id, s.rwaToken, s.quoteToken, s.tickSpacing, s.bStockMultiplier, s.liquidityGate);
        emit FeeScheduleSet(id, s.fees);
    }

    function setFeeSchedule(PoolId id, FeeSchedule calldata fees) external onlyOwner {
        _validateFees(fees);
        _pool(id).fees = fees;
        emit FeeScheduleSet(id, fees);
    }

    function setLiquidityGate(PoolId id, address gate) external onlyOwner {
        _pool(id).liquidityGate = gate;
        emit LiquidityGateSet(id, gate);
    }

    /// @notice Stops (or resumes) swaps and new liquidity. Removing liquidity is never stopped.
    function setHalted(PoolId id, bool halted) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _pool(id).halted = halted;
        emit HaltSet(id, halted, msg.sender);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setReferenceSource(IReferencePriceSource source) external onlyOwner {
        referenceSource = source;
        emit ReferenceSourceSet(address(source));
    }

    function setQuoteToken(address token, bool allowed) external onlyOwner {
        isQuoteToken[token] = allowed;
        emit QuoteTokenSet(token, allowed);
    }

    // ---------------------------------------------------------------- views

    function poolConfig(PoolId id) external view returns (PoolConfig memory) {
        return _pools[id];
    }

    /// @notice The fee a swap in direction `zeroForOne` would pay right now, and why.
    function quoteFee(PoolKey calldata key, bool zeroForOne)
        external
        view
        returns (uint24 fee, IMarketCalendar.Session session, FeeReason reason)
    {
        PoolId id = key.toId();
        return _fee(id, _pool(id), zeroForOne);
    }

    // ---------------------------------------------------------------- hooks

    function beforeInitialize(address, PoolKey calldata, uint160) external view onlyPoolManager returns (bytes4) {
        revert PoolsAreCreatedByTheHook();
    }

    function beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        PoolId id = key.toId();
        PoolConfig storage p = _pools[id];
        if (p.halted) revert PoolHalted(id);
        address gate = p.liquidityGate;
        if (gate != address(0) && sender != gate) revert LiquidityGated(sender);
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolConfig storage p = _pools[id];
        if (p.halted) revert PoolHalted(id);
        (uint24 fee, IMarketCalendar.Session session, FeeReason reason) = _fee(id, p, params.zeroForOne);
        emit SwapFeeApplied(id, session, reason, fee);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    // Permissions this hook does not take. Uniswap v4 only calls what the address flags enable.
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    // ---------------------------------------------------------------- internals

    function _fee(PoolId id, PoolConfig storage p, bool zeroForOne)
        internal
        view
        returns (uint24 fee, IMarketCalendar.Session session, FeeReason reason)
    {
        FeeSchedule memory f = p.fees;
        uint256 openedAt;
        (session, openedAt) = calendar.sessionAt(block.timestamp);
        if (_inCorporateActionWindow(p, f.corporateActionWindow)) {
            return (f.closedFee, session, FeeReason.CorporateAction);
        }
        if (session == IMarketCalendar.Session.Pre || session == IMarketCalendar.Session.Post) {
            return (f.extendedFee, session, FeeReason.Extended);
        }
        if (session != IMarketCalendar.Session.Regular) return (f.closedFee, session, FeeReason.Closed);

        fee = f.regularFee;
        reason = FeeReason.Regular;
        uint256 sinceOpen = block.timestamp - openedAt;
        if (sinceOpen < f.openingRamp) {
            // Linear from closedFee at the bell to regularFee at the end of the ramp.
            fee = uint24(f.closedFee - (uint256(f.closedFee - f.regularFee) * sinceOpen) / f.openingRamp);
            reason = FeeReason.OpeningRamp;
        }
        uint256 surcharge = _gapSurcharge(id, p, f, zeroForOne);
        if (surcharge > 0) {
            uint256 total = fee + surcharge;
            // forge-lint: disable-next-line(unsafe-typecast) total <= maxFee <= MAX_FEE_CAP in that branch
            fee = total > f.maxFee ? f.maxFee : uint24(total);
            reason = FeeReason.ReferenceGap;
        }
    }

    /// @dev A swap that moves the pool price toward a fresh reference price pays `gapCaptureBps` of
    /// the gap; one that moves it away (or leaves no gap) pays nothing extra.
    function _gapSurcharge(PoolId id, PoolConfig storage p, FeeSchedule memory f, bool zeroForOne)
        internal
        view
        returns (uint256)
    {
        IReferencePriceSource source = referenceSource;
        if (address(source) == address(0) || f.gapCaptureBps == 0) return 0;
        (bool ok, uint256 referenceE18, uint256 observedAt) = _staticcallWords(
            address(source), REFERENCE_CALL_GAS, abi.encodeCall(IReferencePriceSource.referencePrice, (p.rwaToken)), 64
        );
        if (!ok) return 0;
        if (referenceE18 == 0 || observedAt > block.timestamp || block.timestamp - observedAt > f.maxReferenceAge) {
            return 0;
        }
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        uint256 poolE18 = PoolPriceMath.rwaPriceE18(sqrtPriceX96, p.rwaIsCurrency0, p.rwaDecimals, p.quoteDecimals);
        bool rwaDearInPool = poolE18 > referenceE18;
        bool sellsRwa = zeroForOne == p.rwaIsCurrency0;
        // Selling the RWA lowers its pool price; buying raises it. Only the side that closes the gap pays.
        if (rwaDearInPool != sellsRwa) return 0;
        return PoolPriceMath.gapPips(poolE18, referenceE18) * f.gapCaptureBps / 10_000;
    }

    function _inCorporateActionWindow(PoolConfig storage p, uint256 window) internal view returns (bool) {
        if (!p.bStockMultiplier || window == 0) return false;
        (bool ok, uint256 effectiveAt,) =
            _staticcallWords(p.rwaToken, MULTIPLIER_CALL_GAS, abi.encodeCall(IBStockMultiplier.effectiveAt, ()), 32);
        // The multiplier cannot be read: price as if a corporate action were under way.
        if (!ok) return true;
        if (effectiveAt == 0) return false;
        // |now − effectiveAt| <= window, written so that no token answer can overflow it.
        return effectiveAt >= block.timestamp
            ? effectiveAt - block.timestamp <= window
            : block.timestamp - effectiveAt <= window;
    }

    /// @dev `target.staticcall(data)` with at most `gasLimit`; `ok` only if it succeeded and answered
    /// exactly `size` bytes (32 or 64), returned as words. At most 64 bytes of the answer are copied,
    /// so a long one costs the swap nothing beyond the gas cap (no return-data bomb).
    function _staticcallWords(address target, uint256 gasLimit, bytes memory data, uint256 size)
        internal
        view
        returns (bool ok, uint256 word0, uint256 word1)
    {
        assembly ("memory-safe") {
            ok := staticcall(gasLimit, target, add(data, 0x20), mload(data), 0x00, 0x40)
            ok := and(ok, eq(returndatasize(), size))
            word0 := mload(0x00)
            word1 := mload(0x20)
        }
    }

    function _checkPoolManager() internal view {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    function _pool(PoolId id) internal view returns (PoolConfig storage p) {
        p = _pools[id];
        if (p.rwaToken == address(0)) revert UnknownPool(id);
    }

    function _decimals(address token) internal view returns (uint8 decimals) {
        decimals = IERC20Metadata(token).decimals();
        if (decimals > 18) revert UnsupportedDecimals(token, decimals);
    }

    function _validateFees(FeeSchedule calldata f) internal pure {
        if (
            f.regularFee > f.extendedFee || f.extendedFee > f.closedFee || f.closedFee > f.maxFee
                || f.maxFee > MAX_FEE_CAP || f.openingRamp > MAX_OPENING_RAMP || f.gapCaptureBps > 10_000
                || f.maxReferenceAge > MAX_REFERENCE_AGE || f.corporateActionWindow > MAX_CORPORATE_ACTION_WINDOW
        ) revert InvalidFeeSchedule();
    }
}
