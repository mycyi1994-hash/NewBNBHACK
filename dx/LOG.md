# dx/LOG.md — Developer experience log (chronological, append-only)

Format: `docs/DX_PROTOCOL.md` §3.1. The agent writes facts only (Expected, Actual, Evidence); humans add a `- Impression:` line.
Times are UTC. Tags: `[web3api|baw|skill|bag|chain|defi|rwa|trading|tx|wallet|b402][auth|docs|error|latency|edge|missing]`.
> Entries up to 2026-09-27 were written in Korean and translated to English on 2026-09-27; facts, numbers and evidence are unchanged.

---

## 2026-09-23 — Project start (planning)
- Obtained the rules, scoring criteria and resource list from the official competition page, and read the Binance Skills Hub (`binance-agentic-wallet` v1.12.0, `binance-tokenized-securities-info` v1.1).
- In the planning environment, `web3.binance.com`, `developers.binance.com` and `bnbchain.org` were blocked by network policy, so we could not read the official docs directly. Endpoints and signing conventions were taken from earlier builders' notes and all marked ⚠️VERIFY.
- From the next entry on, we record actual development experience: portal login time → key issuance time → first unsigned call → first signed call.

## 2026-09-23 17:44 UTC — [web3api][docs] llms.txt and llms-full.txt return HTTP 202 + an empty body to curl (AWS WAF challenge)
- Goal: fetch the official LLM-oriented docs with `bash scripts/fetch-docs.sh` (M0-02).
- Expected: `https://web3.binance.com/en/dev-docs/llms.txt` and `…/llms-full.txt` return 200 + Markdown.
- Actual: both URLs return `HTTP/2 202`, `x-amzn-waf-action: challenge`, `content-length: 0` (CloudFront POP IAD12). Same with a browser UA. `curl -f` treats 202 as success, so the original script would have **created an empty file and exited successfully**. Opened in headless Chromium: first response 202 → 200 after the challenge script runs (llms.txt 11,485 chars, llms-full.txt 425,947 chars and 8,416 lines, ~5.5 s each).
- Docs: llms-full.txt § llms.txt — "Download and use as context" (around L914). It is a file meant for LLMs and agents, yet non-browser clients cannot fetch it.
- Time lost: about 15 min (finding the cause + writing the browser fallback).
- Workaround: `scripts/fetch-docs.sh` checks for 200 and Markdown, and on failure fetches with `scripts/fetch-docs-browser.mjs` (Playwright Chromium).
- Ask: exempt `/en/dev-docs/*.txt` and `*.md` from the WAF challenge, or return a 4xx instead of 200 when challenging.
- Evidence: curl header output from this session (values above), `docs/vendor/llms-full.txt` sha256 `ea604b558bd3349c…` (received 2026-09-23 17:52 UTC). Environment: US-based cloud sandbox egress (not a Korean network connection).

## 2026-09-23 17:51 UTC — [web3api][docs] No request body schema anywhere for `POST /api/v1/dex/market/price` (the connector cannot send a body either)
- Goal: implement the Market price batch call in `pnpm reach` (M0-03).
- Expected: field definitions for the batch body (up to 100 items).
- Actual: llms-full.txt has only "Supports batch queries, up to 100 tokens per request" (L3307) and "Batch request list exceeds 100 items" (L3392). The API Reference entry (L7757) has no parameter table. In the official connector `@binance-web3/wallet@12.3.0`, `GetTokenPriceRequest` has only `recvWindow` and `nonce`, and the builder `getTokenPrice` (dist/index.mjs L1651) always sets the body to `{}` → this endpoint cannot be used through the typed method. Same for `getTokenTradingInfo` (L1693, `POST /price-info`) and `getTokenBasicInfo` (L1609, `POST /token/basic-info`).
- Docs: llms-full.txt § Introduction (Market API) › General Data; § API Reference › General Data › "Get Token Price".
- Time lost: 20 min.
- Workaround: an array body inferred from the response fields (`binanceChainId`, `tokenContractAddress`) is marked "UNVERIFIED — DECISIONS V-09" in `pnpm reach`, to be confirmed by a G1 live call. Connector users can work around it with `restAPI.sendSignedRequest(path, 'POST', {}, body)`.
- Ask: add the request body schema for the three POST endpoints to the docs and to the OpenAPI spec (the connector's generation source).
- Evidence: `docs/vendor/ENDPOINTS.md` "Doc ↔ connector anomalies" (detected automatically by `pnpm endpoints`), DECISIONS V-09.

## 2026-09-23 17:51 UTC — [web3api][auth] The connector sends recvWindow and nonce under header names that differ from the docs
- Goal: cross-check the signing headers against two sources, the docs and the connector (M0-02 V-04).
- Expected: `X-OC-RECV-WINDOW` and `X-OC-NONCE`, as documented.
- Actual: the connector builder sets them as `localVarHeaderParameter["recvWindow"]` and `["nonce"]` (dist/index.mjs L336, and likewise in every operation), so **headers named `recvWindow` and `nonce`** go out. The docs do not say whether the gateway recognizes these names.
- Docs: llms-full.txt § Authentication › Step 2 — Understand Required Headers(L144).
- Time lost: 0 (found while cross-checking).
- Workaround: our client sends the documented names (`X-OC-RECV-WINDOW`, `X-OC-NONCE`). Whether they are actually accepted will be checked in G1 with a call that changes `recvWindow`.
- Ask: make the connector's header names match the docs, or document the aliases.
- Evidence: `packages/binance/node_modules/@binance-web3/wallet/dist/index.mjs` L336.

## 2026-09-23 17:53 UTC — [tx][edge] Connector `simulateTransactions()` requires all of evmTx, solTx and tronTx
- Goal: confirm the Transaction API simulation parameters (SPEC §5.8).
- Expected: pass only the one tx for the chain in question.
- Actual: the connector type description says "`evmTx`, `solTx`, and `tronTx` are marked required in this schema for rendering purposes only; in practice supply exactly one", but the builder (dist/index.mjs L2962) enforces all three with `assertParamExists` → passing only EVM gives `RequiredError`. Passing all three puts all three in the body.
- Docs: connector `SimulateTransactionsRequest` description; llms-full.txt has no description of the simulate parameters (§ API Reference › Transaction API › "Simulate Transactions", L8106).
- Time lost: 0.
- Workaround: call it directly with our own client (EVM tx only).
- Ask: express it as `oneOf` in the OpenAPI spec and remove the connector's required-parameter check.
- Evidence: source location above, `docs/vendor/ENDPOINTS.md` Transaction API table.

## 2026-09-23 17:53 UTC — [trading][auth] Connector `getRfqOrderStatus()` puts a JSON body on a GET and signs it
- Goal: confirm the path for querying RFQ order status.
- Expected: per the docs, the signed body of a GET is `""` (§ Authentication › 3.1, L193).
- Actual: the builder (dist/index.mjs L2466) puts `orderId` in the path and also in the body → `GET /build/api/v1/dex/aggregator/order/{orderId}` carries a `{"orderId":"…"}` body and is signed with that body. If the server verifies with the GET body taken as `""`, it would fail with 40102 (not confirmed with a live call).
- Docs: § Integration Flow (Trading API) › RFQ Mode (L2678).
- Time lost: 0.
- Workaround: our client refuses a GET body (`client.test.ts` "never sends a GET body").
- Ask: remove path parameters from the body in the connector.
- Evidence: `packages/binance/src/signature-vectors.test.ts` "documents a connector anomaly…" (a test pins down that the connector really does send the body).

## 2026-09-23 17:55 UTC — [web3api][docs] The signing examples use methods and paths that do not exist
- Goal: confirm the signing string rules (V-02).
- Expected: the examples use real endpoints.
- Actual: the GET example is `GET /build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT` (L220, L311), but `/market/price` in the API Reference is **POST** (L7757) and has no `chainId` or `symbol` parameters (the chain parameter is named `binanceChainId`). The POST example path `/build/api/v1/dex/swap` (L231) is not in the API Reference (swap is `GET /api/v1/dex/aggregator/swap`).
- Docs: llms-full.txt § Authentication › 3.1 Build the Pre-Hash String, Step 4 — Send the Request.
- Time lost: 5 min.
- Workaround: the signing rule itself was verified against the example strings and the connector's output (the docs pre-hash test in `signature-vectors.test.ts`).
- Ask: replace the examples with a real endpoint (e.g. `GET /api/v1/dex/market/rwa/tokens?binanceChainId=56`) and a known secret→signature pair.
- Evidence: line numbers above (snapshot sha256 `ea604b558bd3349c…`).

## 2026-09-23 17:58 UTC — [web3api][error] Which HTTP status an error comes back with differs from page to page
- Goal: design the envelope parser (V-05).
- Expected: a single rule.
- Actual: § Authentication › Error Codes (L407) gives 40001=400, 40101~40103=401, 40104=403, 42900=429, 50000=500, 50001=503. By contrast, the Market (L3358), Trading (L2954), Transaction (L1990) and Wallet (L1844) error pages say "All … responses — including errors — return HTTP 200" and also list 40101~40104 and 42900 in the same table. DeFi (L4241) says "gateway-layer errors are not returned as HTTP 200 — 401, 429". The error body example in Authentication has no `success` field (L422).
- Docs: each section above.
- Time lost: 10 min.
- Workaround: decide by the body `code` regardless of HTTP status; no envelope means a transport error (`packages/binance/src/envelope.ts`, test `envelope.test.ts`).
- Ask: state the HTTP status of gateway errors and business errors in a single table.
- Evidence: 1 live measurement — an unsigned GET gives HTTP 401 + body `code 40101` (18:16 entry below).

## 2026-09-23 17:58 UTC — [web3api][docs] The rate limit response header table cannot be interpreted
- Goal: design the token bucket and 429 handling (V-06).
- Expected: headers that give the limit and the remaining count per dimension.
- Actual: the table (L396–401) maps one header to each dimension: Per IP → `X-OC-RateLimit-Limit`, Per API Key → `X-OC-RateLimit-Remaining`, Per User and Per Endpoint → `X-OC-Used-Weight`. Limit/Remaining are kinds of value, not dimensions, so there is no telling which dimension a value belongs to. Only the unit of `Retry-After` on a 429 (seconds) is clear.
- Docs: llms-full.txt § Authentication › Rate Limits.
- Time lost: 5 min.
- Workaround: on a 429, pause every bucket for `Retry-After` (`rate-limit.ts` `pause`); header values are recorded raw in api_calls and the responses.
- Ask: state which dimension each header's value belongs to (or provide per-dimension headers).
- Evidence: L396–401.

## 2026-09-23 18:00 UTC — [b402][docs] B402 responses are an exception to the "OCResult for every endpoint" rule
- Goal: confirm the envelope of each module.
- Expected: the Overview's `OCResult<T>` `{code:number, msg, data, timestamp, success}` (L94).
- Actual: the B402 success code is the string `"000000000"` (L4855); error codes are `1160101…1160409`. The B402 response in the connector types is `{status, type, code: string, errorData, data, subData, params}`, with no `msg` or `success`. llms-full.txt has no description of these envelope fields (they exist only in the connector types). The request body must also be wrapped once, as `{"body": {...}}`.
- Docs: § Overview › Unified Response Format; § Integration Guide (B402) › Read and Cache Supported Configurations(L4881); § Error Codes (B402)(L5057).
- Time lost: 10 min.
- Workaround: a per-module parser (the `b402` branch in `envelope.ts`, which keeps the string code).
- Ask: state the B402 exception and its envelope fields in the Overview.
- Evidence: `docs/vendor/ENDPOINTS.md` §2.

## 2026-09-23 18:00 UTC — [defi][docs] DeFi example values do not fit a BSC-only API
- Goal: confirm the shape of the deposit build response (Q-05).
- Expected: BSC examples.
- Actual: `token.tokenAddress` in the deposit request example is `0xdac17f958d2ee523a2206206994597c13d831ec7` (Ethereum mainnet USDT, L3774), but the DeFi API supports only BSC (L3496). The `data` of the `DEPOSIT` item in the response example is `0xa9059cbb…` (L3803) — the ERC-20 `transfer(address,uint256)` selector. The docs say "APPROVE … to the spender contract returned in that item's `to`" (L4130), but the example's APPROVE `to` is the token contract (L3790) and the spender is inside the calldata.
- Docs: § Integration Flow (DeFi API) › Step 2 — Build the Transaction; › Calldata Validity & Approvals.
- Time lost: 10 min.
- Workaround: in M0-07 we plan to capture a real build response as a fixture, decode the APPROVE calldata and confirm the spender.
- Ask: replace them with a real response example that uses BSC values.
- Evidence: line numbers above.

## 2026-09-23 18:00 UTC — [defi][edge] DeFi build's APPROVE offers only an unlimited approval
- Goal: use exact-amount approvals in the deposit flow (CLAUDE.md rule 5).
- Expected: an option to approve just the amount.
- Actual: "APPROVE is an unlimited allowance — … approves the maximum amount (`type(uint256).max`)" (L4130). No parameter to set the amount (not in the connector's `BuildDeFiDepositTransactionRequest` either). Trading `/approve-transaction` accepts `approveAmount` (L2416).
- Docs: § Integration Flow (DeFi API) › Calldata Validity & Approvals.
- Time lost: 0.
- Workaround: awaiting a decision — DECISIONS Q-16 (instead of the APPROVE item, encode an exact-amount approve to the same spender ourselves).
- Ask: add `approveAmount` (or an exact mode) to DeFi build.
- Evidence: L4130, `docs/DECISIONS.md` Q-16.

## 2026-09-23 18:00 UTC — [defi][error] Error code 40470 means different things in different modules
- Goal: collect the inputs for the error taxonomy (SPEC §11).
- Expected: one meaning per code.
- Actual: DeFi `40470` = "Requested DeFi resource not found" (L4332), Trading `40470` = "Tax token cannot configure referral fee on the same side" (L3079). The DeFi page says its range "does not collide with the DEX Swap range 40461–40469" (L4342) — 40470 is outside that range, so it does in fact collide.
- Docs: § Error Codes (DeFi API) › DeFi Data Query Errors; § Error Codes (Trading API) › Custom Fee.
- Time lost: 0.
- Workaround: identify errors by (module, code) (`BinanceApiError.module`, api_calls.module).
- Ask: publish a global code registry.
- Evidence: line numbers above.

## 2026-09-23 18:01 UTC — [defi][docs] Amount and time units differ by module
- Goal: settle the amount math rules (prep for M0-07 `amounts.ts`).
- Expected: units common to all modules.
- Actual: Trading `amount` is an integer string in the smallest unit (connector `GetAggregatedQuoteRequest.amount` "1000000 = 1 USDT (decimals=6)"). DeFi uses "Amounts: Human-readable decimal strings (e.g. "1000.5"), not the token's smallest unit" (L3684) and "Timestamps: Unix time in seconds" (L3685). Envelope and RWA times are in ms.
- Docs: § DeFi Introduction › Data Format Conventions.
- Time lost: 0.
- Workaround: amount types will be split by module (M0-07). Noting the risk of a 10^18x mistake.
- Ask: unify units across all modules, or put the unit in the field name.
- Evidence: L3684–3685.

## 2026-09-23 18:01 UTC — [tx][docs] The broadcast body is described differently on the error page and in the flow docs
- Goal: confirm the shape of the broadcast request (Q-14).
- Expected: one body.
- Actual: among the causes of 40001, the Transaction API error page lists "Broadcast request is missing both `evmTx` and `solTx` (one is required)" (L2024). The Trading and DeFi integration flows and the connector use `{binanceChainId, address, signedTransaction, enableMevProtection}` (L2575, L4065).
- Docs: § Error Codes (Transaction API) › Parameter Errors; § Integration Flow › Step 5.
- Time lost: 0.
- Workaround: follow the shape from the flow docs and the connector; confirm with a G1/M1-03 live call.
- Ask: fix the error description (it probably belongs to simulate).
- Evidence: line numbers above.

## 2026-09-23 18:02 UTC — [trading][docs] An Ondo-suffix token in the bStock example
- Goal: confirm the rule for telling tokens apart by issuer (prep for M0-05).
- Expected: the examples match the suffix rule (Ondo `…on`, bStock `…B`, xStocks `…x`, L7430–7432).
- Actual: "BStock tokens (type=3): Exchange-traded stock tokens (e.g. PALLon/Palladium, TSLAB/Tesla)" (L2242) — `PALLon` has the Ondo suffix.
- Docs: § Introduction (Trading API) › Equity Token Trading (RWA).
- Time lost: 0.
- Workaround: determine the issuer from `platformId` in the RWA list, not from the suffix (M0-05).
- Ask: fix the example.
- Evidence: L2242.

## 2026-09-23 18:03 UTC — [rwa][docs] RWA response field descriptions are not in llms-full.txt, only in the connector types
- Goal: confirm the definition of the reference price for the price gap guard (SPEC §5.5) (Q-06).
- Expected: response field descriptions in the RWA Data section.
- Actual: llms-full.txt describes RWA only with a feature table (L3332–3341) and one line in the API Reference. The key definition that `referencePrice` is "A per-share converted price derived from the on-chain token price, not an official quote from the traditional stock market", `statusInfo` (openState, marketStatus, reasonCode, reasonMsg, nextOpenTime) and `tokenToShareRatio` exist only in comments in the connector's `index.d.mts`.
- Docs: § Introduction (Market API) › RWA Data; § API Reference › RWA Data.
- Time lost: 10 min.
- Workaround: `pnpm endpoints` extracts the fields from the connector types and writes them to ENDPOINTS.md.
- Ask: include per-endpoint parameter and response field tables in llms-full.txt.
- Evidence: `docs/vendor/ENDPOINTS.md` §3 and RWA table, DECISIONS Q-06.

## 2026-09-23 18:12 UTC — [web3api][auth] The docs' JS signing helper signs different bytes than it sends for a query containing `'` (presumed, not yet measured)
- Goal: guarantee that the signed string = the sent string (V-02).
- Expected: following the docs example is safe.
- Actual: the docs' JS helper builds the query with `encodeURIComponent` (L332). `encodeURIComponent("'")` leaves `'` as is, but the WHATWG URL parser (Node fetch, axios's `new URL`) sends a `'` in the query as `%27` → with a value like `keyword=McDonald's`, the signed path and the sent path differ, and 40102 is expected. Offline repro: `new URL("https://h/p?q='").search === "?q=%27"`. The connector builds the query with URLSearchParams and signs that result, so it has no problem (a space becomes `+`).
- Docs: § Authentication › Complete JavaScript Example.
- Time lost: 10 min.
- Workaround: our encoder does strict RFC 3986 encoding (encoding even `!'()*`) + a `new URL()` round-trip check before sending (`sign.ts` `buildTarget`, `sign.test.ts`).
- Ask: change the example to "take path+query from the URL string that will be sent, and sign that".
- Evidence: `packages/binance/src/sign.test.ts` "encodes the apostrophe…". Server-side confirmation in G1 (a keyword containing `'` on `rwa/search`).

## 2026-09-23 18:16 UTC — [web3api][auth] First call (unsigned): HTTP 401, code 40101 "API Key is required", 641 ms
- Goal: confirm unsigned reachability with `pnpm reach` (M0-03).
- Expected: reach the gateway without a key; per the docs, the 40101 message is "Invalid API Key" (L1890).
- Actual: `GET https://web3.binance.com/build/api/v1/dex/market/supported/chain` → HTTP 401, body `code 40101`, msg `"API Key is required"`, 641 ms (rerun 374 ms), clock skew +454 ms against the response `timestamp`. No WAF challenge on the API path (unlike the docs site). No region-block code (40301) — but this call went out from a **US-based cloud sandbox** and was a keyless request, so it may not have reached the region check stage. Not a result from a Korean network connection (Q-01 is covered in M0-04).
- Docs: § Authentication › Error Codes; § Error Codes (Market API) › Authentication & Authorization Errors.
- Time lost: 0.
- Workaround: none.
- Ask: make the 40101 message match the docs (or document the message variants).
- Evidence: `pnpm reach` output (REGION_TAG unset), 1 row in `api_calls` in the sandbox's local DB (`market/getSupportedChains`, 401, 40101) — not committed.

## 2026-09-23 18:20 UTC — [web3api][latency] Connector default timeout 1,000 ms and 3 retries (needs live measurement)
- Goal: decide the default timeout.
- Expected: a default that suits slow calls such as quotes.
- Actual: `@binance/common@2.4.9` `ConfigurationRestAPI` defaults: `timeout: param.timeout ?? 1e3` (dist/index.mjs L672), `retries 3`, `backoff 1000`. If any endpoint's real p95 is over 1 s, connector users will hit timeouts with the defaults. The unsigned call above took 641 ms, so signed and quote calls need live measurement.
- Docs: llms-full.txt does not mention the connector timeout (§ JavaScript, L1096).
- Time lost: 0.
- Workaround: our client defaults to 15 s; the latency of every call is recorded in api_calls, and we judge by p95.
- Ask: publish a recommended timeout and per-endpoint latency targets in the docs.
- Evidence: source location above. p50/p95 from `pnpm dx:metrics` (after G1).

## 2026-09-24 00:03 UTC — [web3api][auth] Developer portal → API key issued
- Goal: get a Web3 API key issued (M0-00)
- Expected:
- Actual: portal opened at 00:00 UTC, key issued at 00:03 UTC. Where we got stuck:
- Docs: https://web3.binance.com/en/dev-docs/authentication
- Time lost:
- Workaround:
- Ask:
- Evidence:
- Impression:

## 2026-09-24 00:17 UTC — [web3api][auth] First signed call succeeded (Korean dev PC): RWA list and price batch both 200
- Goal: confirm signed-call reachability with `pnpm reach` (M0-03, M0-04 (a) Korean dev machine).
- Expected: a request signed as documented gets HTTP 200 and `code 0`; no region or IP block codes (40301~40303) on a Korean network connection.
- Actual: run on the user's PC (Windows, Node v24.14.1, REGION_TAG=kr-dev) at 2026-09-24T00:17:25Z.
  - Unsigned `GET /api/v1/dex/market/supported/chain` → HTTP 401, code 40101 "API Key is required", 139 ms.
  - Signed `GET /api/v1/dex/market/rwa/tokens?binanceChainId=56` → HTTP 200, code 0, 186 ms, 488 tokens (platformId `ondo` 442, `bstock` 46). No other platformId (xStocks etc.) in the BSC list.
  - Signed `POST /api/v1/dex/market/price`, body `[{"binanceChainId":"56","tokenContractAddress":"0x…"}]` with 3 entries (no schema in the docs or the connector, DECISIONS V-09) → HTTP 200, code 0, 58 ms, 3 prices (SOXSon, CRWDon, PANWon).
  - Clock skew +342 ms against the response `timestamp`. An `x-amz-cf-id`-style value was captured as the request id (no request id header in the docs).
  - Passed with no signature errors (40102) or timestamp errors (40103); no region or IP block codes.
- Docs: llms-full.txt § Authentication; § Introduction (Market API) › General Data (price batch body not documented).
- Time lost: 0 on the Binance side. The api_calls write failure in the same run was a local DB configuration problem (a different PostgreSQL answered on port 5432, 28P01), unrelated to Binance.
- Workaround: for the price batch body we used the array format inferred from the response fields, and it was accepted.
- Ask: add the request body schema for `POST /market/price`, `/price-info` and `/token/basic-info` to the docs.
- Evidence: `pnpm reach` output on the user's PC (shared in the conversation, 2026-09-24 00:17:25 UTC). The api_calls rows appear on a rerun after the local DB is fixed.

## 2026-09-24 00:28 UTC — [web3api][telemetry] First successful api_calls write (Korean dev PC)
- Goal: record every `pnpm reach` attempt in api_calls (M0-03 acceptance).
- Expected: the same results as the first signed call at 00:17 + `api_calls: 3 rows recorded`.
- Actual: the 00:28:12 UTC run recorded 3 rows (id 1–3: getSupportedChains 401/40101 128 ms, getRwaTokenList 200/0 144 ms, getTokenPrice 200/0 64 ms, region kr-dev, request ids all filled in). The 00:37:01 rerun added 3 rows → `SELECT count(*) FROM api_calls; → 6` (00:37:35 UTC).
- Earlier error: in the 00:17 run, only the api_calls write failed — PostgreSQL `28P01` (password authentication failed). Cause: a different PostgreSQL instance was running on port 5432, which DATABASE_URL pointed to. Fixed by moving the local DB to 5433. Binance-side errors (40102 signature, 40103 timestamp, 4030x region): 0, both before and after the first signed call.
- Docs: not applicable (local setup).
- Time lost: [HUMAN]
- Workaround: DATABASE_URL port 5433.
- Ask: none.
- Evidence: `pnpm reach` output (00:37:01 UTC) `api_calls: 3 rows recorded`; `pnpm db:count`.

## 2026-09-24 00:41 UTC — [rwa][onchain] The bStocks multiplier function names are not in the docs — found them in the bytecode
- Goal: read the bStocks `uiMultiplier` (M0-05, DECISIONS Q-13).
- Expected: the on-chain ABI (multiplier function names) is in llms-full.txt or the RWA API description.
- Actual: not in the docs. NVDAB (`0x02fc…7436`) is a beacon proxy (EIP-1967 beacon slot → `0x156d…93a3`, `implementation()` → `0xCFEd…4e46`). Found `uiMultiplier()`, `newUIMultiplier()` and `effectiveAt()` among the PUSH4 selectors of the implementation bytecode. NVDAB uiMultiplier `1000778223752807865` (1e18 scale) = API `tokenToShareRatio` `1.000778223752807865`, effectiveAt 0. Ondo NVDAon (beacon `0xc046…3315`, implementation `0x578f…50fd`) does not have these functions → for Ondo, the only multiplier is the API `tokenToShareRatio`.
- Docs: no field description in llms-full.txt § RWA; connector `GetRwaTokenListResponseDataInner.tokenToShareRatio`.
- Time lost: [HUMAN]
- Workaround: scanned the bytecode selectors, then `packages/chain` `readBstockMultiplier`.
- Ask: document the bStocks token ABI (functions for the multiplier, the scheduled multiplier and the effective time) in the RWA docs. If the Ondo multiplier has an on-chain source, document it.
- Evidence: `pnpm registry` output (00:45:40 UTC) `uiMultiplier … = API tokenToShareRatio …`, 4 cases.

## 2026-09-24 00:45 UTC — [rwa] statusInfo differs by issuer: for bStocks, marketStatus and nextOpen/Close are null
- Goal: decide the regular-session window from the market status (SPEC §5.2).
- Expected: every RWA token's `statusInfo` has `marketStatus` and `nextOpenTime`/`nextCloseTime`.
- Actual: the 5 Ondo tokens have `marketStatus:"overnight"`, `nextCloseTime 1790236500000` (2026-09-24T07:55Z), `nextOpenTime 1790236860000` (08:01Z) — the boundaries of Ondo's 24/5 session, not of the regular session. The 4 bStocks have `openState:true, marketStatus:null, reasonCode:"TRADING", nextOpenTime:null, nextCloseTime:null` (TRADING even at 00:45Z, which is US off-hours).
- Docs: connector `GetRwaTokenListResponseDataInnerStatusInfo` (list of values only, no explanation of the differences between issuers).
- Time lost: [HUMAN]
- Workaround: the tape also records a `session` tag based on our own clock (regular/pre/post/overnight/weekend/holiday, America/New_York) (`packages/core/src/session.ts`).
- Ask: document what statusInfo means for each issuer and when it is null.
- Evidence: `fixtures/rwa/getRwaTokenList-20260924-1.json`; tape_samples `market_status` column.

## 2026-09-24 00:46 UTC — [trading] M0-06 small-amount quote table (off-hours, US overnight)
- Goal: $1/$5/$50 USDT quotes for NVDA and QQQ × bStocks and Ondo (M0-06).
- Expected: as documented, Ondo is RFQ and bStock is a SWAP/RFQ mix; the Ondo minimum amount is in msg (example "20 USD").
- Actual: 2026-09-24T00:46:45Z, US session overnight (not the regular session), `userWalletAddress`=house wallet.

| instrument | USD | expectedOut (tokens) | implied USD/token | priceImpact % | vendor / mode | route | error | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NVDAB | 1 | 0.004442430800471653 | 225.1020 | 0.0000000000 | LiquidMesh/SWAP | Kipseli 100.00% | — | 138 |
| NVDAB | 5 | 0.022212154002358266 | 225.1020 | 0.0000000000 | LiquidMesh/SWAP | Kipseli 100.00% | — | 59 |
| NVDAB | 50 | 0.222121540023582663 | 225.1020 | 0.0000000000 | LiquidMesh/SWAP | Kipseli 100.00% | — | 60 |
| NVDAon | 1 | — | — | — | — | — | 40375 "Minimum order amount is 5 USD." | — |
| NVDAon | 5 | — | — | — | — | — | 40375 "Minimum order amount is 5 USD." | — |
| NVDAon | 50 | 0.221892762466632448 | 225.3341 | 0.0000149702 | LiquidMesh/SWAP | Rfq Halfmoon 100.00% | — | 293 |
| QQQB | 1 | 0.001349947465289318 | 740.7696 | 0.0000000000 | LiquidMesh/SWAP | Kipseli 100.00% | — | 71 |
| QQQB | 5 | 0.006749737326446592 | 740.7696 | 0.0000000000 | LiquidMesh/SWAP | Kipseli 100.00% | — | 58 |
| QQQB | 50 | 0.067496698353477741 | 740.7770 | 0.0000000000 | LiquidMesh/SWAP | Kipseli 100.00% | — | 53 |
| QQQon | 1 | — | — | — | — | — | 40375 "Minimum order amount is 5 USD." | — |
| QQQon | 5 | — | — | — | — | — | 40375 "Minimum order amount is 5 USD." | — |
| QQQon | 50 | 0.067266855205420944 | 743.3081 | -0.0000000000 | LiquidMesh/SWAP | Rfq Halfmoon 100.00% | — | 285 |

  - Additional measurement (00:48 UTC): NVDAon $5.01, $5.05, $5.10, $6 → quote OK. $5.00 rejected, $5.01 passes — unconfirmed whether "5 USD" is a strictly-greater-than condition or an effect of conversion at the USDT unit price (0.99975). NVDAB $0.10 also quotes OK (no bStock minimum observed).
  - Ondo is also `LiquidMesh/SWAP` (dex name "Rfq Halfmoon"), and its `/swap` response is also `executionMode SWAP`, with `tx` present and `rfq` null — unlike the docs' "Ondo is always RFQ".
  - Yet leaving `userWalletAddress` out of an Ondo quote gives `40001 "userWalletAddress is required for RFQ (Ondo) quote"` (bStock is OK without it).
  - priceImpact values include a negative 0, `"-0.0000000000"`.
- Docs: § Introduction (Trading API) › Equity Token Trading (L2235); § Error Codes (Trading API) › RFQ Orders (L3092).
- Time lost: [HUMAN]
- Workaround: the tape and the decisions record and use the response's `executionMode` as is (not inferred from the issuer). Minimum amounts are observed on the tape.
- Ask: document when the Ondo route comes back as SWAP, the minimum-amount comparison rule (≥ vs >, the basis for USD conversion) and the priceImpact sign rule.
- Evidence: `pnpm spike:quotes` output; `fixtures/trading/getAggregatedQuote-20260924-*.json` (wallet address `[redacted]`).

## 2026-09-24 00:52 UTC — [trading] quoteId TTL measured: /swap after 35 s → 40401
- Goal: confirm the Q-04 quote validity period. `/swap` only builds calldata (no signing or broadcast).
- Expected: documented TTL of 30 s.
- Actual: `/swap` right after an NVDAB $50 quote: OK (96 ms, `executionMode SWAP`, `tx.to 0xB444…DdA5`); the same quoteId 35 s later → `40401 "quoteId=… not found or expired"` (109 ms). Same for NVDAon (0 s OK 100 ms, 35 s 40401 84 ms).
- Docs: § Key Constraints (L2276) — matches.
- Time lost: 0.
- Workaround: not applicable. The re-quote threshold is under 30 s.
- Ask: none.
- Evidence: `fixtures/trading/buildSwapTransaction-20260924-*.json`.

## 2026-09-24 00:55 UTC — [rwa] referencePrice = tokenPrice ÷ tokenToShareRatio (exactly)
- Goal: measure the Q-06 reference price definition live.
- Expected: derived from the on-chain price, as the connector description says.
- Actual: in the latest tape rows, for all 9 instruments, the relative error between `tokenPrice / multiplier` and `referencePrice` is ≤ 5.4e-10 (e.g. NVDAB 224.695137 = 224.695137). It is the on-chain price converted per share, not an independent market price.
- Docs: matches the connector's `GetRwaTokenPriceResponseDataInner.referencePrice` description; no field description in llms-full.txt.
- Time lost: 0.
- Workaround: with this value, the SPEC §5.5 gap guard (`onchain/reference − 1`) is always ≈0 — needs a human decision (DECISIONS Q-06).
- Ask: document how it relates to an independent underlying-asset market price (`marketData` from underlying-market).
- Evidence: tape_samples ⨝ instruments query (00:55 UTC).

## 2026-09-24 00:49 UTC — [defi] Venus USDT: poolAddress null, simulate=true rejects an unfunded address with 40484, APPROVE is unlimited
- Goal: M0-07 — Venus info, the USDT investment item, deposit and redeem calldata, Transaction API simulation (no broadcast).
- Expected: investment detail has the vToken address (`poolAddress`); build with `simulate=true` returns a `preview`.
- Actual:
  - protocol/detail venus: securityScore `"93.1"`, TVL `1353914642`, dimensionScores codeSecurity 96 / fundamentalHealth 92.5 / operationalResilience 84.96 / communityTrust 98 / governanceStrength 88.45 / marketStability 94.18 (458 ms).
  - investment/list(Earn, venus, BSC, USDT) → 1 item `investmentId 5b77bfd8…63cb` "USDT", `apyBps 316` (3.16%), `tvl 185541887.44`. detail is the same, with `poolAddress: null`.
  - position/list(house) → `{"totalValue":"0","addressList":[]}` (1,664 ms — the longest this session).
  - deposit 1 USDT `simulate=true` → HTTP 200 `40484 "Insufficient balance…"`; redeem `simulate=true` → the same code, `40484 "You don't have any position in this investment product."` (same code for a different cause). With `simulate=false`, both return code 0: deposit `dataList` = APPROVE, DEPOSIT; redeem = REDEEM, `redeemDelayDays []` (immediate).
  - APPROVE decoded: `USDT.approve(spender 0xfD58…0255, type(uint256).max)` — unlimited (Q-16). DEPOSIT `to` = the same `0xfD58…0255`, selector `0xa0712d68` = `mint(uint256)`. REDEEM selector `0xdb006a75` = `redeem(uint256)` (in vToken units). The DEPOSIT/REDEEM items have no `gasLimit`.
  - On-chain (block 123664140): `0xfD5840Cd36d94D7229439859C0112a4185BC0255` `symbol()`=vUSDT, decimals 8, `underlying()`=USDT. exchangeRateStored `265115854764046092440821898` (1 vUSDT = 0.026511585 USDT), cash 50,523,730.69 / borrows 135,119,487.09 / reserves 52.89 → utilization 72.78%. Comptroller `0xfD36…8384` actionPaused MINT=false REDEEM=false. supplyRatePerBlock `445461184` → 1.89% a year compounded per block (assuming 0.75 s blocks, 42,048,000/year) — 1.27%p off from the API apyBps 316 (3.16%) (cause unconfirmed: the docs do not say whether rewards are included, and the block-count assumption is also unverified).
  - Transaction API simulate (house address, balances USDT 0, BNB 0): APPROVE → `status SUCCESS`, allowanceChanges `preAmount 0 → postAmount 1157…9935` (unlimited) (93 ms); DEPOSIT → `status FAILED`, `failReason "execution reverted: BEP20: transfer amount exceeds balance"` (114 ms); REDEEM → `FAILED "execution reverted: math error"` (127 ms). The simulation is single-tx, so the APPROVE result does not carry over to DEPOSIT.
- Docs: § Integration Flow (DeFi API) › Step 2, Step 3 (L3755, L3820), › Calldata Validity & Approvals (L4119); § Error Codes (DeFi API).
- Time lost: [HUMAN]
- Workaround: take the vToken address from the DEPOSIT item's `to` and verify it on-chain with `symbol()/underlying()` (`scripts/spike-venus.ts`). For an unfunded wallet, get the calldata with `simulate=false`.
- Ask: fill in the vToken address in investment detail; separate codes for each cause of 40484; multi-tx (approve→deposit) simulation or state override; state the APY composition (base interest vs rewards); an exact-amount approve option.
- Evidence: `pnpm spike:venus` output; `fixtures/defi-data/*-20260924-*.json`, `fixtures/defi-transaction/*-20260924-*.json`, `fixtures/transaction/simulateTransactions-20260924-{1,2,3}.json` (house address `[redacted]`).

## 2026-09-24 01:50 UTC — [tape] Local tape ran for 64 min: 9 runs × 27 rows
- Goal: M0-08 local — every 10 min, 9 instruments × $5/$50/$500 quotes plus prices and market status into tape_samples.
- Expected: 27 rows per run; errors only with documented codes.
- Actual: 9 runs and 243 rows from 00:45:51Z (`pnpm tape:once`) to 01:50:00Z; `tape_samples` count 54 (00:46:26Z) → 81 (00:59:37Z) → 243 (01:50:31Z). 27 rows per run; recorded quote errors: 5 rows = 5 Ondo instruments × $5 `40375 "Minimum order amount is 5 USD."`. One run takes about 13 s (27 quotes in sequence). Session tags all `overnight`. However, as described in the entry below, every run had 429s mixed in (all recovered by retry); fixed after 01:52.
- Docs: not applicable.
- Time lost: 0.
- Workaround: see the entry below.
- Ask: none.
- Evidence: agent console log (`tape: 2026-09-24T01:50:00.007Z 27 rows …`); `pnpm db:count`.

## 2026-09-24 01:52 UTC — [web3api][ratelimit] 429 despite keeping to 5 RPS per endpoint: the gateway uses a sliding 1-second window
- Goal: confirm rate limit compliance (5/s per endpoint).
- Expected: with a client token bucket (capacity 5, 5 per second), no 429.
- Actual: 00:45–01:50 UTC, `getAggregatedQuote` got HTTP 429 / `42900 "Rate limit exceeded"` 44 times (about 5 per tape run), `Retry-After: 1`, all 200 after 1 retry. Header records (`fixtures/trading/getAggregatedQuote-20260924-1…6.json`): from 00:46:45.311Z at 65 ms intervals, `x-oc-ratelimit-remaining` 4→3→2→1→0, and the 6th (00:46:45.733Z, 422 ms after the first request) got 429. After the 5 tokens are used up, the bucket allows the 6th 200 ms later, so 6 requests go out within 1 second — the gateway counts "5 in any 1-second window". Even after changing the window to 1,050 ms (01:53) there were 2: (a) the window recorded a retry that went out late, after the `Retry-After` wait following a 429, at its original slot time; (b) the request 5 places earlier had a large latency of 427 ms, so its arrival time at the gateway was later than our send time.
- Docs: § Authentication › Rate Limits (L392) — only "per endpoint 5 RPS"; nothing on the window type (fixed/sliding, arrival-based).
- Time lost: [HUMAN]
- Workaround: in `packages/binance/src/rate-limit.ts`, the per-endpoint and DeFi group limits became a sliding window (5 requests / 1,000 ms + 250 ms margin), recording the actual send time (including the 429 wait). 01:54:58Z `pnpm tape:once` → api_calls: 29, 429s: 0, retries: 0.
- Ask: document the rate limit window type and its reference time (arrival/processing); provide a window-reset header such as `X-OC-RateLimit-Reset`.
- Evidence: api_calls `http_status=429` 44 rows (00:45:52Z–01:50:08Z); the fixture headers above; `rate-limit.test.ts` "replays the 2026-09-24 quote burst…", "counts a retry at the time it is sent after a 429 pause".

## 2026-09-24 02:11 UTC — [chain][edge] Correction: the Venus APY gap in the 00:49 entry was an error in our block-interval assumption
- Goal: find the cause of the gap in the 00:49 entry, "1.89% a year converted on-chain vs API `apyBps 316` (3.16%)".
- Expected: converting `supplyRatePerBlock` with 0.75 s blocks (42,048,000 blocks a year) matches the API APY.
- Actual: measured BSC block interval 0.45015 s — block 123654005 (2026-09-23T23:35:40Z) → 123674005 (2026-09-24T02:05:43Z), 9,003 s for 20,000 blocks (`eth_getBlockByNumber`, bsc-dataseed.bnbchain.org). Compounding `supplyRatePerBlock 445461184` per block over 70,056,648 blocks a year gives 3.170% ≈ API 3.16%. The 1.27%p gap was due to our assumption (0.75 s), not an API problem. Base supply interest alone matches, so `apyBps` has no XVS rewards, or they are 0.
- Docs: not applicable (the block interval is a chain parameter). The DeFi API docs still do not explain what `apyBps` is made of.
- Time lost: [HUMAN]
- Workaround: not applicable. `packages/core` `supplyApyFromRatePerBlock` takes blocks per year as an argument, so the caller passes the measured value.
- Ask: "state the APY composition (base interest vs rewards)" from the 00:49 entry is lowered in priority, since the gap it rested on is gone (stating the composition is still useful in itself).
- Evidence: numbers and timestamps of the two blocks above; DECISIONS Q-12.

## 2026-09-24 02:31 UTC — [web3api][region] First call from Frankfurt (Fly fra): reachability OK, 2~4x slower than Korea, no 40303 on parallel calls
- Goal: M0-04 (b) and M0-08 — confirm reachability from the Frankfurt worker, and whether 40303 appears when the same key is used in parallel with Korea (DECISIONS Q-01).
- Expected: not a restricted region → reachability OK. Per the docs, "concurrent multi-region access" risks 40303.
- Actual: Fly machine `d8de470f023428` (fra) `pnpm reach` 02:31:42Z — unsigned 401/40101 356 ms, signed RWA list 200/0 350 ms, price batch 200/0 253 ms, clock skew 10 ms. The same three calls from the Korean PC (02:33:02Z): 146 / 150 / 58 ms — Korea is closer to the gateway. The Korean calls came 36 s after the worker's last call (02:32:27Z), and there was no 40303 (overlap within the same second and long-running parallel use were not observed). Worker's first run: api_calls `region=fra` 33 rows, 429s: 0 (after the sliding-window limit was applied).
- Docs: § Service-Restricted Countries & Regions; § Authentication › Error Codes (describes 40301–40304; no criteria or time window for the multi-region determination).
- Time lost: 0.
- Workaround: the server runs in fra only; API calls from the Korean PC are one-off checks only.
- Ask: document the criteria for 40303 "frequent location switching or concurrent multi-region access" (time window, request count), and whether development (in another region) and production should use separate keys.
- Evidence: host `pnpm reach` output; Neon `SELECT region, count(*) … FROM api_calls GROUP BY region` → `fra 33` (02:31:55Z); Korean PC `pnpm reach` output (02:33:02Z).

## 2026-09-24 05:21 UTC — [rwa][docs] The statusInfo value lists and an independent stock price are not in the Web3 API docs, only in a Skills Hub skill; actual `paused` ≠ documented `pause`
- Goal: pin the M1-02 decision engine's ASSET (trading halt, corporate action) and PRICE (gap) rules to values from the official docs.
- Expected: the Web3 API RWA docs (llms-full.txt) have the value lists for `marketStatus`, `reasonCode` and `reasonMsg` in the RWA list's `statusInfo`, and an underlying stock price field separate from the reference price.
- Actual:
  - Searching llms-full.txt for `reasonCode`, `statusInfo`, `MARKET_PAUSED` and `nextOpenTime` returns 0 hits.
  - The value lists exist only in the "Reason Codes" and "Corporate Actions" tables of the Skills Hub `binance-tokenized-securities-info/SKILL.md` (public bapi docs). The codes are TRADING, MARKET_CLOSED, MARKET_PAUSED, ASSET_PAUSED(cash_dividend, stock_dividend, stock_split, merger, acquisition, spinoff, maintenance, corporate action), ASSET_LIMITED(earnings), UNSUPPORTED, MARKET_MAINTENANCE.
  - That table's `marketStatus` list has `pause`, but in the Web3 API RWA list at 2026-09-24 00:45 UTC, 97 Ondo tokens had `marketStatus:"paused"` (reasonCode `MARKET_PAUSED`, reasonMsg "Paused for session transition"). At the same time, 81 Ondo tokens were `UNSUPPORTED` and 264 were `TRADING`. The 46 bStocks were `TRADING` with `marketStatus:null`.
  - The only US stock price separate from the reference price is `stockInfo.price` in the same skill's RWA Dynamic V2 ("May be `null` outside trading hours"). The `referencePrice` of the Web3 API RWA price is a value derived as token price ÷ multiplier (00:55 entry, Q-06).
- Docs: llms-full.txt (no description of these fields); `docs/vendor/binance-skills-hub/skills/binance-web3/binance-tokenized-securities-info/SKILL.md` "Reason Codes", "Corporate Actions", "API 5: RWA Dynamic V2".
- Time lost: [HUMAN]
- Workaround:
  - The engine uses the codes from the skill's tables.
  - The market session is determined with our NYSE calendar (`packages/core/src/session.ts`).
  - The price gap is measured only when an independent stock price is available (`packages/core/src/decide.ts`, SPEC §5.5 v2).
- Ask:
  - Please include the `statusInfo` value lists and the per-issuer differences (bStocks: marketStatus null, TRADING even in off-hours) in the Web3 API RWA docs.
  - Please unify the spelling (`pause` and `paused`) into one.
  - Please provide an independent underlying-asset price (equivalent to `stockInfo.price`) in the Web3 API as well.
- Evidence: `fixtures/rwa/getRwaTokenList-20260924-1.json` (statusInfo distribution as above); the skill file above.

## 2026-09-26 17:59 UTC — [web3api][docs][error] Error tables checked against actual responses: two messages differ, and RWA Data has no error code page
- Goal: check error taxonomy v1 (M1-07, `packages/binance/src/taxonomy.ts`) against each module's official error table. This session made no API calls. Only fixtures from live measurements were compared.
- Expected: the table's Message column matches the actual `msg`. Every module has an error code page.
- Actual:
  - Trading `40401`: the table (L3051) says `Quote expired. Please request a new quote`; the actual response is `quoteId=a1dbc1ee… not found or expired` (`fixtures/trading/buildSwapTransaction-20260924-2.json`).
  - `42900` (HTTP 429): the tables (L1901, L2048, L3013) say `Request rate limit exceeded. Please refer to the API docs and reduce request frequency`; the actual message is `Rate limit exceeded`. `data` is `""`, not `null` as in the documented format (`fixtures/trading/getAggregatedQuote-20260924-12.json`).
  - There are 7 per-product error code pages: WebSocket (L1406), Wallet (L1837), Transaction (L1983), Trading (L2947), Market (L3351), DeFi (L4221), B402 (L5054). There is no page for RWA Data (`/api/v1/dex/market/rwa/...`).
  - `40304` (compliance) is only in the DeFi table (L4304). The IP compliance codes in the Trading, Transaction, Market and Wallet tables are 40301–40303.
  - Comparing the tables with our classification: every code on the 5 pages (Trading, Transaction, DeFi, Market, Wallet) is classified. Every code we classified as module-specific is also on the corresponding page (`taxonomy.test.ts` "code map vs the official error tables").
- Docs: § Error Codes (Trading API) › Quote, Rate Limit Errors; § Error Codes (DeFi API) › Compliance Errors.
- Time lost: [HUMAN]
- Workaround: branch on (module, code), not on `msg`. Only the 40375 minimum amount is read from `msg` (`venueMinimumUsd`). Errors from RWA calls are classified with the gateway's common codes. A code not in the tables, or a response that is not an envelope, is recorded in `dx_events` on first sighting, and an alert goes out (`pnpm dx:events`).
- Ask: make the tables' Message match the actual response text. Add an RWA Data error code page. State which module 40304 comes from.
- Evidence: the 2 fixtures above; `packages/binance/src/taxonomy.test.ts`, `packages/binance/src/replay.test.ts`.

## 2026-09-27 14:09 UTC — [bag][edge] Installing the `bag` CLI pulls 280 packages and 469 MB, including the AWS and Azure deploy SDKs and a deprecated native addon
- Goal: install the Agent Studio CLI to answer DECISIONS Q-09 (M0-10).
- Expected: a light CLI; a cloud provider's SDK only once that provider is chosen.
- Actual: `npm i @bnbagent/studio-cli@0.0.14` (Node 22.22.2) added 280 packages in 38 s. `node_modules` is 469 MB: `@bnbagent` 117 MB, `@azure` 107 MB, `viem` 72 MB, `@aws-sdk` 39 MB. `npm warn deprecated prebuild-install@7.1.3` comes from `@bnbagent/deploy-cli@0.6.6 → @bnbagent/deploy-provider-azure@0.6.6 → @azure/identity-cache-persistence@1.3.2 → keytar@7.9.0` (a native addon), installed even for an agent that never deploys to Azure.
- Docs: the `@bnbagent/studio-cli` README › "Start with the skill" › Requirements (Node 22, pnpm 10, Bun 1.3 for deploys, Docker for container paths; nothing about install size).
- Time lost: 0 (the install took 38 s).
- Workaround: install it in a throwaway folder, outside the repo.
- Ask: ship the AWS, Azure and NodeOps deploy providers as optional packages that `bag deploy --provider …` installs on first use.
- Evidence: this session's `npm i` output, `du -sh node_modules/*` and `npm ls prebuild-install`.

## 2026-09-27 14:11 UTC — [bag][docs] ERC-8004 registration on BSC mainnet costs about $0.006 of gas, or nothing through the default sponsored relay; the registry address is only in the SDK
- Goal: the "ERC-8004 registration cost" part of Q-09, without sending a transaction.
- Expected: the registry address per network and the cost in the Studio docs.
- Actual: the README gives neither. The addresses are in the SDK network config (`@bnbagent/sdk@0.6.0`, `dist/chunk-EP32RMKA.js`): mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (chain 56, paymaster `https://bsc-megafuel.nodereal.io/`), testnet `0x8004A818BFB912233c491871b3d84c89A494BD9e`. Read-only calls at block 124346561 (14:11:32 UTC): the mainnet address has code (130 bytes, a proxy), `name()` "AgentIdentity", `symbol()` "AGENT". `register(string agentURI)` is nonpayable (no fee). `eth_estimateGas` for it from an unfunded address: 163,268 gas; at the 0.05 gwei gas price that is 0.0000081634 BNB ≈ $0.0064 (Chainlink BNB/USD on BSC `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE`: 780.11, updated 14:11:17 UTC). `bag erc8004 register` uses the MegaFuel sponsored-gas relay by default (`--no-paymaster` pays from the wallet).
- Docs: `bag erc8004 register --help`; README › "Fund a BSC testnet seller" ("Canonical ERC-8004 and testnet ERC-8183 calls may use the configured sponsored-gas path").
- Time lost: 5 minutes (finding the addresses in the bundled SDK).
- Workaround: read the SDK's network config, then check the contract on-chain.
- Ask: list the registry address per network and the expected registration gas in the README.
- Evidence: the block number and calls above (reproducible with `eth_call` and `eth_estimateGas` against any BSC RPC).

## 2026-09-27 14:12 UTC — [bag][missing] Agent Studio covers seller agents only: identity commands need a seller project, and the managed runtime is a 48-hour testnet sandbox
- Goal: Q-09 — can the Studio runtime run our worker, and how is the wallet provided?
- Expected: a way to give an existing autonomous agent (ours is a scheduled worker that buys, and sells nothing) an ERC-8004 identity, and optionally a place to run it.
- Actual:
  - `bag --help`: "Scaffold, run, deploy, and monetize a single seller agent on BNB Chain."
  - `bag erc8004 show` outside a scaffolded project: `error: No studio.toml found in cwd or any parent directory.` The identity commands need a `bag init` seller project (A2A, MCP and x402/MPP faces around a `runWork` hook).
  - Runtimes: the managed BNB trial is "a 48-hour BSC testnet sandbox in the operator's cloud" (`bag init --destination platform` "forces bsc-testnet"; "a trial wallet key is transmitted to the operator"). The self-hosted targets are AWS AgentCore, Azure Foundry and CreateOS in your own account. The entry points are request-driven (A2A on port 9000, MCP at `/mcp`, `/x402`); no scheduled or long-running workload is described.
  - Wallets: an `evm-local` keystore in `.studio/wallets/`, a Trust Wallet Agent Kit wallet, or a bounded Altana session.
- Docs: README › "What Studio builds", "Deployment targets", "Wallet choices"; `bag init --help`.
- Time lost: 0.
- Workaround: the worker stays on our own runtime (Fly, Frankfurt). For an identity, a separate identity wallet can call `register(agentURI)` through `@bnbagent/sdk`, or through a minimal `bag init` project (DECISIONS D-28).
- Ask: an identity-only command (register an existing agent's URI from a given keystore, without a seller project), and a documented pattern for scheduled or operator agents.
- Evidence: the CLI output above (`@bnbagent/studio-cli@0.0.14`).

## 2026-09-30 02:08 UTC — [chain][docs] The Uniswap v4 addresses on BSC: the docs page rate-limits a script on its first request; the contracts repo has them, and they check out on chain
- Goal: find and verify the Uniswap v4 PoolManager on BSC for the RWA LP hook (DECISIONS D-29).
- Expected: the "v4 Deployments" page of the Uniswap docs, fetched by a script.
- Actual: `curl https://docs.uniswap.org/contracts/v4/deployments` → `HTTP 429`, body `error code: 1015` (a Cloudflare rate limit) on the first request from this host (02:07 UTC). `raw.githubusercontent.com/Uniswap/contracts/main/deployments/56.md` (sha256 `14a69437…85c4`) lists PoolManager `0x28e2…e9dF`, PositionManager `0x7a4a…f95b`, StateView `0xd13d…e0c4`, V4Quoter `0x9f75…37b0`, UniversalRouter `0xDc26…7C9f`. On chain at block 124825961: StateView, PositionManager and V4Quoter each answer `poolManager()` with the PoolManager; the PoolManager's runtime bytecode (24,009 bytes) equals the `@uniswap/v4-core@1.0.2` npm artifact once its one immutable is masked; PositionManager `nextTokenId()` 1,387,557.
- Docs: docs.uniswap.org › Contracts › v4 › Deployments; github.com/Uniswap/contracts `deployments/56.md`.
- Time lost: about 5 minutes.
- Workaround: the deployment log in the contracts repository, then on-chain checks.
- Ask: list the canonical v4 DEX contracts on BSC (Uniswap v4, PancakeSwap Infinity) in the BNB Chain developer docs with the other infrastructure addresses.
- Evidence: DECISIONS §2.3 U-01–U-04; `packages/rwa-lp/src/addresses.ts`.

## 2026-09-30 02:10 UTC — [chain][edge] Public BSC RPCs cannot list a contract's events over any useful range, and a fork of a pruned node dies within minutes
- Goal: list the Uniswap v4 `Initialize` events whose currency is a tokenized stock (which stock pools exist on BSC).
- Expected: `eth_getLogs` filtered by address and topic over a few million blocks.
- Actual: `bsc-dataseed.bnbchain.org`: 200 blocks → `-32005 limit exceeded`. `bsc-rpc.publicnode.com`: 5,000,000 blocks → `HTTP 403 "Archive requests require a personal token"`; 100 blocks → 218 `Swap` logs. `bsc.drpc.org`: `"ranges over 10000 blocks are not supported on free plan"`. `rpc.ankr.com/bsc`: no answer. At about 0.75 s per block, 10,000 blocks is about 2 hours, so the ~100M blocks since v4 launched on BSC take ~10,000 requests on the best free endpoint. Separately (02:48 UTC): an `anvil` fork of `bsc-dataseed` started answering `missing trie node` for accounts it had not read yet about 2 minutes after forking (the node keeps recent state only).
- Docs: —
- Time lost: about 10 minutes.
- Workaround: compute the pool ids of candidate keys (stock × USDT/USDC/WBNB/BNB × fee tiers, no hook) and read `StateView.getSlot0/getLiquidity` (next entry); fork runs read every account they need in their first seconds.
- Ask: an event index (or a data API) for BSC v4 pools by currency, or a free archive tier with a larger log range.
- Evidence: the JSON-RPC answers quoted above.

## 2026-09-30 02:11 UTC — [chain][rwa][edge] Tokenized stocks already sit in hookless Uniswap v4 pools on BSC, 205–228 USD apart for the same NVIDIA exposure, and the three NVDAB pools have no active liquidity
- Goal: see how tokenized stocks are pooled on BSC before designing the hook (D-29).
- Expected: —
- Actual: at block 124826328 (US overnight): NVDAB/USDT 0.01% 224.85 USD, liquidity 0; NVDAB/USDT 1% 205.48, 0; NVDAB/USDC 0.3% 221.97, 0; NVDAon/USDT 0.01% 228.30, 1.68e19; NVDAon/USDT 0.05% 212.03, 1.40e18; NVDAon/USDT 1% and NVDAon/BNB 1% at the price limits with 0 liquidity; QQQB/USDT 0.01% 722.32 and 0.3% 709.72. Every pool found is hookless with a static fee (the probe cannot see hooked pools: a pool key includes the hook address). At 02:11:39 the public RWA Dynamic V2 answered NVDAB `tokenInfo.price` 228.1474 and `stockInfo.price` null (market closed).
- Docs: —
- Time lost: 0.
- Workaround: —
- Ask: —
- Evidence: pool ids and prices in docs/RWA_LP.md §1 (method: keccak of the pool key, `StateView.getSlot0`/`getLiquidity`, sqrt price → USD with `packages/rwa-lp/src/price.ts`).

## 2026-09-30 02:38 UTC — [rwa][edge] bStocks and Ondo NVIDIA tokens move freely through the Uniswap v4 PoolManager, with no fee on transfer
- Goal: check that tokenized stocks can be pooled at all (holder allowlists, fees on transfer) before building on it.
- Expected: unknown — RWA tokens often restrict who may hold them.
- Actual: on a fork of block 124829943, balances written to fresh addresses moved into the PoolManager (`settle`) and back out (`take`) for NVDAB and NVDAon, through the RwaSessionHook pool and vault. `settle` checks the amount received, so neither token takes a transfer fee. The live PoolManager already held 65.56 NVDAB and 6.87 NVDAon (02:10 UTC). NVDAB, TSLAB and QQQB `effectiveAt()` were 0 (nothing scheduled) at block 124833171.
- Docs: —
- Time lost: 0.
- Workaround: —
- Ask: state in the RWA docs, per issuer, whether a token may be held by contracts such as AMM pool managers, and how a scheduled multiplier change is announced on chain.
- Evidence: `packages/rwa-lp/contracts/test/BscFork.t.sol`; DECISIONS U-05, U-06.

## 2026-10-01 05:12 UTC — [baw][rwa][docs] `baw market-order quote` reports a tokenized stock in shares (tokens × multiplier); the Web3 API quote reports tokens
- Goal: check that the floor `/next` hands the Wallet Skill (`acceptMinToCoinAmount`) is in the unit the user's `baw` prints, before a human runs M2-09.
- Expected: `data.toCoinAmount` of `baw market-order quote --json` is the amount of the token bought, like `toTokenAmount` of the Web3 API aggregator quote (`/build/api/v1/dex/aggregator/quote`, token base units; `fixtures/trading/getAggregatedQuote-20260924-1.json`).
- Actual: in `@binance/agentic-wallet@1.10.0` (npm tarball sha256 `459d014f…0502`, `dist/index.js` sha256 `7048ff79…345d`, read, not run): when either token is in the wallet's RWA list, `quote` multiplies the API's `toCoinAmount` by that token's multiplier, rounded down to 18 decimals (`$e(a.data.toCoinAmount, l)`, offset 82132, for bStocks; Ondo goes to a separate `ondoQuote` endpoint and prints `toTokenShare`). `market-order list` does the same to `toTokenActualQty` (offset 86267), and for a sell `--fromTokenQty` is read as shares and divided by the multiplier. So the CLI speaks shares, the chain and the Web3 API speak tokens. Our `/next` gave the floor in tokens: with a multiplier above 1 the 1 % price check was looser by that factor (0.08 % for NVDAB today, half the price after a 2-for-1 split), below 1 it would refuse every quote.
- Docs: Skills Hub `binance-agentic-wallet` (market-order) and the `baw --help` text say "Amount to swap" / "Destination token" with no unit for RWA tokens; the conversion is only in the bundle.
- Time lost: about 20 minutes.
- Workaround: `/next` now states the floor in shares (`sharesFromTokens(min tokens, decimals, multiplier)`, rounded down like `baw`); `skills/yieldvest/references/run.md` says both sides are shares.
- Ask: document per command which RWA amounts `baw` prints and accepts as shares, and the multiplier it used (put it in the JSON output), so an agent can compare a quote with on-chain balances without reading the bundle.
- Evidence: `apps/web/lib/server/next.ts` (`acceptMinToCoinAmount`), `apps/web/test/skill.test.ts` (0.021990032462334682 tokens × 1.000778223752807865 = 0.022007145627921886 shares).

## 2026-10-01 06:04 UTC — [rwa][docs] The public RWA list repeats each Ondo ticker once per chain, Ethereum first: a lookup by ticker alone finds the wrong token
- Goal: check the Wallet Skill's token check (the address `/next` names must be the official one for the ticker) against the public list the Skills Hub documents.
- Expected: one entry per ticker for the list type asked for, or a chain filter.
- Actual: `GET …/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1` (Ondo, no key, `Accept-Encoding: identity`): HTTP 200, 254,457 bytes, 1.51 s, 1,366 entries for 459 tickers — `chainId` "56" 458, "1" 457, "CT_501" 451. NVDA's entries, in order: Ethereum `0x2d1f7226…`, BSC `0xa9ee28c8…`, CT_501 `gEGtLTPN…`, all with the symbol `NVDAon`. `type=3` (bStocks): 87 entries, all chain "56". There is no chain parameter. A check that takes "the entry for the ticker" compares the BSC address with Ethereum's and refuses every Ondo buy (it fails safe; an agent that took the address from the list instead would send to a token that does not exist on BSC).
- Docs: Skills Hub `binance-tokenized-securities-info/SKILL.md` API 1: its example response has a chain "1" and a chain "56" entry, but the field table lists only `1` (Ethereum) and `56` (BSC) — not `CT_501` (451 entries) — and the `type` parameter says `1` = Ondo is "currently the only supported tokenized stock provider", while `type=3` returns 87 bStocks tokens. Nothing says a lookup must filter by chain.
- Time lost: about 10 minutes (found in the skill review).
- Workaround: `skills/yieldvest/references/safety.md` takes the list for `instrument.issuer` and the entry with `chainId "56"`, and compares the address, the symbol and the quote's `toCoinSymbol`.
- Ask: a `chainId` filter on the list endpoint, and one sentence in the skill docs that tickers repeat per chain.
- Evidence: the counts above (re-measured at 06:04:06 UTC); `skills/yieldvest/references/safety.md`.

## 2026-10-01 06:19 UTC — [baw][auth] `baw wallet status --json` answers `success: true` when signed out; the status is in `data.status`
- Goal: the Wallet Skill's preflight must tell a signed-in `baw` from a signed-out one before it plans anything.
- Expected: a signed-out wallet makes `wallet status` fail, as every other command does.
- Actual: `@binance/agentic-wallet@1.10.0`, fresh `HOME` (never signed in): `baw wallet status --json` → exit 0, `{"success": true, "data": {"status": "UNCONNECTED"}}`. `baw market-order quote … --json` → `{"success": false, "error": {"code": 10003000, "name": "NOT_LOGGED_IN", "message": "Not logged in"}}`. From the bundle, `data.status` is `UNCONNECTED` unless connected, then `CREATING` until the wallet exists, then `CONNECTED`. An agent that checks `success` — the field every other command uses for the outcome — believes it is signed in and fails one step later.
- Docs: the Skills Hub `binance-agentic-wallet/references/wallet-view.md` lists the three values (`UNCONNECTED` not signed in, `CREATING`, `CONNECTED`); it does not say that `success` stays `true` when signed out, while every other command reports its failure in `success`.
- Time lost: about 5 minutes.
- Workaround: `skills/yieldvest/SKILL.md` preflight requires `data.status` = `CONNECTED`.
- Ask: make `wallet status` exit non-zero (or `success: false`) when the session is not usable, or document that `success` only means the call ran.
- Evidence: the two outputs above (06:19:48 UTC, `baw` 1.10.0 from a scratch install, no account).

## 2026-10-01 16:40 UTC — [web3api][docs] The 9/23–9/26 documentation findings re-checked against the live docs: 13 still present, 4 found, 2 changed
- Goal: give each documentation finding a public URL and the current text, and say whether it still holds (REPLAN §7: citations as URL + original text instead of `llms-full.txt` line numbers).
- Expected: the problems logged from the 9/23 `llms-full.txt` snapshot still read the same on the live pages.
- Actual (pages fetched 16:40–16:49 UTC; raw Markdown at `<page>.md` where the site serves it, the HTML API reference otherwise):

| Entry | Page § section | Status | Current text |
| --- | --- | --- | --- |
| 09-23 17:51 market price body | `/en/dev-docs/catalog/web3-wallet/api/rest-api/general-data` § Get Token Price › Request Body | found\* | an array of `binanceChainId` (string, required) and `tokenContractAddress` (string, required) |
| 09-23 17:51 header names | `/en/dev-docs/authentication` § Step 2 | still present | `X-OC-RECV-WINDOW`, `X-OC-NONCE`; no `recvWindow` / `nonce` alias |
| 09-23 17:53 simulate parameters | `…/rest-api/transaction-api` § Simulate Transactions | found\* | "Provide `evmTx` for EVM chains, `solTx` for Solana, or `tronTx` for Tron — exactly one must be present." |
| 09-23 17:53 GET body signed | `/en/dev-docs/authentication` § 3.1 | still present | `body`: "empty string `""`" for `GET`/`HEAD` (the connector was not re-checked) |
| 09-23 17:55 signing examples | `/en/dev-docs/authentication` § 3.1 examples | still present | `requestPath = "/build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT"`, `"/build/api/v1/dex/swap"` |
| 09-23 17:58 HTTP status of errors | `/en/dev-docs/products/market-api/error-codes` vs `/products/defi-api/error-codes` § Response Format | still present | "All Market API responses — including errors — return **HTTP 200**." vs "gateway-layer errors are **not** returned as HTTP 200 — authentication failures return **401**, and rate-limit violations return **429**" |
| 09-23 17:58 rate-limit header table | `/en/dev-docs/authentication` § Rate Limits | still present | "Per Endpoint \| 5 RPS (default) \| 1 s \| `X-OC-Used-Weight`" |
| 09-23 18:00 B402 envelope | `/en/dev-docs/introduction` § Unified Response Format vs `/products/b402-api/integration-guide` | still present | "All endpoints return the `OCResult<T>` format:" vs "A successful response has envelope code `000000000`." |
| 09-23 18:00 DeFi example values | `/products/defi-api/integration-flow` § Step 2 | changed | the DeFi API now covers 10 EVM chains (changelog 2026-09-30), so the Ethereum USDT address is on a supported chain; the DEPOSIT `"data": "0xa9059cbb..."` and APPROVE `to` = token are unchanged |
| 09-23 18:00 unlimited APPROVE | `/products/defi-api/integration-flow` § Calldata Validity & Approvals | still present | "**APPROVE is an unlimited allowance (EVM only)**"; the build body has no approval-amount field |
| 09-23 18:00 40470 in two modules | `/products/defi-api/error-codes` § DeFi Data Query Errors | fixed | "v1.0 returned `40470` for the same condition — v1.1 renumbers it to `40490`" (see the entry below) |
| 09-23 18:01 units by module | `/products/defi-api/introduction` § Data Format Conventions vs `…/rest-api/trading-api` § Get Aggregated Quote | still present | "Human-readable decimal strings … **not** the token's smallest unit" vs "Sell-token amount in the token's smallest unit" |
| 09-23 18:01 broadcast body | `/products/transaction-api/error-codes` § Parameter Errors | still present | "Broadcast request is missing both `evmTx` and `solTx` (one is required)"; the reference body is `binanceChainId`, `signedTransaction`, `address`, `enableMevProtection` |
| 09-23 18:02 Ondo suffix in a bStock example | `/products/trading-api/introduction` § Equity Token Trading (RWA) | still present | "**BStock tokens** (type=3): … (e.g. PALLon/Palladium, TSLAB/Tesla)" |
| 09-23 18:03 RWA field descriptions | `…/rest-api/rwa-data` § Get RWA Token List › Response | found\* | `referencePrice`: "A per-share converted price derived from the on-chain token price, not an official quote from the traditional stock market." |
| 09-23 18:12 JS signing helper | `/en/dev-docs/authentication` § Step 4 | still present | the helper is unchanged; the 40102 it predicts is still not measured |
| 09-23 18:20 connector timeout | `/en/dev-docs/sdks-tools/connectors/javascript` § Key features | still present | "Configurable timeouts, retries, and proxy support"; no default given |
| 09-24 05:21 statusInfo lists, stock price | `…/rest-api/rwa-data` § statusInfo.marketStatus, § Get RWA Underlying Market Data | changed\* | the value lists are in the API reference ("… or pause (trading halt/circuit breaker)"; live answers say `paused`); `marketData` has no independent stock price |
| 09-26 17:59 error messages, no RWA page | `/products/trading-api/error-codes` § Quote | still present | 40401 "Quote expired. Please request a new quote"; no error-code page for RWA Data |

- \* = on the HTML API reference (`/en/dev-docs/catalog/web3-wallet/api/rest-api/…`), which the 9/23 entries did not read (they read `llms-full.txt` and the connector). Whether that text existed on 9/23 cannot be told, so these are not changes Binance made.
- Docs: the pages above. `llms.txt` lists the API reference endpoints without URLs; the reference pages are reached from the site's navigation.
- Time lost: 0 (agent re-check).
- Workaround: not applicable.
- Ask: the entries' own asks, for the rows still present.
- Evidence: the quotes above, fetched 16:40–16:49 UTC; three spot-checked again at 16:52–16:54 UTC (the 40470/40490 sentence, both 40102 messages, the 40314 row).
- Own mistakes and open measurements among the entries: 2026-09-30 02:10 put 10,000 blocks at "about 2 hours" from an assumed 0.75 s block; at the 0.45 s measured on 09-24 02:11 it is about 75 minutes (corrected in `dx/findings/bsc-public-rpc-log-range.md`). Not measured yet: 09-23 17:53 (does the gateway reject a signed GET body?), 09-23 18:12 (does the docs' helper fail with 40102 on a `'`?), 09-23 18:20 (the connector's timeout under real latency).

## 2026-10-01 16:52 UTC — [tx][docs] 40314 says to resubmit "with the user's explicit confirmation flag"; the Broadcast body has no such field
- Goal: know how to answer a medium-risk (KYT) refusal on broadcast.
- Expected: the field that carries the user's confirmation, named on the Broadcast Transactions reference.
- Actual: `/en/dev-docs/products/transaction-api/error-codes.md` § Troubleshooting Guide: "KYT medium-risk prompt \| `40314` \| Display a risk warning to the end user and resubmit with the user's explicit confirmation flag"; the code table: "the client must display a confirmation prompt and resubmit with the user's explicit acknowledgement". The Broadcast Transactions reference body has `binanceChainId`, `signedTransaction`, `address`, `enableMevProtection` and nothing else.
- Docs: the two pages above.
- Time lost: 0 (found in the re-check; Yieldvest has not met 40314).
- Workaround: none known; a 40314 would stop a cycle as a failure.
- Ask: name the confirmation field (and its value) in the Broadcast Transactions reference, or describe the resubmission.
- Evidence: the quotes above (16:52–16:54 UTC).

## 2026-10-01 16:52 UTC — [web3api][docs] 40102 is "Invalid signature" on the Authentication page and "Signature error" in every module's table
- Goal: match signature errors by message as well as code.
- Expected: one message per code.
- Actual: `/en/dev-docs/authentication.md` § Error Codes example: `"msg": "Invalid signature"`; the Trading integration flow's Common Pitfalls: "`40102 Invalid signature`"; the Market, Trading, Transaction, Wallet and DeFi error tables: "\| `40102` \| `Signature error` \|".
- Docs: the pages above.
- Time lost: 0.
- Workaround: match by code only (as `packages/binance` does).
- Ask: one message, the one the gateway sends.
- Evidence: the quotes above (16:52–16:54 UTC).

## 2026-10-01 16:52 UTC — [defi][docs] The DeFi error page cites a "v1.1" renumbering (40470 → 40490); the changelog has no v1.1
- Goal: know since when DeFi "not found" is 40490 (09-23 18:00 logged 40470 for it).
- Expected: the version in the changelog.
- Actual: `/en/dev-docs/products/defi-api/error-codes.md`: "v1.0 returned `40470` for the same condition — v1.1 renumbers it to `40490`; update any branching on the old code." `/en/dev-docs/products/others/changelog.md` has dated entries (2026-06-01 … 2026-09-30) and one version label, "v1.0.0 — Initial Release"; `llms.txt` calls the reference "Binance Web3 API (1.0.0)".
- Docs: the pages above.
- Time lost: 0.
- Workaround: `packages/binance/src/taxonomy.ts` knew only 40470 for DeFi "not found", so a 40490 would have been filed as an unknown code; it now knows both (`taxonomy.test.ts`).
- Ask: put the renumbering in the changelog with its date.
- Evidence: the quotes above (16:52–16:54 UTC).

