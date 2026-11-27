# Running Moa on a server

One Node process serves the built app, the API and the agents that trade on their own (`server/main.ts`).
It has to stay up, and it needs a small disk that survives restarts: the agents on "auto" are kept there.
Run exactly one instance: the agent wallet sends one transaction at a time, and two processes would collide.

## Render (web service)

| Field | Value |
| --- | --- |
| Branch | `claude/dazzling-thompson-1kj2p2` |
| Root Directory | `hsk-agent` |
| Language | Node |
| Build Command | `npm install --include=dev && npm run build` |
| Start Command | `npm start` |
| Instance | the smallest paid one. A free instance sleeps when idle, which stops the agents |
| Health Check Path | `/api/health` |
| Disk | mount path `/var/data`, 1 GB |

Environment variables:

| Key | Value |
| --- | --- |
| `NODE_VERSION` | `22` |
| `ANTHROPIC_API_KEY` | the key Moa's conversation uses |
| `MOA_FACTORY_ADDRESS` | the deployed MoaVaultFactory (see `contracts/MAINNET.md`) |
| `MOA_AGENT_EXTRA_KEYS` | optional, comma-separated: earlier agent keys still named by some vaults' sessions, during a key rotation (version 3; see `contracts/MAINNET.md`) |
| `MOA_LEGACY_FACTORY_ADDRESSES` | optional, comma-separated: earlier factories whose vaults their owners keep using (see `contracts/MAINNET.md`, Version 3) |
| `MOA_FEES_FROM_BLOCK` | optional: the block from which creator fees received are read (default: the factory's deployment block) |
| `MOA_AGENT_PRIVATE_KEY` | the agent key from `hsk-agent/.env.local` on the machine that made it |
| `MOA_DATA_DIR` | `/var/data` |
| `MOA_SESSION_SECRET` | any long random text (the dashboard can generate one) |

Optional: `MOA_RPC_URL` (default `https://mainnet.hsk.xyz`), `MOA_MAX_VAULTS_PER_DAY` (default 20: how many
vaults the agent wallet will pay to create per day).

`/api/health` says only what works (`vaults`, `factory`, `ai`) and nothing about keys, files or paths; it never calls
the model. Where the agents on auto are kept, and how many wallets the server knows, is printed in the service's
log when it starts. Moa's answers are rationed: `MOA_AI_PER_MINUTE` (default 6), `MOA_AI_PER_DAY` per logged-in
wallet (150), `MOA_AI_PER_DAY_ANON` per address when not logged in (30), `MOA_AI_PER_DAY_ALL` for the whole server (3,000).
Orders the server sends (each costs the agent wallet gas) are capped per wallet: `MOA_TRADES_PER_MINUTE` (5), `MOA_TRADES_PER_DAY` (100), `MOA_TRADES_PER_DAY_ALL` (2,000). On Render the caller's address comes from `X-Forwarded-For` (set `MOA_TRUST_PROXY=1` behind another proxy).

The agent key is the only secret that touches funds. It can trade inside each vault's limits and pay gas from its
own wallet; it cannot withdraw from any vault. Anyone who can read the service's environment can read it.

## Anywhere else

```bash
npm install --include=dev
```

```bash
npm run build
```

```bash
npm start
```

Node 22.6 or newer. Settings come from the environment, or from `.env.local` next to `package.json`.
`PORT` sets the port (default 4180).

## What was checked

On a local fork of HSK mainnet, with this server (not the development server): the page, a deep link and the
market-data pass-through are served; log in, vault made, deposit; an agent put on auto bought within a minute with
nobody approving, did not buy again the same day, and showed up in the app with its receipt; pausing it from the
app reached the server. Hiring on auto from the sheet saves the daily limit and the stop-loss on the vault with the
same button (two confirmations in the wallet) and asks for none the second time.

On Render: the service is up at https://grabitmoa.onrender.com and `/api/health` reports the factory as usable.
A trade by an agent on auto has not been watched there yet.
