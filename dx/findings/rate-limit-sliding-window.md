# 5 requests per second still meets 429: the window is the last 1,000 ms

- **Where:** Trading API `GET /api/v1/dex/aggregator/quote` (any endpoint); docs § Authentication › Rate Limits
- **Logged:** dx/LOG.md, 2026-09-24 01:52 UTC
- **Last run:** not re-run since 9/24 (needs a Binance Web3 API key): `pnpm dx:repro --only rate-limit-sliding-window` (sends one burst of six quotes); the check passes on the recorded burst

## Reproduce
Send five quote requests within ~260 ms and a sixth at ~450 ms, when a 5-per-second token bucket would have two tokens again.

## Expected / actual
- Expected: the docs' table (10/1) says "Per Endpoint | 5 RPS (default) | 1 s | `X-OC-Used-Weight`" and nothing on how the window moves; a client that keeps to 5 per second gets no 429.
- Actual: `x-oc-ratelimit-remaining` 4 → 3 → 2 → 1 → 0, and the sixth request, 422 ms after the first, got HTTP 429 / 42900 "Rate limit exceeded", `Retry-After: 1`. Our token-bucket client met 44 such 429s in 65 minutes of tape.

## Impact
Every client has to find the window type by trial. Ours now keeps a sliding window of 5 requests per 1,000 ms plus 250 ms (`packages/binance/src/rate-limit.ts`); the next tape run (01:54:58 UTC) had 0 429s and 0 retries.

## Evidence
`fixtures/trading/getAggregatedQuote-20260924-1.json` … `-6.json` (headers and times); api_calls `http_status = 429`, 44 rows.

## Ask
Document the window type and its reference time, and send a reset header such as `X-OC-RateLimit-Reset`.
