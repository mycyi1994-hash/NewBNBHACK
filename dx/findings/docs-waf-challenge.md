# The LLM docs files answer non-browser clients with an empty 202

- **Where:** `https://web3.binance.com/en/dev-docs/llms.txt` and `llms-full.txt` (the docs' own "Download and use as context" files)
- **Logged:** dx/LOG.md, 2026-09-23 17:44 UTC
- **Last run:** 2026-10-01T16:52:28Z — REPRODUCED — HTTP 202, `x-amzn-waf-action: challenge`, 0 bytes (from a cloud sandbox; 9/23 from a US-based cloud)

## Reproduce
`pnpm dx:repro --only docs-waf-challenge`, or `curl -sS -D - -o /dev/null https://web3.binance.com/en/dev-docs/llms-full.txt`.

## Expected / actual
- Expected: HTTP 200 and the Markdown file, for the agents and scripts the file is meant for.
- Actual: HTTP 202 with an AWS WAF challenge header and an empty body. `curl -f` treats 202 as success, so a fetch script writes an empty file and exits 0. Headless Chromium gets HTTP 200 after the challenge script runs (about 5.5 s per file).

## Impact
About 15 minutes lost on 9/23; `scripts/fetch-docs.sh` validates every download and falls back to a headless browser.

## Ask
Exempt `/en/dev-docs/*.txt` and `*.md` from the challenge, or answer a challenged request with a 4xx instead of a 2xx.
