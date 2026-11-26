# Putting Moa's vaults on HSK Chain mainnet

Moa gives every user their own vault. One contract, the **MoaVaultFactory**, is deployed once; after that the app
makes a **MoaVault** for each wallet that logs in. Everything below is run on your own computer, from
`hsk-agent/contracts`. Nothing here has been run against mainnet yet: the scripts and the app flow were exercised
on a local fork of mainnet only. The contracts are unaudited. Start with small amounts.

## Who can do what

| | What it can do | Where its key lives |
| --- | --- | --- |
| **A user's wallet** (owner of that user's vault) | Deposit, withdraw, change the vault's limits, pause it, replace its agent. The only address that can take funds out of that vault. | The user's own wallet (MetaMask and the like). The app asks it to sign; the server never sees the key. |
| **Agent** (one key for all vaults) | Call `trade()` only: USDT ↔ WHSK / WETH / WBTC on HSKSwap, inside each vault's per-trade cap, per-day cap and slippage floor. Cannot withdraw from any vault. Also pays the gas to make each user's vault. | `hsk-agent/.env.local` on the machine that runs the app (git-ignored). |
| **Deploying wallet** | Pays the gas for the factory, once. Gets no control: the factory has no owner and nothing in it can be changed. | Yours. Typed into a hidden prompt for the one deploy command; never stored, never printed. |

If the agent key leaks, the worst it can do is trade inside each vault's limits. Each user stops it on their own
vault with pause or by replacing the agent; a new factory with a new agent key is the fix for everyone.

## What you need first

- HSK in the deploying wallet: the dry run prints the estimate (about 1 HSK at the gas price seen on 26 Nov 2026).
- HSK in the agent wallet: making one user's vault costs it about 0.63 HSK and each trade about 0.15 HSK at that
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

   Every new vault starts with $10 per trade, $30 per day and a 1.5% slippage ceiling. To change that add
   `--max-trade 10 --max-daily 30 --slippage-bps 150`. Each user can change their own vault's limits later.

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
`create` makes your vault if you have not logged in to the app.

## What was checked, and what was not

Checked on 26 Nov 2026:

- Token addresses (USDT, WHSK, WETH, WBTC) match the chain's official *Token Contracts* documentation page.
- Read from mainnet: chain id 177; the router has a factory; each pool holds its token and USDT, charges 0.3%, has
  liquidity, and comes from that same factory. The deploy script repeats these checks every time and stops on any mismatch.
- The explorer accepts compiler `v0.8.26+commit.8a97fa7a`, EVM version `cancun` and standard-JSON-input verification.
- On a local fork of mainnet, with Hardhat's public test keys:
  - `scripts/fork-test.mjs`, 22 checks: the server makes a vault for a wallet that signs nothing; it starts with the
    three markets listed; asking twice gives the same vault; a second user gets a different vault and cannot withdraw
    from the first; the daily cap on vault creation; an order on an empty vault is refused; and every trading guard
    (per-trade cap, daily cap, slippage floor, owner-only withdrawal, pause).
  - The deploy script (dry run, a refused confirmation, the hidden key prompt: the key does not appear in the
    terminal output) and the `vault.mjs` commands.
  - In a browser against the fork: log in, vault made, deposit 20 USDT, an order with the session (filled), the same
    order without a session and with an altered session (both refused with HTTP 401), withdraw, rename, log out,
    and a browser with no wallet.

Not checked:

- The HSKSwap router address is not on the official documentation page that lists the tokens; it was confirmed only
  by its on-chain relation to the pools.
- `scripts/verify.mjs` has not been run against a real deployment.
- A real wallet extension (MetaMask): the browser run used a stand-in that signs with a fork test account.
- Wallets that are contracts (multisigs, smart accounts) cannot log in yet: the login checks an ordinary signature.
- Nothing has been sent on mainnet.
