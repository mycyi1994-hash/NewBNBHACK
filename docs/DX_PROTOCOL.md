# DX_PROTOCOL.md — Developer experience evidence system (25% of the score)

Author: Jiwoo Park. Applies to: all humans + the coding agent.

## 1. Why
Official rule: "Perfunctory or AI-generated reports are not accepted." The judges want to know the flaws in their own API **with locations and numbers**. This cannot be written from memory. It has to be recorded the moment it happens.

## 2. What to record
| Category | What to record | Source |
| --- | --- | --- |
| Onboarding | Portal login time, key issuance time, time of the first successful unsigned call, time of the first successful signed call, where we got stuck in between | Humans + `pnpm reach` |
| Documentation errors | Page URL, section title, what the docs said, the actual behavior, evidence (request ID, fixture) | Humans + agent |
| API pitfalls | Verbatim text of error messages that make no sense, code, repro steps, edge cases, latency | `api_calls` + agent |
| AI stack | Time to install and log in to `baw`, success and failure per command, session expiry experience, experience writing the Skill, `bag` experience, missing features | Humans |
| Tokenized-stock specifics | Price impact by size, off-hours quote rejection rate, on-chain vs reference price gap (by time of day), differences by issuer | Tape |
| Redesign suggestions | "If I were an engineer on this platform": the #1 change | Humans |
| Requested capabilities | Prioritized list, and why each item was needed in our product | Humans |

## 3. Where, and in what format

### 3.1 `dx/LOG.md` (chronological, append-only)
```
## 2026-09-24 13:05 UTC — [web3api][auth] First signed call
- Goal:
- Expected:
- Actual: (HTTP/code/msg/latency ms, request id)
- Docs: URL + section
- Time lost:
- Workaround:
- Ask:
- Evidence: fixtures/... or screenshot path
```
Tags: `[web3api|baw|skill|bag|chain|defi|rwa|trading|tx|wallet|b402][auth|docs|error|latency|edge|missing]`.
The agent writes facts only (Expected, Actual, Evidence). Humans add a `- Impression:` line under the same entry.

### 3.2 `dx/metrics.md` (generated, every Sunday with `pnpm dx:metrics`)
Call count per endpoint, p50/p95, error code distribution, comparison by region, weekly trend.

### 3.3 `dx/findings/<slug>.md` (1 reproducible finding = 1 file)
Title, impact, repro steps, expected/actual, evidence, suggestion.

### 3.4 Tape summary (`/dx` page + `dx/tape-summary.md`)
Regular session vs pre-market/after-hours vs weekend: quote success rate, average price impact ($5/$50/$500), gap distribution, by issuer.
`pnpm tape:summary [--days 30]` writes `dx/tape-summary.md` from `tape_samples` (coverage, refusals and impact per issuer × session × size, the gap's median and p90, the refusal codes, the token statuses); run it against the production database.

### 3.5 `dx/REPORT_DRAFT.md` — **Only humans write this.** The agent does not edit this file.

## 4. Weekly routine
- Daily: record it in LOG within 10 min of it happening.
- Sunday (9/27, 10/4): humans update the REPORT_DRAFT draft section by section and do a self-assessment.
- 10/8: final version. 10/9 form submission.

## 5. Report structure (the 7 official items, verbatim)
1. **Onboarding** — timeline (portal → key → first call), where we got stuck, how to cut it in half
2. **Documentation issues** — table: Page | Section | Docs | Actual | Evidence
3. **API pitfalls** — verbatim error messages and what we understood them to mean, edge cases, latency numbers (p50/p95)
4. **AI stack feedback** — Agentic Wallet CLI, Wallet Skills (including an author's perspective), Agent Studio: what worked, what did not, what is missing
5. **Tokenized-stock specifics** — tape numbers: liquidity depth, slippage, off-hours behavior, gap, issuer differences
6. **Redesign suggestions** — top 3, each with a link to its supporting log entry
7. **Requested capabilities** — prioritized list, with why each item was needed in our product

## 6. Prohibited
- Padding with praise, generalities, claims without numbers
- The agent generating narrative prose
- Writing from memory without a log
- Presenting someone else's finding as ours (cite the source if you drew on it)

## 7. Example of a good entry
> 2026-09-24 14:12 UTC — [web3api][auth] Signature failure 40102, 3 times. The docs' `authentication` page, "Signature" section, reads as if only the path is signed, but in practice it passes only when the `/build` prefix and the query string are included (request id …). Time lost 40 min. Suggestion: put a verbatim example of the string to sign in the docs, and include the hash of the canonical string the server computed in the 40102 response.
