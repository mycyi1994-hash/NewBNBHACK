# Putting Moa's vaults on HSK Chain mainnet

Moa gives every user their own vault. One contract, the **MoaVaultFactory**, is deployed once; after that the app
makes a **MoaVault** for each wallet that logs in. Everything below is run on your own computer, from
`hsk-agent/contracts`. The contracts are unaudited. Start with small amounts.

**Deployed 26 Nov 2026 (first version of the vault, superseded):** factory [`0x49807417fcebfb90e59933f0c44e4f1edf96444c`](https://hsk.blockscout.com/address/0x49807417fcebfb90e59933f0c44e4f1edf96444c)
([transaction](https://hsk.blockscout.com/tx/0xedb6a15b62c220ccd46df7927685de73fa516e1fb76ad1c220a5c4c4e37f6ebf)).
Read back from the chain afterwards: the agent, USDT, router, the three markets and the limits ($10 per trade,
$30 per day, 1.5%) are as planned. The only trade ever sent on mainnet went through a vault of this version:
$1 of WBTC asked for in the chat ([transaction](https://hsk.blockscout.com/tx/0x955cd89b5e89200d606300df1afeca3c3adb337c200e6743af7b64595c2441ee)).
That vault now holds nothing.

That factory starts every vault at $10 per trade and $30 per day. The version-2 factory below starts vaults with
**no limits** (the scripts' default on that day); version 3 refuses that again and starts every vault with $50 per
trade, $100 per day and a 15% stop-loss (see **Version 3 hardening**). In every version the app's account menu has
**Limits** (per trade, per day, worst price accepted, each with "no limit") and **Lock trading** for the owner.

**Current factory (version 2 of the vault), deployed 26 Nov 2026, source published:**
[`0xd6bF84aF1a81EB88EF2fD0c5B254b955E8256546`](https://hsk.blockscout.com/address/0xd6bF84aF1a81EB88EF2fD0c5B254b955E8256546).
Read back from the chain: the agent, USDT, router and the three markets as planned; vaults start with no spending
limit, a 1.5% slippage ceiling and the stop-loss off. As of 27 Nov 2026 it has made **two** vaults (`vaultCount()` =
2): [`0x6A35…b33C`](https://hsk.blockscout.com/address/0x6A355aE335f06971C337c900783C2e016410b33C) for `0x9E5f…214c`
at block 30,678,402, holding 9 USDT its owner deposited, and
[`0x6505…d309`](https://hsk.blockscout.com/address/0x65058a0122FF56F7962cF7e52396b51F9153d309) for `0x2544…710D` at
block 30,718,340, empty. No trade and no stop-loss has happened on either. The agent wallet has sent four
transactions in all: three vault creations (one on the first factory) and the $1 trade above. The vault instances'
source is not verified on Blockscout yet (`node scripts/verify.mjs vault 0xOWNER` does it).

What version 2 changed:
- the spending limits apply to buys only, so selling back to USDT is never held up by them (in the first version a
  sell counted towards the day's limit and could be refused on a day the limit was used up);
- a stop-loss the owner sets in the account menu: once a holding is worth that much less than it cost, anyone may
  call `stopOut(token)` and the vault sells all of it for USDT, which stays in the vault. It checks that the pool
  price is within the slippage ceiling of its own 10-minute average, so a price pushed for one transaction can
  neither set it off nor make the sale cheap; in a fast fall that means it waits until the price has held. The
  agent's own sell is not delayed by this.
Vaults made by the first factory keep working as they are; funds in them can be withdrawn at any time.

## Who can do what

| | What it can do | Where its key lives |
| --- | --- | --- |
| **A user's wallet** (owner of that user's vault) | Deposit, withdraw, change the vault's limits, pause it, replace its agent. The only address that can take funds out of that vault. | The user's own wallet (MetaMask and the like). The app asks it to sign; the server never sees the key. |
| **Guardian** (version 3) | Halt and resume agent trading on every vault of its factory (`setHalted`). Nothing else: no funds, no limits, never withdrawals or the stop-loss. | A wallet you keep off the server, named at deployment (`--guardian`). |
| **Agent** (one key for all vaults) | Call `trade()` (and `tradeFor()` on version 3) only: USDT ↔ WHSK / WETH / WBTC on HSKSwap, inside each vault's per-trade cap, per-day cap and slippage floor. Cannot withdraw from any vault. Also pays the gas to make each user's vault. | `hsk-agent/.env.local` on the machine that runs the app (git-ignored). |
| **Deploying wallet** | Pays the gas for the factory, once. Gets no control: the factory has no owner and nothing in it can be changed. | Yours. Typed into a hidden prompt for the one deploy command; never stored, never printed. |

If the agent key leaks, the worst it can do is trade inside each vault's limits. A vault with no limits has no
such ceiling: the key could trade its whole balance back and forth and lose it to fees and bad prices, though it
still could not withdraw. Limits and the lock are the owner's protection against that. Each user stops it on their own
vault with pause or by replacing the agent; a new factory with a new agent key is the fix for everyone.

## What you need first

- HSK in the deploying wallet: the dry run prints the estimate (about 1 HSK for version 2 at the gas price seen on 26 Nov 2026; the version-3 dry run on 28 Nov 2026, with sessions and the platform-fee opt-in, estimated 4.77M gas, about 2.39 HSK).
- HSK in the agent wallet: making one user's vault costs it about 0.63 HSK (version 3: about 0.90 HSK) and each trade about 0.15 HSK at that
  gas price. The server makes at most `MOA_MAX_VAULTS_PER_DAY` vaults a day (default 20).
- USDT on HSK Chain in whichever wallet will log in and deposit: `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029`.

## Steps

```bash
npm install
```

```bash
node scripts/compile.cjs
```

1. **Make the agent key** (skip if `../.env.local` already has one). Writes it there and prints only its address.

   ```bash
   node scripts/agent-key.mjs
   ```

   Send that address HSK.

2. **Dry run.** Reads the chain, checks every address, shows the plan and the gas cost. Sends nothing.

   ```bash
   node scripts/deploy-mainnet.mjs --from 0xYOUR_WALLET_ADDRESS
   ```

   Every new vault starts with no per-trade or per-day limit and a 1.5% slippage ceiling. To start vaults with
   limits instead, add for example `--max-trade 10 --max-daily 30 --slippage-bps 150`. Either way each user sets
   their own vault's limits afterwards, in the app's account menu.

3. **Deploy.** Asks for the deploying wallet's key (hidden: nothing appears while you paste), shows the same plan,
   and waits for you to type `deploy`. One transaction. No funds move.

   ```bash
   node scripts/deploy-mainnet.mjs --send
   ```

   It writes `deployments/hsk-mainnet.json` (addresses, the transaction hash, verification settings; no keys) and
   prints the factory address. Add it to `../.env.local`:

   ```
   MOA_FACTORY_ADDRESS=0x...
   ```

4. **Publish the source on the explorer** (needs no key).

   ```bash
   node scripts/verify.mjs
   ```

   If the upload is refused, do it by hand on the contract's page at https://hsk.blockscout.com:
   Contract → Verify & publish → *Solidity (Standard JSON input)*, compiler `v0.8.26+commit.8a97fa7a`, licence MIT,
   file `out/standard-input.json`. The constructor arguments are in `deployments/hsk-mainnet.json`.

5. **Use it.** Restart the app (`npm run dev` in `hsk-agent`) and press **Log in** at the top right.
   - The wallet asks for one signature. It is free and sends no transaction.
   - Your vault is made for you (the agent wallet pays). The account menu shows its address and balance.
   - **Deposit** shows the vault's address and can send USDT from your wallet in one transaction.
   - Hire an agent for BTC, ETH or HSK and approve its first order, or tell Moa “execute a $5 ETH buy now”.
     The receipt links to the transaction on the explorer.
   - **Withdraw** sends any token in the vault back to your wallet.

6. After the first vault exists, publish its source too, then commit `deployments/hsk-mainnet.json` and put the
   factory address and the first trade's link in the README.

   ```bash
   node scripts/verify.mjs vault 0xYOUR_WALLET_ADDRESS
   ```

## Version 3 hardening (factory deployed 28 Nov 2026)

The version-3 factory is on mainnet: [`0x57669b1ff8e4c8ee9770b857eee35c6c3080eade`](https://hsk.blockscout.com/address/0x57669b1ff8e4c8ee9770b857eee35c6c3080eade)
([deployment](https://hsk.blockscout.com/tx/0xb1db645e719cf5697485411857cdc70a56619aaf2313605c0ffe33ef02bccd7e), block
30745942, 4,732,804 gas). Read back from the chain after the deployment: 20,762 bytes of code, the agent
`0x8C35…1bAE`, $50 per trade, $100 a day, 1.5% slippage, a 15% stop-loss, the deploying wallet `0x9E5f…214c` as
guardian, not halted, platform fee 0, the three markets. Vaults cannot be upgraded: the version-2 vaults keep
working exactly as they are (no creator fee, no budgets, the spot price floor) until their owners move to a new vault
(below). A second version-2 factory, `0xa3a50f5095d712ffc11ce959f88611614502c0f3`, was deployed the same day by
mistake from an old checkout (a `git pull` had failed); it has no vaults and is not used anywhere.

What version 3 changes, against what the panel of judges found:

| | Version 2 (on mainnet) | Version 3 |
| --- | --- | --- |
| Price floor of `trade` | `minOut` within `maxSlippageBps` of the pool price **now** (`slot0`), so a key that moves the pool first could sandwich its own vault | within `maxSlippageBps` of the pool's **10-minute time-weighted average** (the same `observe()` average the stop-loss uses; Uniswap's `getSqrtRatioAtTick` in `_sqrtAtTick`). A pool price already worse than that floor is refused as `PriceMoving` before anything is swapped. Views: `quoteTwap`, `minOutFloor`. In a fast fall the agent's own sell now waits until the price has held, like the stop-loss; the owner can always withdraw |
| Starting limits | the factory started vaults with **no limit** and the stop-loss off | the factory refuses to deploy with no limit or no stop-loss: per trade above 0, per day at most 10,000 USDT, a stop-loss of 1–50%, slippage up to 3%. The scripts default to **$50 per trade, $100 per day, a 15% stop-loss, 1.5% slippage**. Each owner changes or removes them in the account menu (`setLimits`, `setStopLoss(0)`) |
| Per-agent budgets | only in the server (`autoRunner`) | `setBudget(agentId, usdt)` and `setBudgetsOn(bool)`, owner only. With budgets on, every buy names an agent (`tradeFor(…, agentId, feeBps)`; `trade` is agent 0) and is refused over what is left of that agent's budget (`OverBudget`). Sells need no budget. `agentId` = keccak256 of the hired agent's id in the app. Off by default, so nothing changes until the owner turns it on; the hire sheet then sets each new agent's budget in the same wallet confirmations |
| Shared hot agent key | each owner can replace the agent (`setAgent`) or pause; no global switch | **a session per vault**: the owner authorises the agent key until a date (at most a year), on chosen coins, at most so much per buy (`setSession(agent, until, maxTradeUsdt, tokens)`), and ends it at once with `revokeSession()`. A new vault starts with a 30-day session on its starting coins at its starting per-trade limit; after that the key can do nothing on it (`SessionOver`, `NotInSession`, `TradeTooLarge`) until the owner renews, which the hire sheet asks for when a session is missing, ends within a week, lacks the coin or is below the buy. The server reads the session before sending, uses the key the owner authorised (`MOA_AGENT_EXTRA_KEYS` holds earlier keys during a rotation) and sends nothing a session does not cover. Plus a **guardian** fixed in the factory: `setHalted(true)` stops agent trading on every vault at once (`Halted`); it cannot move funds, change limits or block withdrawals, deposits or the stop-loss |
| Platform fee | (none) | a switch held by the guardian on the factory: `setPlatformFee(bps, treasury)`, **0 by default**, never above 20 bps (0.2%, checked again by every vault). **Each owner opts in**: a vault pays it only up to the rate its owner accepted with `acceptPlatformFee(bps)` (0 at the start, so the guardian can never charge an owner who did not accept); a later rise above that is not charged until the owner accepts again, a fall is charged at the lower rate, and accepting 0 withdraws. Paid in USDT like the creator fee, from the USDT going in on a buy or coming out on a sell, inside the limits and budgets. The trust page shows the factory's rate and the hire sheet the vault's own, each only when it is not 0. It stays 0; it exists so a business decision needs no new contract |
| Creator fee | (none) | approved per hired agent, not per creator: `setCreatorFee(agentId, creator, bps)`, at most 1%. `tradeFor` cannot name a creator at all; the vault pays the creator the owner approved for that agent. The agent key can only choose which agent a trade is for, so with budgets on, a creator can be credited with no more than that agent's own budget |
| Reentrancy | swaps and stop-outs updated the books after the swap | books before the swap, and `trade`, `tradeFor`, `stopOut` and `withdraw` refuse to be entered twice |

Static analysis: Slither 0.11.6 (`audit/slither.txt`), 31 findings: none rated high; 12 rated medium, from three
detectors, each reviewed and kept: `divide-before-multiply` (3: `_quoteAt` keeps its intermediate under 2^256, losing
under one unit of the output token at the pools' prices; `_sqrtAtTick` is Uniswap's own code), `incorrect-equality` (3:
`== 0` checks on amounts and holdings) and `unused-return` (6: the unused fields of `slot0` and `observe`). The low and
informational ones: `reentrancy-events` (events after the call to the fixed, allow-listed router), `timestamp` (the
session and the day's limit are about time by design), `calls-loop` (the constructor's market list),
`missing-zero-check` on the guardian (zero means no guardian), complexity and long literals in `_sqrtAtTick`.

Solidity tests with Foundry (`forge` 1.5.1; `sh scripts/foundry-setup.sh` fetches forge-std, then `forge test`):
`test/MoaVault.t.sol` has 15 unit tests (every refusal, the platform fee only up to what the owner accepted: agent, owner-only calls, limits, the average-price floor,
session scope, end and revocation, creator and platform fees to the unit, fee caps, budgets, halt, stop-loss, pause,
markets, books on withdrawal) and 5 invariants over 256 runs × 80 random calls by the owner, the agent key, the
guardian and strangers against mock pool and router (`test/Mocks.sol`): every USDT in the vault accounted for; the
agent key and strangers end with nothing and never pass an owner-only or guardian-only call; creator and platform fees
exact and capped; no buy outside the limits, session or budget; budgets add up per agent. Two deliberate bugs (paying
the approved creator rate instead of the asked one; a budget off by one unit) were each caught. Coverage
(`forge coverage --ir-minimum`, `audit/coverage.txt`): MoaVault 99.1% of lines, 66.2% of branches; factory 94.7% of lines.

Tests on a fork of mainnet (each starts its own Hardhat node):

- `scripts/fork-test.mjs`, 69 checks: everything above for version 2, plus: a factory with unsafe starting values
  cannot be deployed; a new vault starts with the safe limits and a 15% stop-loss; the owner can turn it off; right
  after the price is pushed down, the agent's sell is refused (`PriceMoving`), and so is a key asking for a floor from
  the pushed price (`SlippageTooLoose`); ten minutes later the same sell goes through; only the guardian can halt;
  halted, no trade goes through, the status reports it and the owner still withdraws; after the halt is lifted trading
  works; after the owner replaces the agent key the old key is refused and cannot put itself back. Sessions: a new
  vault starts with 30 days on all three coins at $50 a buy; only the owner sets one (not the agent key, not a
  stranger); over a year, already over or for the owner's own key is refused; a coin outside the session is refused by
  the server and by the vault; a buy over the session's cap is refused though the vault has no limit; after the end and
  after `revokeSession` nothing is sent; a session for another key the server holds is traded with that key, and a
  server without it sends nothing; the stop-loss never depends on the session.
- `scripts/fee-fork-test.mjs`, 51 checks: creator fees per agent (who may approve, the 1% cap, exact amounts on buys
  and sells, nothing to an unapproved creator, the server asking no fee when the approved creator is someone else,
  a withdrawn approval), budgets (a stranger cannot set them; a buy over an agent's budget is refused; the agent key
  cannot credit another agent's $20 to a creator past that agent's budget; a buy for no agent is refused with budgets
  on; selling needs no budget), limits and stop-loss with fees, old vaults sent only `trade`, fees read back from events,
  and the platform fee (0 at first; only the guardian sets it; never above 0.2% or without a treasury; at 0.2% a $10
  buy pays exactly $0.02 to the treasury and $0.05 to the creator while the vault spends exactly $10 and the day counts
  $10; a sell pays floor(0.2%) and floor(0.5%) of what came out; back at 0 nothing is paid).
- `scripts/upgrade-fork-test.mjs`, 53 checks: the move from a version-2 vault to a version-3 vault, walked with the
  app's own code (the server's API over HTTP, the browser's functions signing through a stand-in wallet): the move is
  offered; the new vault is made by the agent key with no signature; the old vault stays reported with its balances;
  withdrawals and the deposit; an agent trade from the new vault inside its session; the hire sheet's session renewal
  after the session has ended; a second call changes nothing; wallets with no version-2 vault are unaffected; the daily
  cap; the agents on auto paused with the reason; creator fees only on a server whose factory makes version 3; and how
  a version-3 vault treats a coin sent in by plain transfer (below).
- `scripts/fuzz-fork-test.mjs`, randomized: 400 random steps (owner limits, budgets, creator approvals, agent buys and
  sells for random agents asking random fees, strangers calling owner functions, jumps in time), each checked against
  a model of what the vault must allow and an exact account of every unit of USDT; invariants I1–I8 are at the top of
  the file. `FUZZ_SEED` and `FUZZ_RUNS` repeat or lengthen a run. Buys are steered to where they can go through four
  times in five, and the run fails unless at least 30% of all steps are buys the vault carried out. On 27 Nov 2026,
  against version 3 with sessions and the platform fee: seed 1, 400 steps, 2,009 checks, 148 buys carried out (37%);
  seed 7, 300 steps, 1,420 checks, 99 buys (33%); none failed.

### Owner steps to deploy (from `hsk-agent/contracts`; done on 28 Nov 2026, kept for the next deployment)

First check the checkout is current: `node scripts/compile.cjs` must print a deployed size of 15650 bytes for MoaVault
and 20762 for MoaVaultFactory, and the dry run must show the starting limits and the guardian line.

1. Compile and run the three fork tests:

   ```bash
   node scripts/compile.cjs
   node --experimental-strip-types scripts/fork-test.mjs
   node --experimental-strip-types scripts/fee-fork-test.mjs
   FUZZ_RUNS=400 node --experimental-strip-types scripts/fuzz-fork-test.mjs
   ```

1b. Run the Solidity tests: `sh scripts/foundry-setup.sh && forge test` (Foundry from https://getfoundry.sh).

2. Choose the guardian: a wallet you control that is **not** the agent wallet and not on the server (a hardware
   wallet is best). Copy `deployments/hsk-mainnet.json` to `deployments/hsk-mainnet-v2.json`, then dry-run:

   ```bash
   node scripts/deploy-mainnet.mjs --from 0xYOUR_WALLET --guardian 0xGUARDIAN
   ```

   It prints the starting values ($50 per trade, $100 per day, 1.5%, 15% stop-loss unless you pass `--max-trade`,
   `--max-daily`, `--slippage-bps`, `--stop-loss-bps`) and the gas. Then `--send` as in **Steps** 3, and
   `node scripts/verify.mjs` as in **Steps** 4.

3. Point the server at it and keep the version-2 factory, so the two wallets that have a vault there keep it until
   they move (see **Moving an existing wallet to a new vault**):

   ```
   MOA_FACTORY_ADDRESS=0x…new factory…
   MOA_LEGACY_FACTORY_ADDRESSES=0xd6bF84aF1a81EB88EF2fD0c5B254b955E8256546
   MOA_FEES_FROM_BLOCK=…the block of the deployment transaction…   # optional
   ```

   Do not list the first factory (`0x4980…444c`): its vaults have no stop-loss and this server cannot read them; they
   stay reachable with `node scripts/vault.mjs status 0x… --factory 0x4980…` to withdraw.

4. Restart the app. `/api/health` should say `"factory": "ok"` and `"vaults": "on"`. Log in with a fresh wallet: its
   vault shows $50 / $100 and a 15% stop-loss in the account menu. Run the mainnet checklist (deposit 5–10 USDT,
   hire an agent, approve its first buy, a Moa chat order confirmed with its button, withdraw).

5. If the agent key may have leaked: from the guardian wallet call `setHalted(true)` on the factory (Blockscout's
   *Write contract* tab works); every vault's agent trading stops, funds stay where they are. Then make a new agent
   key, deploy a new factory with it, and lift the halt only if the old key is safe. One owner alone can do the same
   for their own vault: `node scripts/vault.mjs pause` or `node scripts/vault.mjs agent 0xNEW`.

6. Sessions: a new vault's agent may trade for 30 days; renewing is one confirmation in the hire sheet, or
   `node scripts/vault.mjs session 0xAGENT 90 50` (90 days, $50 a buy, all three coins), and `node scripts/vault.mjs
   revoke` ends it. To rotate the agent key without stopping anyone: put the new key in `MOA_AGENT_PRIVATE_KEY` and
   the old one in `MOA_AGENT_EXTRA_KEYS`; vaults move to the new key as their owners renew, and the old key is
   dropped when no session names it. Not done (the remaining gap): a key per vault held apart from the server (each
   would need its own gas), and owners granting sessions by EIP-712 signature instead of a transaction.

7. The platform fee stays 0. To change it, the guardian calls `setPlatformFee(bps, treasury)` on the factory
   (Blockscout's *Write contract* tab), at most 20 bps; the trust page then shows it. No vault pays it until its
   owner accepts, `node scripts/vault.mjs platform-fee 0.2` (and `… 0` to withdraw); a vault never pays more than its
   owner accepted, whatever the guardian sets. Checked in `test/MoaVault.t.sol` (`test_platformFeeOnlyWhatTheOwnerAccepted`
   and the fee invariant, both of which fail if the vault ignores the acceptance) and in `scripts/fee-fork-test.mjs`.

8. Owners who want on-chain per-agent budgets: `node scripts/vault.mjs budgets on` (the app's hire sheet then sets
   each agent's budget), or per agent `node scripts/vault.mjs budget <hired agent id> 100`. Creator fees without the
   app: `node scripts/vault.mjs creator <hired agent id> 0xCREATOR 0.5`.

## Moving an existing wallet to a new vault

Vaults cannot be upgraded, so a wallet that has a version-2 vault moves to a version-3 vault of its own. Nothing in
this section has happened on mainnet; it is rehearsed on a fork (`scripts/upgrade-fork-test.mjs`) and in a browser
against a fork.

Once the server points at the version-3 factory with the version-2 factory listed in
`MOA_LEGACY_FACTORY_ADDRESSES`, a wallet with a version-2 vault keeps it as its active vault, and the app shows one
card, **Move to a new vault**, in the vault card on *My agents* and in the account menu. Three steps:

1. **Make the new vault.** One button. Moa's agent key pays (`POST /api/vault/upgrade`, inside the same daily cap as
   new vaults); the wallet signs nothing. The new vault is the active one from then on.
2. **Take everything out of the old vault.** The owner's wallet confirms one `withdraw(token, amount)` per token the
   old vault holds: one confirmation when it holds only USDT.
3. **Put it into the new vault.** The owner's wallet confirms one USDT transfer to the new vault.

**Wallet confirmations: two in the usual case** (a vault that holds only USDT: one withdrawal, one deposit), plus one
for each coin the old vault also holds. None for a vault that is empty.

- The step that is waiting is read from the chain each time (`GET /api/vault`: the old vault's balances, the new
  vault's, the wallet's), not from anything the browser remembers. Closing the tab after step 2 comes back to step 3.
  Step 3 can be put off ("Not now"); that, and a finished step 3, is the one thing the browser keeps, so the deposit
  is not offered again to someone who later withdraws everything.
- The old vault is never hidden while it holds anything: `/api/vault` reports it (`old`: address, version, USDT, WHSK,
  WETH, WBTC) and the app keeps a line, "$X is still in your old vault · Take it out", after the move too. It stays
  the owner's; `node scripts/vault.mjs withdraw … --factory 0xd6bF…` works as before.
- **Only USDT goes into the new vault.** A coin sent into a version-3 vault by plain transfer has no cost on the
  vault's books (`costUsdt` stays 0): `stopOut` refuses it (`NothingToSell`), so the stop-loss never covers it, and it
  dilutes the stop-loss of whatever the agent later buys of the same coin (on the fork: $20 sent in plus a $20 buy
  needed a 57% fall, not 15%, before the stop applied). The stop compares what the whole holding is worth with what
  the vault paid, so the vault still sells once the holding is worth 15% less than its cost: a coin someone sends in
  is extra cushion, and the owner ends with no less USDT at the stop than without it. The agent key can sell such a
  coin and the owner can always withdraw it. So the card asks the owner to sell coins to USDT first (while the old vault is still the active one:
  "sell all BTC" in the chat); a coin left in the old vault at step 2 goes to the owner's wallet and stays there.
- The new vault starts with $50 per trade, $100 a day, a 15% stop-loss and a 30-day agent session, whatever the old
  vault's settings were; the card says so. The hire sheet renews the session (one confirmation, 90 days).
- The wallet's agents on auto are paused when the new vault is made (it starts empty) and say why in the runner
  status; the owner resumes each one once the money is in. Their books still describe what they bought on the old
  vault: an agent that held a coin there should be let go and hired again.
- A wallet with no version-2 vault is not affected: it gets a version-3 vault at its first login, as before.
- Creator fees on new shares are offered only by a server whose current factory makes version-3 vaults
  (`creatorFees` in `/api/terms` and `/api/vault`); such a server refuses a share that asks a fee otherwise.

## The same controls without the app

Each asks for the vault owner's key (hidden) and for a typed word before sending.

```bash
node scripts/vault.mjs status 0xOWNER_ADDRESS
```

```bash
node scripts/vault.mjs fund 20
```

```bash
node scripts/vault.mjs withdraw USDT all
```

```bash
node scripts/vault.mjs pause
```

```bash
node scripts/vault.mjs limits 10 30 150
```

```bash
node scripts/vault.mjs agent 0xNEW_AGENT_ADDRESS
```

`withdraw` also takes `WHSK`, `WETH`, `WBTC`, and an amount instead of `all`. `unpause` undoes `pause`.
`limits` takes `none` for either amount: `limits none none 150` removes both.
`create` makes your vault if you have not logged in to the app.

## What was checked, and what was not

Checked on 26 Nov 2026:

- Token addresses (USDT, WHSK, WETH, WBTC) match the chain's official *Token Contracts* documentation page.
- Read from mainnet: chain id 177; the router has a factory; each pool holds its token and USDT, charges 0.3%, has
  liquidity, and comes from that same factory. The deploy script repeats these checks every time and stops on any mismatch.
- The explorer accepts compiler `v0.8.26+commit.8a97fa7a`, EVM version `cancun` and standard-JSON-input verification.
- On a local fork of mainnet, with Hardhat's public test keys:
  - `scripts/fork-test.mjs`, 42 checks: the server makes a vault for a wallet that signs nothing; it starts with the
    three markets listed; asking twice gives the same vault; a second user gets a different vault and cannot withdraw
    from the first; the daily cap on vault creation; an order on an empty vault is refused; every trading guard
    (per-trade cap, daily cap, slippage floor, owner-only withdrawal, pause); and the owner's own limits (the agent
    cannot change them; with none a larger order fills; new ones are reported and enforced; a tighter price floor
    still fills). For the second version of the vault: a sell goes through on a day whose spending limit is used
    up; the cost of each holding is tracked through buys, sells and withdrawals; the stop-loss does not fire at a
    small loss, is refused right after the price is pushed down (the price is away from its 10-minute average),
    and once the price has held a stranger carries it out, the USDT stays in the vault and the stranger gets nothing;
    it works while the vault is paused; the agent cannot change it.
  - The deploy script (dry run, a refused confirmation, the hidden key prompt: the key does not appear in the
    terminal output) and the `vault.mjs` commands.
  - In a browser against the fork: log in, vault made, deposit 20 USDT, an order with the session (filled), the same
    order without a session and with an altered session (both refused with HTTP 401), withdraw, rename, log out,
    and a browser with no wallet. Also: the deposit QR code reads back as the vault's address; setting limits,
    an order above them refused and one inside them filled; lock and unlock; removing the limits again; choosing
    among several wallets.

Not checked:

- The HSKSwap router address is not on the official documentation page that lists the tokens; it was confirmed only
  by its on-chain relation to the pools.
- `scripts/verify.mjs` published the version-2 factory's source; the two vault instances are not verified yet.
- A real wallet extension (MetaMask): the browser run used a stand-in that signs with a fork test account.
- Wallets that are contracts (multisigs, smart accounts) cannot log in yet: the login checks an ordinary signature.
- On mainnet: two version-2 vaults exist (above); no trade, stop-loss or creator fee has happened on version 2,
  and nothing of version 3 is deployed. The one mainnet trade is the $1 chat order on a first-version vault.
