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

- HSK in the deploying wallet: the dry run prints the estimate (about 1 HSK for version 2 at the gas price seen on 26 Nov 2026; the version-3 dry run on 27 Nov 2026 estimated 3.9M gas, about 1.95 HSK).
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

## Version 3 hardening (not deployed)

Nothing in this section has been sent to mainnet. Version 3 of the vault and factory is compiled and checked on a
local fork of mainnet only. Vaults cannot be upgraded: the two version-2 vaults above keep working exactly as they
are (no creator fee, no budgets, the spot price floor) until their owners move to a new vault.

What version 3 changes, against what the panel of judges found:

| | Version 2 (on mainnet) | Version 3 |
| --- | --- | --- |
| Price floor of `trade` | `minOut` within `maxSlippageBps` of the pool price **now** (`slot0`), so a key that moves the pool first could sandwich its own vault | within `maxSlippageBps` of the pool's **10-minute time-weighted average** (the same `observe()` average the stop-loss uses; Uniswap's `getSqrtRatioAtTick` in `_sqrtAtTick`). A pool price already worse than that floor is refused as `PriceMoving` before anything is swapped. Views: `quoteTwap`, `minOutFloor`. In a fast fall the agent's own sell now waits until the price has held, like the stop-loss; the owner can always withdraw |
| Starting limits | the factory started vaults with **no limit** and the stop-loss off | the factory refuses to deploy with no limit or no stop-loss: per trade above 0, per day at most 10,000 USDT, a stop-loss of 1–50%, slippage up to 3%. The scripts default to **$50 per trade, $100 per day, a 15% stop-loss, 1.5% slippage**. Each owner changes or removes them in the account menu (`setLimits`, `setStopLoss(0)`) |
| Per-agent budgets | only in the server (`autoRunner`) | `setBudget(agentId, usdt)` and `setBudgetsOn(bool)`, owner only. With budgets on, every buy names an agent (`tradeFor(…, agentId, feeBps)`; `trade` is agent 0) and is refused over what is left of that agent's budget (`OverBudget`). Sells need no budget. `agentId` = keccak256 of the hired agent's id in the app. Off by default, so nothing changes until the owner turns it on; the hire sheet then sets each new agent's budget in the same wallet confirmations |
| Shared hot agent key | each owner can replace the agent (`setAgent`) or pause; no global switch | the same per vault (now also refusing the owner as agent), plus a **guardian** fixed in the factory at deployment: `setHalted(true)` stops agent trading on every vault at once (`Halted`). It cannot move funds, change limits or block withdrawals, deposits or the stop-loss. The deploy script makes the deploying wallet the guardian unless `--guardian 0x…` names another; keep that key off the server |
| Creator fee | (none) | approved per hired agent, not per creator: `setCreatorFee(agentId, creator, bps)`, at most 1%. `tradeFor` cannot name a creator at all; the vault pays the creator the owner approved for that agent. The agent key can only choose which agent a trade is for, so with budgets on, a creator can be credited with no more than that agent's own budget |
| Reentrancy | swaps and stop-outs updated the books after the swap | books before the swap, and `trade`, `tradeFor`, `stopOut` and `withdraw` refuse to be entered twice |

Static analysis: Slither 0.11.6 (`audit/slither.txt`), 23 findings, none rated high. Slither rates some of them
medium; each was reviewed and kept for the reason given: `divide-before-multiply` in `_quoteAt` (intended: it keeps the intermediate under 2^256; the loss is under one
unit of the output token at the pools' prices) and in `_sqrtAtTick` (Uniswap's own code), `incorrect-equality` on
`== 0` checks, `unused-return` of `slot0`/`observe` fields, `calls-loop` in the constructor's market list,
`reentrancy-events` (events after the router call, which is a fixed, allow-listed contract), `missing-zero-check` on
the guardian (zero means no guardian, by design), complexity and long literals in `_sqrtAtTick`.

Tests on a fork of mainnet (each starts its own Hardhat node):

- `scripts/fork-test.mjs`, 55 checks: everything above for version 2, plus: a factory with unsafe starting values
  cannot be deployed; a new vault starts with the safe limits and a 15% stop-loss; the owner can turn it off; right
  after the price is pushed down, the agent's sell is refused (`PriceMoving`), and so is a key asking for a floor from
  the pushed price (`SlippageTooLoose`); ten minutes later the same sell goes through; only the guardian can halt;
  halted, no trade goes through, the status reports it and the owner still withdraws; after the halt is lifted trading
  works; after the owner replaces the agent key the old key is refused and cannot put itself back.
- `scripts/fee-fork-test.mjs`, 40 checks: creator fees per agent (who may approve, the 1% cap, exact amounts on buys
  and sells, nothing to an unapproved creator, the server asking no fee when the approved creator is someone else,
  a withdrawn approval), budgets (a stranger cannot set them; a buy over an agent's budget is refused; the agent key
  cannot credit another agent's $20 to a creator past that agent's budget; a buy for no agent is refused with budgets
  on; selling needs no budget), limits and stop-loss with fees, old vaults sent only `trade`, fees read back from events.
- `scripts/fuzz-fork-test.mjs`, randomized: 400 random steps (owner limits, budgets, creator approvals, agent buys and
  sells for random agents asking random fees, strangers calling owner functions, jumps in time), each checked against
  a model of what the vault must allow and an exact account of every unit of USDT; invariants I1–I8 are at the top of
  the file. `FUZZ_SEED` and `FUZZ_RUNS` repeat or lengthen a run. On 27 Nov 2026: seed 1, 400 steps, 1,207 checks;
  seed 7, 300 steps, 1,160 checks; none failed.

### Owner steps, when you decide to deploy (from `hsk-agent/contracts`)

1. Compile and run the three fork tests:

   ```bash
   node scripts/compile.cjs
   node --experimental-strip-types scripts/fork-test.mjs
   node --experimental-strip-types scripts/fee-fork-test.mjs
   FUZZ_RUNS=400 node --experimental-strip-types scripts/fuzz-fork-test.mjs
   ```

2. Choose the guardian: a wallet you control that is **not** the agent wallet and not on the server (a hardware
   wallet is best). Copy `deployments/hsk-mainnet.json` to `deployments/hsk-mainnet-v2.json`, then dry-run:

   ```bash
   node scripts/deploy-mainnet.mjs --from 0xYOUR_WALLET --guardian 0xGUARDIAN
   ```

   It prints the starting values ($50 per trade, $100 per day, 1.5%, 15% stop-loss unless you pass `--max-trade`,
   `--max-daily`, `--slippage-bps`, `--stop-loss-bps`) and the gas. Then `--send` as in **Steps** 3, and
   `node scripts/verify.mjs` as in **Steps** 4.

3. Point the server at it and keep the version-2 factory, so the two wallets that have a vault there keep it:

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

6. Owners who want on-chain per-agent budgets: `node scripts/vault.mjs budgets on` (the app's hire sheet then sets
   each agent's budget), or per agent `node scripts/vault.mjs budget <hired agent id> 100`. Creator fees without the
   app: `node scripts/vault.mjs creator <hired agent id> 0xCREATOR 0.5`.

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
