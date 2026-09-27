# DEMO.md — the 4-minute video and the judges' 15-minute path

Author: Minseo Kang. Filming 10/6~10/7, editing 10/8. Screen recording + narration (English, with Korean subtitles). Live-trade scenes are filmed during the regular session (22:30~05:00 KST).

## 1. Video script (≤ 4:00)

| Time | Screen | Narration gist |
| --- | --- | --- |
| 0:00–0:20 | Home. House plan card: principal $x, interest earned $y, n shares collected | "The principal stays put. Only the interest becomes stock. This plan is a record Yieldvest has been running on its own since late September." |
| 0:20–1:30 | Judge Mode run-through: code → NVDA → safe mode $5 → preview (simulation sentence) → Buy now → receipt (BscScan) | "A judge gets all the way through with one code in under 3 minutes. Before executing, it dry-runs on the blockchain, shows it in plain words, and leaves a receipt and a reason." |
| 1:30–2:20 | Turn on yield mode → risk disclosure → deposit receipt → the house plan's cumulative interest chart → weekend DEFERRED record ("US market is closed. Retrying at Monday 22:30.") → Monday buy receipt | "Yield mode buys only with the interest from the Venus deposit. Because it buys only during the regular session, it waits over the weekend. It records why it waited, too." |
| 2:20–3:10 | Claude Code screen: one-line skill install → "Start Yieldvest" → the assistant reads out the risk disclosure → `baw` preview and confirm → fill → `/report` | "The user's AI assistant executes through the Agentic Wallet. The server only decides; signing happens on the user's device." |
| 3:10–3:40 | Guardian screen + corporate-action SKIPPED record + share count display (multiplier applied) | "The guardian watches for protocol anomalies, depegs and price gaps, and it also understands earnings restrictions and splits." |
| 3:40–4:00 | README module matrix + /dx page (p95, off-hours gap chart) + DX report | "7 modules, every call instrumented, 2 weeks of off-hours data. It's all in the report." |

Filming checklist: browser zoom 125%, lock to either dark or light, mask addresses and keys, failure scenes use real failure records (no staging), 3 links in the last frame (live, repo, DX).

## 2. The judges' 15-minute path (draft for the top of the README)

```
# Yieldvest — Interest buys the stock. Principal stays.
Live: https://…  ·  Video (3:50): https://…  ·  DX report: docs/… · Judge Mode: code in submission form

**60-second summary** Principal sits in a USDT interest account (Venus); only the interest automatically buys US stock tokens (bStocks/Ondo) during the regular session.
Safe mode (contribution only) is the default. Every buy is dry-run through the Transaction API first and leaves a receipt and a one-line reason.

**3-minute trial** Home → [judge code] → stock → $5 → preview → Buy now → receipt → [Stop this plan]

**Record of Yieldvest's own runs** (auto-generated table: date · plan · outcome · amount · shares · receipt)

**Module matrix** (PLAN §6.1 table)

**Use it with Agentic Wallet** `npx skills add …` → "Start Yieldvest"

**Risks** /risk — Not a bank. Principal can be lost. Safe mode is the default.

**Run it** pnpm i · cp .env.example .env · pnpm dev — even without keys, Home comes up honestly in the UNAVAILABLE state, with no STALE data.
```
