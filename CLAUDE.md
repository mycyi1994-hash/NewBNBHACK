# CLAUDE.md — Operating manual for the coding agent

You are the engineer on **이자로 (Ijaro)**, an entry for *BNB Hack: Tokenized Stocks Edition*
(build until **Sun 11 Oct 2026 12:00 UTC**, internal submit target **Fri 9 Oct**).
Three senior planners wrote `docs/`. You build what they specified, in the order they specified,
and you keep the evidence trail they demand. You do not redesign the product on your own.

## Read in this order, every session

1. `docs/JUDGING.md` — the official scoring criteria (verbatim) and how every feature maps to them. **Never forget these.**
2. `docs/PLAN.md` — what we build, for whom, scope tiers, milestones, cut lines, review minutes.
3. `docs/SPEC.md` — architecture, modules, data model, agent loop, guardian, error taxonomy.
4. `docs/TASKS.md` — the ticket backlog. Work strictly top-down unless a human reorders it.
5. `docs/DECISIONS.md` — locked decisions and open questions. If you resolve a ⚠️VERIFY item, write the result here.
6. `docs/DX_PROTOCOL.md` — how to log developer-experience evidence (25% of the score).
7. `docs/UX_COPY.md` — every user-facing string, KR + EN. Do not invent copy.
8. `docs/GOALS.md` — the `/goal` directives (G0–G9). When you are running under a goal, its numbered
   conditions are the contract, and you end **every** turn with a `GOAL STATUS` block: one line per
   condition, `PASS` or `FAIL`, followed by the evidence (quoted command output, tx hash, file path).

## Mission in one paragraph

Principal stays in a USDT deposit (Venus). The agent buys tokenized US stocks (bStocks / Ondo on BSC)
with the **interest** — or with a fixed contribution in *safe mode* — **only during the US regular
session**, with hard spending caps, deterministic rules, and an on-chain receipt plus a one-sentence
"why" for every action. A judge must be able to complete the core loop with a few dollars in
under three minutes.

## The four criteria (official wording — keep visible)

| Weight | Criterion | What they look at |
| --- | --- | --- |
| 30% | Technical implementation | Does it run, and how deep does the integration go? Modules used, error handling, how it holds up. |
| 25% | Creativity & originality | Were the APIs used in ways nobody expected? Does this already exist five times over? |
| 25% | Developer Experience Report | Specific, actionable, honest, no fluff. Includes the AI stack section. |
| 20% | Product quality & UX | Is it usable by the people it is for? Would it bring non-crypto-native users on-chain? |

Special prizes: *Best Use of Agentic Wallet / Wallet Skills* ($2,000) and *Best Use of BNB Agent Studio* ($2,000).
Agentic Wallet is described by the organizers as "optional, **heavily weighted in scoring**".

## Working rules

1. **One ticket at a time.** Say which ticket you are on. Its acceptance criteria are the contract.
   When done, tick the boxes in `docs/TASKS.md` and attach evidence (command output, tx hash, fixture path, screenshot path).
2. **Verify before you build on any API assumption.** Run `scripts/fetch-docs.sh` first
   (`docs/vendor/llms-full.txt` is the full Binance Web3 API documentation). Read the source of
   `@binance-web3/wallet` in `node_modules` for exact endpoint paths and signing. Record real responses
   as fixtures under `fixtures/<module>/`. Never invent fields, paths, or error codes. Every item marked
   ⚠️VERIFY in `docs/SPEC.md` must be confirmed against the docs or a live call and the result written
   to `docs/DECISIONS.md`.
3. **DX obligation.** Every surprise — a doc that is wrong, an error message that makes no sense, an
   undocumented parameter, a latency spike, a missing capability — goes into `dx/LOG.md` in the same
   session, in the format from `docs/DX_PROTOCOL.md`, with a UTC timestamp, the endpoint, the request id
   if any, and expected-vs-actual. You supply evidence; **humans write the report prose.** Never write
   narrative into `dx/REPORT_DRAFT.md`.
4. **No mocks in product paths.** Fixtures live under `tests/` and `fixtures/` only. Every data view has
   exactly one of three states: `LIVE`, `STALE` (with timestamp), `UNAVAILABLE` (with reason). Never
   fabricate a number, a price, or a transaction. No "coming soon" UI.
5. **Money safety is non-negotiable.** Caps are hard limits enforced in code and configured in env:
   house wallet ≤ `HOUSE_MAX_PER_TX_USD` (default 25), sandbox plan ≤ `SANDBOX_MAX_PER_PLAN_USD` (default 5),
   total ≤ `DAILY_SPEND_CAP_USD` (default 50). Exact-amount approvals only, never unlimited.
   Simulate through the Transaction API before every broadcast. Any change to a cap, and any **new**
   path that can spend funds, requires an explicit human "yes" in the conversation first.
   Never commit `.env*`, private keys, keystores, `.studio/`, or Agentic Wallet session files.
   Run `git status` before every commit.
6. **Decisions are code, not a model.** The agent loop is deterministic rules (`packages/core`).
   No LLM call sits in the decision path. (The user's own assistant may run our Wallet Skill; that is
   their model, executing our rules.)
7. **Timebox.** A spike is ≤ 2 hours. Blocked for > 30 minutes → write the open question in
   `docs/DECISIONS.md`, take the fallback listed there, move on.
8. **Language.** Code, comments, commits, identifiers: English. UI strings: KR + EN via keys from
   `docs/UX_COPY.md`. Docs may be Korean.
9. **Quality gates.** Before every commit: `pnpm typecheck && pnpm lint && pnpm test`.
   Before every deploy: `pnpm smoke` (calls `/api/judge/smoke` on the target).
10. **Never-cut list** (PLAN §8) is sacred. Cut lines apply only with human agreement.
11. **Do not widen scope.** If you see a good idea, write it under "Ideas parked" in `docs/DECISIONS.md`.

## Target repository layout

```
apps/web        Next.js app: Watch (home), Judge Mode, plan pages, /dx, API routes for the Wallet Skill
apps/agent      Long-running worker: 5-min tick, tape recorder, guardian, alerts
packages/core   Domain: plan/cycle types, decideCycle(), guardian rules, amount math (pure, tested)
packages/binance  Binance Web3 API client: signing, per-endpoint rate limiter, envelope, logging hook
packages/chain  viem: BSC reads/writes, Venus vToken, BEP-677 multiplier, ERC-20
packages/db     Drizzle schema + migrations (Postgres)
skills/ijaro    Wallet Skill (SKILL.md + references) for Claude Code / OpenClaw + baw
scripts/        fetch-docs.sh, reach, dx:metrics, cycle:once
fixtures/       recorded real API responses (redacted)
dx/             LOG.md (human+agent evidence), metrics.md (generated), findings/, REPORT_DRAFT.md (humans only)
docs/           the planning set
```

## Commands (targets; create them in M0-01)

```
pnpm dev            # web + agent locally (EXECUTION_MODE=simulate by default)
pnpm reach          # unsigned + signed reachability + latency to the Web3 API from this host
pnpm tape:once      # one tape sample
pnpm cycle:once --plan <id> [--live]   # run one agent cycle; --live requires human confirmation prompt
pnpm dx:metrics     # regenerate dx/metrics.md from the api_calls table
pnpm smoke          # hit /api/judge/smoke
pnpm typecheck && pnpm lint && pnpm test
```

## Git

- Work on branch `claude/gallant-albattani-pq0lz9` unless told otherwise. Small commits.
- Message format: `area: what it does (TICKET-ID)` — e.g. `core: add decideCycle window check (M1-02)`.
- Never force-push. Never commit generated `docs/vendor/`.

## Judging-window posture (12–23 Oct)

No risky deploys after 9 Oct. Hotfixes only, each verified with `pnpm smoke`. Keep the house agent
running, keep the tape running, check `/api/judge/smoke` daily, and log anything odd in `dx/LOG.md`.
