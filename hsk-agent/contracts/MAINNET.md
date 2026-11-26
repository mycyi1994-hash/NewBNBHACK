# Putting MoaVault on HSK Chain mainnet

Everything below is run by the vault's owner, on the owner's own computer, from `hsk-agent/contracts`.
Nothing here has been run against mainnet yet: the scripts were exercised on a local fork of mainnet only.
The contract is unaudited. Start with a small amount.

## Two wallets

| Wallet | What it can do | Where its key lives |
| --- | --- | --- |
| **Owner** | Deploy, set limits, list markets, pause, withdraw. The only address that can take funds out. Cannot be changed after deployment. | Your own wallet. Typed into a hidden prompt when a script needs it; never written to a file, never printed, never pasted into a chat. |
| **Agent** | Call `trade()` only: USDT ↔ WHSK / WETH / WBTC on HSKSwap, inside the per-trade cap, the per-day cap and the slippage floor. Cannot withdraw. | `hsk-agent/.env.local` on the machine that runs the app (git-ignored). Replaceable by the owner at any time. |

Use a fresh owner wallet that holds only what this needs, not a wallet with other funds.

## What you need first

- HSK in the owner wallet for gas: the dry run prints the estimate (about 0.75 HSK at the gas price seen on 26 Nov 2026). Keep twice that.
- A little HSK in the agent wallet: each trade costs gas (about 0.1–0.15 HSK at that gas price).
- USDT on HSK Chain in the owner wallet, for funding the vault: `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029`.

## Steps

```bash
npm install
```

```bash
node scripts/compile.cjs
```

1. **Make the agent key.** Writes it to `../.env.local` and prints only its address.

   ```bash
   node scripts/agent-key.mjs
   ```

   Send that address a little HSK.

2. **Dry run.** Reads the chain, checks every address, shows the plan and the gas cost. Sends nothing.

   ```bash
   node scripts/deploy-mainnet.mjs --owner 0xYOUR_OWNER_ADDRESS
   ```

   Limits default to $10 per trade, $30 per day, 1.5% slippage ceiling. To change them add
   `--max-trade 10 --max-daily 30 --slippage-bps 150`. The owner can change them later.

3. **Deploy.** Asks for the owner key (hidden), shows the same plan, and waits for you to type `deploy`.
   Four transactions: the contract, then one per market. No funds move into the vault here.

   ```bash
   node scripts/deploy-mainnet.mjs --send
   ```

   It writes `deployments/hsk-mainnet.json` (addresses, transaction hashes, verification settings; no keys) and
   prints the vault address. Add that address to `../.env.local`:

   ```
   MOA_VAULT_ADDRESS=0x...
   ```

4. **Publish the source on the explorer** (needs no key).

   ```bash
   node scripts/verify.mjs
   ```

   If the upload is refused, do it by hand on the vault's page at https://hsk.blockscout.com:
   Contract → Verify & publish → *Solidity (Standard JSON input)*, compiler `v0.8.26+commit.8a97fa7a`, licence MIT,
   file `out/MoaVault.standard-input.json`. The constructor arguments are in `deployments/hsk-mainnet.json`.

5. **Fund the vault.** Sends USDT from the owner wallet; asks you to type `fund`.

   ```bash
   node scripts/vault.mjs fund 20
   ```

6. **Check it.** Reads only, needs no key.

   ```bash
   node scripts/vault.mjs status
   ```

7. **First trade.** Restart the app (`npm run dev` in `hsk-agent`), hire an agent for BTC, ETH or HSK and approve its
   first order, or tell Moa “execute a $5 ETH buy now”. The receipt links to the transaction on the explorer.

8. Commit `deployments/hsk-mainnet.json` and put the vault address and the first trade's link in the README.

## Owner controls

```bash
node scripts/vault.mjs pause
```

```bash
node scripts/vault.mjs unpause
```

```bash
node scripts/vault.mjs withdraw USDT all
```

```bash
node scripts/vault.mjs limits 10 30 150
```

```bash
node scripts/vault.mjs agent 0xNEW_AGENT_ADDRESS
```

`withdraw` also takes `WHSK`, `WETH`, `WBTC`, and an amount instead of `all`. If the agent key may have leaked:
`pause`, then `agent` with a new address from a fresh `agent-key.mjs` run (remove the old key line from `.env.local` first).

## What was checked, and what was not

Checked on 26 Nov 2026:

- Token addresses (USDT, WHSK, WETH, WBTC) match the chain's official *Token Contracts* documentation page.
- Read from mainnet: chain id 177; the router has a factory; each pool holds its token and USDT, charges 0.3%, has
  liquidity, and comes from that same factory. The deploy script repeats these checks every time and stops on any mismatch.
- The explorer accepts compiler `v0.8.26+commit.8a97fa7a`, EVM version `cancun` and standard-JSON-input verification.
- On a local fork of mainnet, with Hardhat's public test keys: dry run, a refused confirmation, deploy, fund, withdraw,
  pause, unpause, limits, agent replacement, a wrong owner key being refused, the hidden key prompt (the key does not
  appear in the terminal output), and `scripts/fork-test.mjs` (11 checks on the vault and the server executor).

Not checked:

- The HSKSwap router address is not on the official documentation page that lists the tokens; it was confirmed only
  by its on-chain relation to the pools.
- `scripts/verify.mjs` has not been run against a real deployment.
- Nothing has been sent on mainnet.
