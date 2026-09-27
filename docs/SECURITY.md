# SECURITY — Security review (M3-05, SPEC §14)

Author: the coding agent (9/26). Only facts and evidence are written here. A human reviews it.

## Who signs what

- **Only the worker (Fly, fra) signs.** The house key exists only in the worker's env (`HOUSE_WALLET_PRIVATE_KEY`; not in the web). Before signing: exact-amount approvals only (unlimited approvals refused), swap calldata decoded and validated (sender=house, value 0, approval target=spender, **call target=the approved router** — added 9/27, `SWAP_TARGET_MISMATCH`), Transaction API simulation SUCCESS, a gas ceiling, and quotes older than 25 seconds are fetched again (SPEC §5.8, `apps/agent/src/executor/*`). At boot and at the start of a live command, it checks that every RPC is on chain ID 56 (`assertBscChain`).
- **Money is recorded once, together with its receipt.** The effect of a deposit, redeem or swap is applied the moment it is confirmed, in one transaction that locks the plan row (`SELECT … FOR UPDATE`) and inserts the receipt first — the same hash is never applied twice (one lowercase form, CHECK), and concurrent writes do not overwrite each other (`packages/db/src/record.ts`, DECISIONS D-23). A broadcast with an unclear outcome is not counted as "not sent": it stays PENDING, and FAILED is never stamped on a guess (RUNBOOK §3.4).
- **The web does not sign, and it does not call the Binance Web3 API either.** It reads only the DB the worker writes and public BSC RPC, and it hands execution over through `jobs`.
- **Skill plans (mode C) are signed by the user's wallet.** The server gives only `baw` commands (argv) and does not create calldata, signatures or sessions. `/report` records only what is confirmed on-chain (mined, succeeded, sent from the plan wallet, Transfer log). Added 9/27: hashes signed by the house outbox and plans that use the house wallet are refused, txs mined before the plan was created are refused, hashes use one lowercase form, and a swap report writes the receipt, cycle, ledger, holdings and interest deduction in one transaction. A Venus id that goes into `/next`'s argv must match `^[A-Za-z0-9_-]{1,128}$`.
- A skill plan's Venus principal is in the user's wallet: the worker **does not redeem** a skill plan in a stop job or in the guardian's `redeem_all` (`redeemPlanPosition` checks the owner). Before this check, there was a path that redeemed the skill plan's reported vToken amount from the house wallet — fixed 9/26, test "never redeems a skill plan's position from the house wallet" (confirmed failing before the fix). The worker also refuses `run` and `preview` jobs for skill plans.

## Limits (caps)

- Caps are read from env in one place only: `packages/config`. If a cap variable name appears in any other source, a test fails (`packages/config/src/index.test.ts`; since 9/27 across all of apps, packages, scripts, skills and .github), and ways around `process.env` (`globalThis.process`, importing `env` from `node:process`, etc.) are blocked by lint. Validated at boot: minimum buy ≤ per-buy ≤ daily, sandbox cap ≤ house per-tx cap, plain decimals only (exponents, hex and signs refused).
- Spending is reserved in `spend_ledger` in one transaction under an advisory lock (concurrent cycles cannot jointly exceed a cap — a test fails if the lock is removed). The house daily total counts only house and judge plans (skill plans use the user's wallet — fixed 9/26, no cap value changed).
- One judge code = the sandbox cap ($5) in total — since 9/27 **counting spending and interest-plan principal together** (`judgeExposureUsd`); a new deposit is refused if another plan of the code has a tx being settled. A judge plan's per-buy spend is the smaller of the sandbox cap and the house per-tx cap. It ends automatically after 7 days (the principal is redeemed while holding the lock). Skill plan per-buy limit ≤ house per-tx cap, daily ≥ per-buy.

## Auth, sessions, rate limits

- Judge codes: only the SHA-256 is stored; the cookie `yieldvest_judge` is HMAC-SHA256 signed (code hash + expiry), HttpOnly, SameSite=Lax, Secure on HTTPS, 7 days. `SESSION_SECRET` must be at least 32 characters; without it, session features are off (503). Since 9/27, a code removed from `JUDGE_CODES` is refused immediately even if its cookie remains (web `activeJudgeOf`), and the worker does not run that code's plans either (`code_disabled`).
- Skill tokens `yv_…`: shown once, only the hash is stored, plan ownership is checked (`ownedPlan`).
- Rate limits: code attempts 10 per minute per IP, skill plan creation 5 per hour per IP, `/next` and `/report` **after auth** 30 and 20 per minute per token and plan (someone else cannot use up the owner's share) + before auth 120 and 60 per minute per IP (instance memory; when the keys overflow, the longest-idle keys are dropped first). The durable limits (5 plans per hour per code, 5 open plans per wallet — counting and writing under one advisory lock, 10 jobs per 10 minutes per plan — stop is exempt) are in Postgres. The IP is the `x-real-ip` that Vercel sets.
- CSRF: cookies on write requests are SameSite=Lax, so they are not attached to POSTs from other sites. Requests with a body accept only `application/json` (415) — a form on another site cannot send this type without a preflight. Reading the body stops at 16 KB (413). Skill routes use a Bearer header.

## HTTP security headers

- `apps/web/proxy.ts`: a CSP with a fresh nonce per request — `default-src 'self'`, `script-src 'self' 'nonce-…' 'strict-dynamic'` (no inline scripts), `style-src 'self' 'nonce-…'`, `style-src-attr 'unsafe-inline'` (only for the progress bars' style attributes), `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, and `upgrade-insecure-requests` on HTTPS.
- `apps/web/next.config.ts`: HSTS (2 years, includeSubDomains, preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation and payment off), no `X-Powered-By`.
- Verified (local `next start`): the values above are in the response headers, all 7 `<script>` tags in the home HTML carry a nonce, and `pnpm ui:check` (Chromium, 7 screens × KO/EN × 375/1440px) shows 0 console errors and 0 CSP violations.

## Keeping errors from leaking

- Public responses never carry the raw error (it can contain host and port, or an RPC URL with a key in it): the screen shows "Unavailable (database unavailable)", the API returns 503 `{"state":"UNAVAILABLE","reason":"database unavailable"}`, smoke shows `rpc unreachable`/`database unreachable`. The raw error goes to the server log only. Test: checks that the response body contains no host (`127.0.0.1`).
- Added 9/27: a failed job (`GET /api/jobs/:id`) shows only a refusal reason the worker wrote for the caller (`PublicError`) as is; any other error shows as "the worker could not finish this job". The worker entry in smoke shows only the error count and sources (settle, guardian, cycle, job), and is degraded if there are errors. Telegram alerts keep only the host of a URL (keys in the path and query are removed).
- Keys and the house address are masked in logs, fixtures and alerts (`maskSensitive`, `houseRedactions`, alert `redact`). Hex values are masked regardless of case or a 0x prefix (9/27). The Binance client does not follow redirects (so the API key never goes to another host).

## Secret scan (9/26, full git history)

- 64-digit hex: only a publicly known test key (Hardhat/Anvil default account #0, a widely known value).
- `*_KEY=`/`*_SECRET=` patterns: only the fake values in the signing test vectors (`vector-api-key`) and the session secret in the web tests.
- Neon URL: only a fake example in the config tests (`npg_AbC123@ep-cool-name-…`). `yv_` tokens, Telegram tokens, PEM keys: none.
- Tracked files: only `.env.example` (a template without values). `.gitignore`: `.env*` (except `.env.example`), `*.pem`, `*.key`, `.studio/`, `.baw/`, vendor docs. The worker Docker build fails if a `.env*` file is present.

## Dependency audit

- `pnpm audit --prod`: **No known vulnerabilities found.**
- `pnpm audit` (including dev dependencies): 1 moderate — `esbuild ≤ 0.24.2` (GHSA-67mh-4wv8-2f99, a CORS issue in the esbuild **dev server**) — path `drizzle-kit > @esbuild-kit/… > esbuild`. It is used only by the migration generation tool, and we do not use esbuild serve. A forced upgrade could break drizzle-kit, so it was left as is → [HUMAN] confirm whether to accept it.

## Remaining risks (after the full 9/27 audit)

- **There is no proof of ownership for a skill plan's wallet.** Anyone can create a skill plan with any wallet address. Blocked: the house wallet and txs the house sent, txs from before the plan was created, the same hash twice. Remaining: (a) if someone creates a plan with another person's wallet and reports that wallet's **later** swaps first, those swaps show in the feed as that plan's buys, and the real owner's plan gets that hash back as `already_recorded` (no money moves — records only). (b) Someone can fill up the 5 open plans for a wallet first so that the owner cannot create a new plan. Candidate fix: prove wallet ownership with a `baw sign-message` (EIP-712) signature at plan creation — the user has to turn on Developer Mode in the Binance app, and the signature format has not been measured (⚠️VERIFY), so it is **awaiting a human decision** (DECISIONS Q-17).
- A cycle left `running` after the worker dies is cleaned up the next time that plan takes the lock — if a manual run (judge `run`) dies, its cap reservation stays until then, so the code's remaining limit looks smaller (released on the next run).
- A swap resend within 10 minutes sends the same bytes without a new simulation or market-hours check (the minReceive 0.5% protection still applies).

## Remaining work

- [HUMAN] Recheck the headers and CSP on the deployed domain (`pnpm ui:check --url https://…`), and decide whether to register for HSTS preload.
- [HUMAN] Confirm that the house wallet balance stays within the $300 ceiling (SPEC §14).
- [HUMAN] Before deploying, confirm that the cap values on Fly and Vercel pass the new format validation (RUNBOOK §4).
- [HUMAN] Decide on Q-17, the skill wallet ownership proof.
