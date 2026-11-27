// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MoaVault} from "../src/MoaVault.sol";
import {MoaVaultFactory} from "../src/MoaVaultFactory.sol";
import {MockERC20, MockPool, MockRouter} from "./Mocks.sol";

/// The pieces every test starts from: USDT and WETH, one pool (WETH is token0, about $3,000), the factory with safe
/// starting values and a guardian, and the owner's vault holding 10,000 USDT.
abstract contract Base is Test {
    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xA6E7);
    address constant GUARD = address(0x6A2D);
    address constant TREASURY = address(0x7EA5);
    address constant STRANGER = address(0xBAD);
    address constant CREATOR = address(0xC2EA);
    address constant CREATOR2 = address(0xC2EB);
    int24 constant TICK = -196_250; // WETH (18 decimals) at about 3,000 USDT (6 decimals)

    MockERC20 usdt;
    MockERC20 weth;
    MockPool pool;
    MockRouter router;
    MoaVaultFactory factory;
    MoaVault vault;

    function _deploy() internal {
        vm.warp(1_800_000_000);
        usdt = new MockERC20("USDT", 6);
        weth = new MockERC20("WETH", 18);
        pool = new MockPool(address(weth), address(usdt), TICK);
        router = new MockRouter(pool);
        address[] memory tokens = new address[](1);
        address[] memory pools = new address[](1);
        tokens[0] = address(weth);
        pools[0] = address(pool);
        factory = new MoaVaultFactory(AGENT, address(usdt), address(router), 50e6, 100e6, 150, 1500, tokens, pools, GUARD);
        vault = MoaVault(factory.createVault(OWNER));
        usdt.mint(address(vault), 10_000e6);
    }

    /// A buy for `id` at the least minOut the vault accepts, from the agent key.
    function _buy(bytes32 id, uint256 amount, uint16 feeAsk) internal returns (uint256) {
        uint256 cut = _fees(id, amount, feeAsk);
        uint256 minOut = vault.minOutFloor(address(weth), true, amount - cut);
        vm.prank(AGENT);
        return vault.tradeFor(address(weth), true, amount, minOut, "t", id, feeAsk);
    }

    function _fees(bytes32 id, uint256 amount, uint16 feeAsk) internal view returns (uint256) {
        (address c, uint16 approved) = vault.creatorOf(id);
        uint16 cb = c == address(0) ? 0 : (feeAsk < approved ? feeAsk : approved);
        return (amount * cb) / 10_000 + (amount * factory.platformFeeBps()) / 10_000;
    }
}

/// One test per guard: each refusal the vault promises, and the exact amounts it pays.
contract MoaVaultUnit is Base {
    bytes32 constant A = keccak256("hire-a");

    function setUp() public {
        _deploy();
    }

    function test_startsWithSafeLimitsAndASession() public view {
        assertEq(vault.maxTradeUsdt(), 50e6);
        assertEq(vault.maxDailyUsdt(), 100e6);
        assertEq(vault.stopLossBps(), 1500);
        assertEq(vault.agent(), AGENT);
        assertEq(vault.agentUntil(), block.timestamp + 30 days);
        assertTrue(vault.sessionAllows(address(weth)));
        assertEq(factory.platformFeeBps(), 0);
    }

    function test_factoryRefusesNoLimitsOrNoStop() public {
        address[] memory tokens = new address[](1);
        address[] memory pools = new address[](1);
        tokens[0] = address(weth);
        pools[0] = address(pool);
        vm.expectRevert(bytes("unsafe starting limits"));
        new MoaVaultFactory(AGENT, address(usdt), address(router), type(uint256).max, type(uint256).max, 150, 1500, tokens, pools, GUARD);
        vm.expectRevert(bytes("unsafe starting stop-loss"));
        new MoaVaultFactory(AGENT, address(usdt), address(router), 50e6, 100e6, 150, 0, tokens, pools, GUARD);
    }

    function test_onlyTheAgentTrades() public {
        vm.prank(STRANGER);
        vm.expectRevert(MoaVault.NotAgent.selector);
        vault.trade(address(weth), true, 1e6, 0, "x");
    }

    function test_ownerOnlyCalls() public {
        vm.startPrank(AGENT);
        vm.expectRevert(MoaVault.NotOwner.selector);
        vault.setLimits(type(uint256).max, type(uint256).max, 1000);
        vm.expectRevert(MoaVault.NotOwner.selector);
        vault.withdraw(address(usdt), 1);
        vm.expectRevert(MoaVault.NotOwner.selector);
        vault.setSession(AGENT, uint64(block.timestamp + 300 days), type(uint256).max, new address[](0));
        vm.expectRevert(MoaVault.NotOwner.selector);
        vault.setCreatorFee(A, AGENT, 100);
        vm.expectRevert(MoaVault.NotOwner.selector);
        vault.setBudget(A, type(uint256).max);
        vm.stopPrank();
    }

    function test_limits() public {
        vm.expectRevert(abi.encodeWithSelector(MoaVault.TradeTooLarge.selector, 51e6, 50e6));
        this.buyExternal(bytes32(0), 51e6);
        _buy(bytes32(0), 50e6, 0);
        _buy(bytes32(0), 50e6, 0);
        vm.expectRevert(abi.encodeWithSelector(MoaVault.DailyCapExceeded.selector, 101e6, 100e6));
        this.buyExternal(bytes32(0), 1e6);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _buy(bytes32(0), 1e6, 0); // a new day
    }

    function buyExternal(bytes32 id, uint256 amount) external {
        _buy(id, amount, 0);
    }

    function test_floorFromTheAverage() public {
        // the price now pushed 3% under the average: a sell at the average's floor is refused before any swap
        _buy(bytes32(0), 20e6, 0);
        uint256 held = weth.balanceOf(address(vault));
        pool.setTicks(TICK - 300, TICK);
        uint256 floor = vault.minOutFloor(address(weth), false, held);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(MoaVault.PriceMoving.selector, TICK - 300, TICK));
        vault.trade(address(weth), false, held, floor, "x");
        // asking for less than the floor is refused whatever the price now
        vm.prank(AGENT);
        vm.expectRevert();
        vault.trade(address(weth), false, held, floor - 1, "x");
    }

    function test_sessionScopeExpiryAndRevoke() public {
        address[] memory none = new address[](0);
        vm.startPrank(OWNER);
        vm.expectRevert(MoaVault.BadSession.selector);
        vault.setSession(AGENT, uint64(block.timestamp + 366 days), 1e6, none);
        vault.setSession(AGENT, uint64(block.timestamp + 1 days), 5e6, none); // no coins in scope
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(MoaVault.NotInSession.selector, address(weth)));
        this.buyExternal(bytes32(0), 1e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);
        vm.prank(OWNER);
        vault.setSession(AGENT, uint64(block.timestamp + 1 days), 5e6, tokens);
        vm.expectRevert(abi.encodeWithSelector(MoaVault.TradeTooLarge.selector, 6e6, 5e6));
        this.buyExternal(bytes32(0), 6e6);
        _buy(bytes32(0), 5e6, 0);
        uint256 ended = block.timestamp + 1 days;
        vm.warp(ended + 1);
        vm.expectRevert(abi.encodeWithSelector(MoaVault.SessionOver.selector, uint64(ended)));
        this.buyExternal(bytes32(0), 1e6);
        vm.prank(OWNER);
        // (vm.getBlockTimestamp: with via-IR, block.timestamp read twice in one test may be the value from before the warp)
        vault.setSession(AGENT, uint64(vm.getBlockTimestamp() + 1 days), 5e6, tokens);
        vm.prank(OWNER);
        vault.revokeSession();
        vm.expectRevert(abi.encodeWithSelector(MoaVault.SessionOver.selector, uint64(0)));
        this.buyExternal(bytes32(0), 1e6);
    }

    function test_creatorAndPlatformFeesExact() public {
        vm.prank(OWNER);
        vault.setCreatorFee(A, CREATOR, 50);
        vm.prank(GUARD);
        factory.setPlatformFee(20, TREASURY);
        uint256 before = usdt.balanceOf(address(vault));
        _buy(A, 10e6, 100); // asks 1%, gets the 0.5% approved
        assertEq(usdt.balanceOf(CREATOR), 50_000);
        assertEq(usdt.balanceOf(TREASURY), 20_000);
        assertEq(before - usdt.balanceOf(address(vault)), 10e6);
        assertEq(vault.costUsdt(address(weth)), 10e6 - 70_000);
        assertEq(vault.spentOnDay(block.timestamp / 1 days), 10e6);
    }

    function test_feeCaps() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MoaVault.FeeTooHigh.selector, uint16(101), uint16(100)));
        vault.setCreatorFee(A, CREATOR, 101);
        vm.prank(OWNER);
        vm.expectRevert(MoaVault.BadCreator.selector);
        vault.setCreatorFee(A, AGENT, 50);
        vm.prank(GUARD);
        vm.expectRevert(bytes("fee too high"));
        factory.setPlatformFee(21, TREASURY);
        vm.prank(STRANGER);
        vm.expectRevert(bytes("not guardian"));
        factory.setPlatformFee(1, TREASURY);
    }

    function test_budgets() public {
        vm.startPrank(OWNER);
        vault.setBudget(A, 15e6);
        vault.setBudgetsOn(true);
        vm.stopPrank();
        _buy(A, 10e6, 0);
        assertEq(vault.budgetLeft(A), 5e6);
        vm.expectRevert(abi.encodeWithSelector(MoaVault.OverBudget.selector, A, 10e6, 5e6));
        this.buyExternal(A, 10e6);
        vm.expectRevert(abi.encodeWithSelector(MoaVault.OverBudget.selector, bytes32(0), 1e6, 0));
        this.buyExternal(bytes32(0), 1e6);
    }

    function test_stopLoss() public {
        // no holding, then a holding near its cost, then a fall that has not held, then one that has
        vm.expectRevert(MoaVault.NothingToSell.selector);
        vault.stopOut(address(weth));
        _buy(bytes32(0), 40e6, 0);
        vm.expectRevert();
        vault.stopOut(address(weth)); // StopNotReached: worth about what it cost
        pool.setTicks(TICK - 2_000, TICK); // about 18% lower now, average unchanged
        vm.expectRevert(abi.encodeWithSelector(MoaVault.PriceMoving.selector, TICK - 2_000, TICK));
        vault.stopOut(address(weth));
        pool.setTicks(TICK - 2_000, TICK - 2_000); // the fall has held
        (, uint256 cost, uint256 value, uint256 stopAt) = vault.position(address(weth));
        assertLt(value, stopAt);
        assertGt(cost, 0);
        uint256 before = usdt.balanceOf(address(vault));
        vm.prank(STRANGER); // anyone, while the vault is paused or halted too
        vault.stopOut(address(weth));
        assertEq(weth.balanceOf(address(vault)), 0);
        assertGt(usdt.balanceOf(address(vault)), before);
        assertEq(usdt.balanceOf(STRANGER), 0);
        vm.prank(OWNER);
        vault.setStopLoss(0);
        vm.expectRevert(MoaVault.NoStopLoss.selector);
        vault.stopOut(address(weth));
    }

    function test_pauseMarketsAndAgent() public {
        vm.prank(OWNER);
        vault.setPaused(true);
        vm.expectRevert(MoaVault.IsPaused.selector);
        this.buyExternal(bytes32(0), 1e6);
        vm.prank(OWNER);
        vault.setPaused(false);
        vm.prank(OWNER);
        vault.setMarket(address(weth), address(pool), false);
        vm.expectRevert(MoaVault.MarketDisabled.selector);
        this.buyExternal(bytes32(0), 1e6);
        vm.prank(OWNER);
        vault.setMarket(address(weth), address(pool), true);
        vm.prank(OWNER);
        vault.setAgent(STRANGER);
        vm.expectRevert(MoaVault.NotAgent.selector);
        this.buyExternal(bytes32(0), 1e6);
        vm.prank(OWNER);
        vm.expectRevert(bytes("bad agent"));
        vault.setAgent(OWNER);
        vm.prank(OWNER);
        vm.expectRevert(MoaVault.BadLimits.selector);
        vault.setLimits(0, 1, 150);
        vm.prank(OWNER);
        vm.expectRevert(MoaVault.BadLimits.selector);
        vault.setStopLoss(9_001);
    }

    function test_viewsAndWithdrawKeepTheBooks() public {
        assertEq(vault.remainingToday(), 100e6);
        _buy(bytes32(0), 30e6, 0);
        assertEq(vault.remainingToday(), 70e6);
        assertGt(vault.quote(address(weth), true, 1e6), 0);
        assertEq(vault.quote(address(weth), true, 1e6), vault.quoteTwap(address(weth), true, 1e6)); // still pool
        uint256 held = weth.balanceOf(address(vault));
        uint256 cost = vault.costUsdt(address(weth));
        vm.prank(OWNER);
        vault.withdraw(address(weth), held / 2);
        assertApproxEqAbs(vault.costUsdt(address(weth)), cost / 2, 1);
        assertEq(weth.balanceOf(OWNER), held / 2);
    }

    function test_haltStopsTradesNotWithdrawals() public {
        vm.prank(GUARD);
        factory.setHalted(true);
        vm.expectRevert(MoaVault.Halted.selector);
        this.buyExternal(bytes32(0), 1e6);
        vm.prank(OWNER);
        vault.withdraw(address(usdt), 1e6);
        assertEq(usdt.balanceOf(OWNER), 1e6);
    }
}

/// Random sequences of calls by the owner, the agent key, the guardian and strangers, with a running account of what
/// each call should have done. The invariants below are checked after every call.
contract Handler is Test {
    MoaVault public vault;
    MoaVaultFactory public factory;
    MockERC20 public usdt;
    MockERC20 public weth;
    MockPool public pool;
    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xA6E7);
    address constant GUARD = address(0x6A2D);
    address constant TREASURY = address(0x7EA5);
    address constant STRANGER = address(0xBAD);
    int24 constant TICK = -196_250;
    address[2] creators = [address(0xC2EA), address(0xC2EB)];
    bytes32[3] ids = [bytes32(0), keccak256("a"), keccak256("b")];

    // the running account
    uint256 public expectedVaultUsdt;
    mapping(bytes32 => uint256) public expectedBudget;
    uint256 public feeOverApproved; // creator paid more than approved, or more than 1%
    uint256 public platformOverCap; // treasury paid more than the set rate, or more than 0.2%
    uint256 public overLimits; // a buy the limits, session or budget should have refused went through
    uint256 public strangerWins; // an owner-only or guardian-only call that worked for someone else
    uint256 public buys;
    uint256 public sells;

    constructor(MoaVault v, MoaVaultFactory f, MockERC20 u, MockERC20 w, MockPool p) {
        vault = v;
        factory = f;
        usdt = u;
        weth = w;
        pool = p;
        expectedVaultUsdt = u.balanceOf(address(v));
    }

    function _creatorRate(bytes32 id, uint16 ask) internal view returns (address c, uint16 rate) {
        uint16 approved;
        (c, approved) = vault.creatorOf(id);
        rate = c == address(0) ? 0 : (ask < approved ? ask : approved);
    }

    function buy(uint256 amount, uint8 which, uint16 ask) external {
        bytes32 id = ids[which % 3];
        amount = bound(amount, 1e6, 120e6);
        ask = uint16(bound(ask, 0, 150));
        (address c, uint16 rate) = _creatorRate(id, ask);
        uint16 pRate = factory.platformFeeBps();
        uint256 cFee = (amount * rate) / 10_000;
        uint256 pFee = (amount * pRate) / 10_000;
        uint256 minOut = vault.minOutFloor(address(weth), true, amount - cFee - pFee);
        uint256 c0 = c == address(0) ? 0 : usdt.balanceOf(c);
        uint256 t0 = usdt.balanceOf(TREASURY);
        uint256 spentBefore = vault.spentOnDay(block.timestamp / 1 days);
        bool inLimits = amount <= vault.maxTradeUsdt() && amount <= vault.sessionMaxTradeUsdt() && spentBefore + amount <= vault.maxDailyUsdt()
            && (!vault.budgetsOn() || amount <= vault.budgetLeft(id)) && block.timestamp <= vault.agentUntil();
        vm.prank(AGENT);
        try vault.tradeFor(address(weth), true, amount, minOut, "fuzz", id, ask) {
            buys++;
            if (!inLimits) overLimits++;
            expectedVaultUsdt -= amount;
            if (vault.budgetsOn()) expectedBudget[id] -= amount;
            uint256 cPaid = c == address(0) ? 0 : usdt.balanceOf(c) - c0;
            if (cPaid != cFee || cPaid * 100 > amount) feeOverApproved++;
            uint256 tPaid = usdt.balanceOf(TREASURY) - t0;
            if (tPaid != pFee || tPaid * 500 > amount) platformOverCap++;
        } catch {}
    }

    function sell(uint256 pct, uint8 which, uint16 ask) external {
        uint256 held = weth.balanceOf(address(vault));
        if (held < 1e12) return;
        uint256 amount = (held * bound(pct, 1, 100)) / 100;
        bytes32 id = ids[which % 3];
        ask = uint16(bound(ask, 0, 150));
        (address c, uint16 rate) = _creatorRate(id, ask);
        uint16 pRate = factory.platformFeeBps();
        uint256 minOut = vault.minOutFloor(address(weth), false, amount);
        uint256 c0 = c == address(0) ? 0 : usdt.balanceOf(c);
        uint256 t0 = usdt.balanceOf(TREASURY);
        uint256 v0 = usdt.balanceOf(address(vault));
        vm.prank(AGENT);
        try vault.tradeFor(address(weth), false, amount, minOut, "fuzz", id, ask) {
            sells++;
            uint256 got = usdt.balanceOf(address(vault)) - v0;
            uint256 cPaid = c == address(0) ? 0 : usdt.balanceOf(c) - c0;
            uint256 tPaid = usdt.balanceOf(TREASURY) - t0;
            uint256 gross = got + cPaid + tPaid;
            if (cPaid != (gross * rate) / 10_000) feeOverApproved++;
            if (tPaid != (gross * pRate) / 10_000) platformOverCap++;
            expectedVaultUsdt += got;
        } catch {}
    }

    function setLimits(uint256 perTrade, uint256 perDay) external {
        perTrade = bound(perTrade, 1e6, 80e6);
        perDay = bound(perDay, perTrade, 200e6);
        vm.prank(OWNER);
        vault.setLimits(perTrade, perDay, 150);
    }

    function setSession(uint256 days_, uint256 cap) external {
        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);
        vm.prank(OWNER);
        vault.setSession(AGENT, uint64(block.timestamp + bound(days_, 1, 60) * 1 days), bound(cap, 1e6, 100e6), tokens);
    }

    function setBudget(uint8 which, uint256 amount, bool on) external {
        bytes32 id = ids[which % 3];
        amount = bound(amount, 0, 150e6);
        vm.startPrank(OWNER);
        vault.setBudget(id, amount);
        vault.setBudgetsOn(on);
        vm.stopPrank();
        expectedBudget[id] = amount;
    }

    function setCreator(uint8 which, uint8 who, uint16 bps) external {
        vm.prank(OWNER);
        vault.setCreatorFee(ids[1 + (which % 2)], creators[who % 2], uint16(bound(bps, 0, 100)));
    }

    function setPlatformFee(uint16 bps) external {
        vm.prank(GUARD);
        factory.setPlatformFee(uint16(bound(bps, 0, 20)), TREASURY);
    }

    function movePrice(int24 gap, bool settle) external {
        int24 g = int24(bound(int256(gap), -400, 400));
        if (settle) pool.setTicks(TICK, TICK);
        else pool.setTicks(TICK + g, TICK);
    }

    function wait(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 3 days));
    }

    function withdraw(uint256 amount) external {
        amount = bound(amount, 0, usdt.balanceOf(address(vault)) / 20);
        vm.prank(OWNER);
        vault.withdraw(address(usdt), amount);
        expectedVaultUsdt -= amount;
    }

    /// A stranger, a creator or the agent key tries an owner-only or guardian-only call; none may work.
    function attack(uint8 which, uint8 who) external {
        address[3] memory them = [STRANGER, AGENT, creators[0]];
        address a = them[who % 3];
        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);
        bytes memory call;
        address target = address(vault);
        uint8 w = which % 8;
        if (w == 0) call = abi.encodeCall(MoaVault.setLimits, (type(uint256).max, type(uint256).max, 1000));
        else if (w == 1) call = abi.encodeCall(MoaVault.withdraw, (address(usdt), 1));
        else if (w == 2) call = abi.encodeCall(MoaVault.setSession, (a, uint64(block.timestamp + 300 days), type(uint256).max, tokens));
        else if (w == 3) call = abi.encodeCall(MoaVault.setCreatorFee, (ids[1], a, 100));
        else if (w == 4) call = abi.encodeCall(MoaVault.setBudget, (ids[0], type(uint256).max));
        else if (w == 5) call = abi.encodeCall(MoaVault.setAgent, (a));
        else if (w == 6) { target = address(factory); call = abi.encodeCall(MoaVaultFactory.setPlatformFee, (20, a)); }
        else { target = address(factory); call = abi.encodeCall(MoaVaultFactory.setHalted, (true)); }
        vm.prank(a);
        (bool ok,) = target.call(call);
        if (ok) strangerWins++;
    }
}

contract MoaVaultInvariants is Base {
    Handler handler;

    function setUp() public {
        _deploy();
        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);
        handler = new Handler(vault, factory, usdt, weth, pool);
        targetContract(address(handler));
    }

    /// Every USDT the vault holds is accounted for: deposits, buys, sells and the owner's withdrawals, nothing else.
    function invariant_vaultUsdtIsAccountedFor() public view {
        assertEq(usdt.balanceOf(address(vault)), handler.expectedVaultUsdt());
    }

    /// The agent key and strangers never end up holding anything, and never manage an owner-only call.
    function invariant_agentAndStrangersGetNothing() public view {
        assertEq(usdt.balanceOf(AGENT) + weth.balanceOf(AGENT), 0);
        assertEq(usdt.balanceOf(STRANGER) + weth.balanceOf(STRANGER), 0);
        assertEq(handler.strangerWins(), 0);
    }

    /// A creator is paid exactly min(asked, approved) and never above 1%; the treasury exactly the rate, never above 0.2%.
    function invariant_feesAreExactAndCapped() public view {
        assertEq(handler.feeOverApproved(), 0);
        assertEq(handler.platformOverCap(), 0);
        assertLe(factory.platformFeeBps(), 20);
    }

    /// No buy outside the per-trade, daily, session or budget limits ever went through.
    function invariant_limitsHold() public view {
        assertEq(handler.overLimits(), 0);
    }

    /// Budgets on-chain equal what the owner gave minus what was spent, agent by agent.
    function invariant_budgetsAddUp() public view {
        assertEq(vault.budgetLeft(bytes32(0)), handler.expectedBudget(bytes32(0)));
        assertEq(vault.budgetLeft(keccak256("a")), handler.expectedBudget(keccak256("a")));
        assertEq(vault.budgetLeft(keccak256("b")), handler.expectedBudget(keccak256("b")));
    }
}
