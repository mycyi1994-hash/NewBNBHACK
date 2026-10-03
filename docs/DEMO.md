# DEMO.md — the 4-minute video and the judges' 15-minute path

Author: Minseo Kang. Filming 10/6~10/7, editing 10/8. Screen recording + narration (English, with English subtitles — 9/27, D-26/D-27). Live-trade scenes are filmed during the regular session (22:30~05:00 KST).

## 1. Video script (≤ 4:00)

| Time | Screen | Narration gist |
| --- | --- | --- |
| 0:00–0:20 | Home. House plan card: principal $x, interest earned $y, n shares collected | "The principal stays put. Only the interest becomes stock. This plan is a record Yieldvest has been running on its own since late September." |
| 0:20–1:30 | Invite trial run-through: invite code → NVDA → safe mode $5 → Test it on-chain (the simulation sentence) → Buy now → receipt (BscScan) | "Anyone gets all the way through with one invite code in under 3 minutes. Before executing, it tests the purchase on the blockchain, shows it in plain words, and leaves a receipt and a reason." |
| 1:30–2:20 | Turn on yield mode → risk disclosure → deposit receipt → the house plan's cumulative interest chart → weekend DEFERRED record ("US market is closed. Retrying at Monday 22:30.") → Monday buy receipt | "Yield mode buys only with the interest from the Venus deposit. Because it buys only during the regular session, it waits over the weekend. It records why it waited, too." |
| 2:20–3:10 | Claude Code screen: one-line skill install → "Start Yieldvest" → the assistant reads out the risk disclosure → `baw` preview and confirm → fill → `/report` | "The user's AI assistant executes through the Agentic Wallet. The server only decides; signing happens on the user's device." |
| 3:10–3:40 | Guardian screen + corporate-action SKIPPED record + share count display (multiplier applied) | "The guardian watches for protocol anomalies, depegs and price gaps, and it also understands earnings restrictions and splits." |
| 3:40–4:00 | README module matrix + /dx page (p95, off-hours gap chart) + DX report | "7 modules, every call instrumented, 2 weeks of off-hours data. It's all in the report." |

Filming checklist: browser zoom 125%, lock to either dark or light, mask addresses and keys, failure scenes use real failure records (no staging), 3 links in the last frame (live, repo, DX).

### 1.1 Agent draft (10/2): where the read-only views fit — a person decides

> Author: coding agent, at a human's request on 10/2. The script above is the person's and is left as it is; these are optional swaps that keep the video at 4:00. Every screen named here exists on the branch today (DECISIONS D-31, D-32), and each shows real data only once the worker records it on the deployed site.

| Swap into | Seconds | Screen | Narration gist |
| --- | --- | --- | --- |
| 0:20–1:30 (Judge Mode), before **Buy now** | 10 | `/check?ticker=NVDA&usd=5`: per token "Would buy about … shares for $5.00 now" (or "Would wait" with the next try), and the seven rules with what each read | "Before any money moves, you can ask the agent's own rules what they would do right now — and see every number they read." |
| 0:20–1:30, at the stock pick | 8 | `/compare?ticker=NVDA`: bStocks and Ondo side by side; Ondo's $5 quote refused (40375), the $50 quote in shares and price per share | "Two issuers of the same share. We show both, in shares, and you choose; a plan never switches." |
| 1:30–2:20 (yield mode), on Earn | 8 | The calculator: $1,000 at today's listed APY → interest a year, the first buy after N days, about how many shares a month | "Small interest, next investment — at today's rate, and we say it's a projection." |
| 2:20–3:10 (Claude Code), after the fill | 12 | In Claude Code with `claude mcp add --transport http yieldvest <site>/api/mcp`: "Would Yieldvest buy NVDA now?" → the `preflight` tool's answer; then `/wallet?address=<the team wallet>` showing the bought shares at the on-chain multiplier | "Any assistant can ask the same engine through MCP — read-only. And your wallet shows what you own in real shares, not tokens." |
| Cut to make room | −38 | Shorten 3:10–3:40 (guardian) to 15 s and 3:40–4:00 (README, /dx) to 12 s, or drop one swap | — |

Before filming, check two lines of the script against the repository on the day: 3:40 says "7 modules" — the README module matrix today shows the RWA Data, Market, Trading, Transaction and DeFi APIs plus the Agentic Wallet, with the Wallet API, b402 and Agent Studio not in use; and "2 weeks of off-hours data" needs the production tape (`/dx`). The filming checklist's "mask addresses" applies to `/wallet` too: film a team wallet whose address may be shown.

## 2. The judges' 15-minute path (draft for the top of the README)

```
# Yieldvest — Interest buys the stock. Principal stays.
Live: https://…  ·  Video (3:50): https://…  ·  DX report: docs/… · Judge Mode: code in submission form

**60-second summary** Principal sits in a USDT interest account (Venus); only the interest automatically buys US stock tokens (bStocks/Ondo) during the regular session.
Safe mode (contribution only) is the default. Every purchase is tested on-chain through the Transaction API first and leaves a receipt and a one-line reason.

**3-minute trial** Home → [invite code] → stock → $5 → Test it on-chain → Buy now → receipt → [Stop this plan]

**Record of Yieldvest's own runs** (auto-generated table: date · plan · outcome · amount · shares · receipt)

**Module matrix** (PLAN §6.1 table)

**Use it with Agentic Wallet** `npx skills add …` → "Start Yieldvest"

**Risks** /risk — Not a bank. Principal can be lost. Safe mode is the default.

**Run it** pnpm i · cp .env.example .env · pnpm dev — even without keys, Home comes up honestly in the UNAVAILABLE state, with no STALE data.
```
