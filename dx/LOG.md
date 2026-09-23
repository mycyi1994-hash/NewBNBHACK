# dx/LOG.md — 개발자 경험 로그 (시간순, 추가만)

형식은 `docs/DX_PROTOCOL.md` §3.1. 에이전트는 사실(기대·실제·증거)만, 사람은 `- 소감:` 줄을 덧붙인다.
시각은 UTC. 태그: `[web3api|baw|skill|bag|chain|defi|rwa|trading|tx|wallet|b402][auth|docs|error|latency|edge|missing]`.

---

## 2026-09-23 — 프로젝트 시작 (기획)
- 대회 공식 페이지의 규칙·채점 기준·리소스 목록을 확보했고, Binance Skills Hub(`binance-agentic-wallet` v1.12.0, `binance-tokenized-securities-info` v1.1)를 읽었다.
- 기획 환경에서는 `web3.binance.com`, `developers.binance.com`, `bnbchain.org`가 네트워크 정책으로 차단되어 공식 문서를 직접 읽지 못했다. 엔드포인트·서명 규약은 선행 빌더 메모에서 가져왔고 전부 ⚠️VERIFY로 표시했다.
- 다음 항목부터는 실제 개발 경험을 기록한다: 포털 로그인 시각 → 키 발급 시각 → 첫 미서명 호출 → 첫 서명 호출.

## 2026-09-23 17:44 UTC — [web3api][docs] llms.txt·llms-full.txt가 curl에 HTTP 202 + 빈 본문(AWS WAF 챌린지)
- 목표: `bash scripts/fetch-docs.sh`로 공식 LLM용 문서 받기(M0-02).
- 기대: `https://web3.binance.com/en/dev-docs/llms.txt`, `…/llms-full.txt`가 200 + Markdown.
- 실제: 두 URL 모두 `HTTP/2 202`, `x-amzn-waf-action: challenge`, `content-length: 0`(CloudFront POP IAD12). 브라우저 UA를 줘도 같음. `curl -f`는 202를 성공으로 보므로 원래 스크립트는 **빈 파일을 만들고 성공 종료**했을 것. 헤드리스 Chromium으로 열면 첫 응답 202 → 챌린지 스크립트 실행 후 200(llms.txt 11,485자, llms-full.txt 425,947자·8,416줄, 각 ~5.5 s).
- 문서: llms-full.txt § llms.txt — "Download and use as context"(L914 부근). LLM·에이전트용 파일인데 비브라우저 클라이언트가 못 받음.
- 잃은 시간: 약 15분(원인 파악 + 브라우저 폴백 작성).
- 우회: `scripts/fetch-docs.sh`가 200·Markdown 여부를 검사하고 실패 시 `scripts/fetch-docs-browser.mjs`(Playwright Chromium)로 받음.
- 요청: `/en/dev-docs/*.txt`, `*.md`를 WAF 챌린지 대상에서 제외하거나, 챌린지 시 200이 아닌 4xx를 반환.
- 증거: 이 세션의 curl 헤더 출력(위 값), `docs/vendor/llms-full.txt` sha256 `ea604b558bd3349c…`(2026-09-23 17:52 UTC 수신). 환경: 미국 소재 클라우드 샌드박스 egress(한국 회선 아님).

## 2026-09-23 17:51 UTC — [web3api][docs] `POST /api/v1/dex/market/price` 요청 body 스키마가 어디에도 없음(커넥터도 body를 못 보냄)
- 목표: `pnpm reach`의 Market 가격 배치 호출 구현(M0-03).
- 기대: 배치(최대 100개) body의 필드 정의.
- 실제: llms-full.txt에는 "Supports batch queries, up to 100 tokens per request"(L3307)와 "Batch request list exceeds 100 items"(L3392)뿐. API Reference 항목(L7757)엔 파라미터 표가 없음. 공식 커넥터 `@binance-web3/wallet@12.3.0`의 `GetTokenPriceRequest`는 `recvWindow`, `nonce`만 있고 빌더 `getTokenPrice`(dist/index.mjs L1651)는 body를 항상 `{}`로 둠 → 타입이 있는 메서드로는 이 엔드포인트를 쓸 수 없음. `getTokenTradingInfo`(L1693, `POST /price-info`), `getTokenBasicInfo`(L1609, `POST /token/basic-info`)도 동일.
- 문서: llms-full.txt § Introduction (Market API) › General Data; § API Reference › General Data › "Get Token Price".
- 잃은 시간: 20분.
- 우회: 응답 필드(`binanceChainId`, `tokenContractAddress`)로 추정한 배열 body를 `pnpm reach`에서 "UNVERIFIED — DECISIONS V-09"로 표시하고 G1 실호출로 확정 예정. 커넥터 사용자는 `restAPI.sendSignedRequest(path, 'POST', {}, body)`로 우회 가능.
- 요청: 세 POST 엔드포인트의 request body 스키마를 문서와 OpenAPI(커넥터 생성원)에 추가.
- 증거: `docs/vendor/ENDPOINTS.md` "Doc ↔ connector anomalies"(`pnpm endpoints`가 자동 검출), DECISIONS V-09.

## 2026-09-23 17:51 UTC — [web3api][auth] 커넥터가 recvWindow·nonce를 문서와 다른 헤더 이름으로 보냄
- 목표: 서명 헤더를 문서와 커넥터 두 출처로 교차 확인(M0-02 V-04).
- 기대: 문서대로 `X-OC-RECV-WINDOW`, `X-OC-NONCE`.
- 실제: 커넥터 빌더는 `localVarHeaderParameter["recvWindow"]`, `["nonce"]`(dist/index.mjs L336 등 모든 연산)로 넣어 **`recvWindow`, `nonce`라는 이름의 헤더**가 나감. 게이트웨이가 이 이름을 인식하는지는 문서에 없음.
- 문서: llms-full.txt § Authentication › Step 2 — Understand Required Headers(L144).
- 잃은 시간: 0(대조 중 발견).
- 우회: 우리 클라이언트는 문서 이름(`X-OC-RECV-WINDOW`, `X-OC-NONCE`)으로 보냄. 실제 수용 여부는 G1에서 `recvWindow` 변경 호출로 확인 예정.
- 요청: 커넥터 헤더명을 문서와 일치시키거나 문서에 별칭을 명시.
- 증거: `packages/binance/node_modules/@binance-web3/wallet/dist/index.mjs` L336.

## 2026-09-23 17:53 UTC — [tx][edge] 커넥터 `simulateTransactions()`가 evmTx·solTx·tronTx를 모두 필수로 요구
- 목표: Transaction API 시뮬레이션 파라미터 확인(SPEC §5.8).
- 기대: 체인에 맞는 tx 하나만 전달.
- 실제: 커넥터 타입 설명은 "`evmTx`, `solTx`, and `tronTx` are marked required in this schema for rendering purposes only; in practice supply exactly one"인데, 빌더(dist/index.mjs L2962)는 세 값 모두 `assertParamExists`로 강제 → EVM만 넘기면 `RequiredError`. 셋을 다 넘기면 셋 다 body에 실림.
- 문서: 커넥터 `SimulateTransactionsRequest` 설명; llms-full.txt에는 simulate 파라미터 설명 없음(§ API Reference › Transaction API › "Simulate Transactions", L8106).
- 잃은 시간: 0.
- 우회: 우리 클라이언트로 직접 호출(EVM tx만).
- 요청: OpenAPI에서 `oneOf`로 표현하고 커넥터 필수 검사 제거.
- 증거: 위 소스 위치, `docs/vendor/ENDPOINTS.md` Transaction API 표.

## 2026-09-23 17:53 UTC — [trading][auth] 커넥터 `getRfqOrderStatus()`가 GET에 JSON body를 싣고 서명함
- 목표: RFQ 주문 상태 조회 경로 확인.
- 기대: 문서상 GET의 서명 body는 `""`(§ Authentication › 3.1, L193).
- 실제: 빌더(dist/index.mjs L2466)가 `orderId`를 경로에 넣으면서 body에도 넣음 → `GET /build/api/v1/dex/aggregator/order/{orderId}`에 `{"orderId":"…"}` body가 실리고 그 body로 서명. 서버가 GET body를 `""`로 보고 검증하면 40102가 날 것(실호출 미확인).
- 문서: § Integration Flow (Trading API) › RFQ Mode (L2678).
- 잃은 시간: 0.
- 우회: 우리 클라이언트는 GET body를 거부(`client.test.ts` "never sends a GET body").
- 요청: 커넥터에서 path 파라미터를 body에서 제거.
- 증거: `packages/binance/src/signature-vectors.test.ts` "documents a connector anomaly…"(커넥터가 실제로 body를 싣는 것을 테스트로 고정).

## 2026-09-23 17:55 UTC — [web3api][docs] 서명 예제가 존재하지 않는 메서드·경로를 씀
- 목표: 서명 문자열 규칙 확인(V-02).
- 기대: 예제가 실제 엔드포인트를 사용.
- 실제: GET 예제는 `GET /build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT`(L220, L311)인데 API Reference의 `/market/price`는 **POST**(L7757)이고 `chainId`·`symbol` 파라미터는 없음(체인 파라미터명은 `binanceChainId`). POST 예제 경로 `/build/api/v1/dex/swap`(L231)은 API Reference에 없음(스왑은 `GET /api/v1/dex/aggregator/swap`).
- 문서: llms-full.txt § Authentication › 3.1 Build the Pre-Hash String, Step 4 — Send the Request.
- 잃은 시간: 5분.
- 우회: 서명 규칙 자체는 예제 문자열과 커넥터 결과로 검증(`signature-vectors.test.ts`의 문서 pre-hash 테스트).
- 요청: 예제를 실제 엔드포인트(예: `GET /api/v1/dex/market/rwa/tokens?binanceChainId=56`)와 알려진 secret→signature 쌍으로 교체.
- 증거: 위 줄 번호(snapshot sha256 `ea604b558bd3349c…`).

## 2026-09-23 17:58 UTC — [web3api][error] 오류가 HTTP 몇으로 오는지 페이지마다 다름
- 목표: 엔벨로프 파서 설계(V-05).
- 기대: 한 가지 규칙.
- 실제: § Authentication › Error Codes(L407)는 40001=400, 40101~40103=401, 40104=403, 42900=429, 50000=500, 50001=503. 반면 Market(L3358)·Trading(L2954)·Transaction(L1990)·Wallet(L1844) 오류 페이지는 "All … responses — including errors — return HTTP 200"이고 같은 표에 40101~40104·42900도 싣고 있음. DeFi(L4241)는 "gateway-layer errors are not returned as HTTP 200 — 401, 429". Authentication의 오류 body 예시에는 `success` 필드가 없음(L422).
- 문서: 위 각 섹션.
- 잃은 시간: 10분.
- 우회: HTTP 상태와 무관하게 body `code`로 판정하고, 엔벨로프가 없으면 transport 오류(`packages/binance/src/envelope.ts`, 테스트 `envelope.test.ts`).
- 요청: 게이트웨이 오류와 비즈니스 오류의 HTTP 상태를 한 표로 명시.
- 증거: 실측 1건 — 서명 없는 GET은 HTTP 401 + body `code 40101`(아래 18:16 항목).

## 2026-09-23 17:58 UTC — [web3api][docs] 레이트리밋 응답 헤더 표를 해석할 수 없음
- 목표: 토큰버킷과 429 처리 설계(V-06).
- 기대: 차원별 한도·잔여를 읽는 헤더.
- 실제: 표(L396–401)가 차원마다 헤더 하나씩을 매핑: Per IP → `X-OC-RateLimit-Limit`, Per API Key → `X-OC-RateLimit-Remaining`, Per User·Per Endpoint → `X-OC-Used-Weight`. Limit/Remaining은 차원이 아니라 값의 종류라서 어느 차원의 값인지 알 수 없음. 429의 `Retry-After` 단위(초)만 명확.
- 문서: llms-full.txt § Authentication › Rate Limits.
- 잃은 시간: 5분.
- 우회: 429가 나면 모든 버킷을 `Retry-After`만큼 멈춤(`rate-limit.ts` `pause`), 헤더 값은 api_calls·응답에 원값으로 기록.
- 요청: 헤더가 어느 차원의 값인지(또는 차원별 헤더)를 명시.
- 증거: L396–401.

## 2026-09-23 18:00 UTC — [b402][docs] B402 응답은 "모든 엔드포인트 OCResult" 규칙의 예외
- 목표: 모듈별 엔벨로프 확인.
- 기대: Overview의 `OCResult<T>` `{code:number, msg, data, timestamp, success}`(L94).
- 실제: B402 성공 코드는 문자열 `"000000000"`(L4855), 오류 코드 `1160101…1160409`. 커넥터 타입의 B402 응답은 `{status, type, code: string, errorData, data, subData, params}`이고 `msg`·`success`가 없음. llms-full.txt에는 이 엔벨로프 필드 설명이 없음(커넥터 타입에만 있음). 요청 body도 `{"body": {...}}`로 한 번 감싸야 함.
- 문서: § Overview › Unified Response Format; § Integration Guide (B402) › Read and Cache Supported Configurations(L4881); § Error Codes (B402)(L5057).
- 잃은 시간: 10분.
- 우회: 모듈별 파서(`envelope.ts`의 `b402` 분기, 문자열 코드 보존).
- 요청: Overview에 B402 예외와 엔벨로프 필드를 명시.
- 증거: `docs/vendor/ENDPOINTS.md` §2.

## 2026-09-23 18:00 UTC — [defi][docs] DeFi 예제 값이 BSC 전용 API와 맞지 않음
- 목표: 예치 build 응답 형태 확인(Q-05).
- 기대: BSC 예제.
- 실제: deposit 요청 예제의 `token.tokenAddress`가 `0xdac17f958d2ee523a2206206994597c13d831ec7`(이더리움 메인넷 USDT, L3774)인데 DeFi API는 BSC만 지원(L3496). 응답 예제의 `DEPOSIT` 항목 `data`가 `0xa9059cbb…`(L3803) — ERC-20 `transfer(address,uint256)` 선택자. "APPROVE … to the spender contract returned in that item's `to`"(L4130)라고 하지만 예제의 APPROVE `to`는 토큰 컨트랙트(L3790)이고 spender는 calldata 안에 있음.
- 문서: § Integration Flow (DeFi API) › Step 2 — Build the Transaction; › Calldata Validity & Approvals.
- 잃은 시간: 10분.
- 우회: M0-07에서 실제 build 응답을 픽스처로 받아 APPROVE calldata를 디코드해 spender 확인 예정.
- 요청: BSC 값으로 된 실제 응답 예제로 교체.
- 증거: 위 줄 번호.

## 2026-09-23 18:00 UTC — [defi][edge] DeFi build의 APPROVE는 무제한 승인만 제공
- 목표: 예치 흐름에 정확 금액 승인 적용(CLAUDE.md 규칙 5).
- 기대: 금액만큼 approve하는 옵션.
- 실제: "APPROVE is an unlimited allowance — … approves the maximum amount (`type(uint256).max`)"(L4130). 금액 지정 파라미터 없음(커넥터 `BuildDeFiDepositTransactionRequest`에도 없음). Trading `/approve-transaction`은 `approveAmount`를 받음(L2416).
- 문서: § Integration Flow (DeFi API) › Calldata Validity & Approvals.
- 잃은 시간: 0.
- 우회: 결정 대기 — DECISIONS Q-16(APPROVE 항목 대신 같은 spender로 정확 금액 approve를 직접 인코딩).
- 요청: DeFi build에 `approveAmount`(또는 exact 모드) 추가.
- 증거: L4130, `docs/DECISIONS.md` Q-16.

## 2026-09-23 18:00 UTC — [defi][error] 오류 코드 40470이 모듈마다 뜻이 다름
- 목표: 에러 분류표(SPEC §11) 입력 정리.
- 기대: 코드 하나에 뜻 하나.
- 실제: DeFi `40470` = "Requested DeFi resource not found"(L4332), Trading `40470` = "Tax token cannot configure referral fee on the same side"(L3079). DeFi 페이지는 자기 범위가 "does not collide with the DEX Swap range 40461–40469"라고 씀(L4342) — 40470은 그 범위 밖이라 실제로 충돌.
- 문서: § Error Codes (DeFi API) › DeFi Data Query Errors; § Error Codes (Trading API) › Custom Fee.
- 잃은 시간: 0.
- 우회: 오류를 (모듈, 코드)로 식별(`BinanceApiError.module`, api_calls.module).
- 요청: 전역 코드 레지스트리 공개.
- 증거: 위 줄 번호.

## 2026-09-23 18:01 UTC — [defi][docs] 금액·시각 단위가 모듈마다 다름
- 목표: 금액 계산 규칙 정리(M0-07 `amounts.ts` 준비).
- 기대: 전 모듈 공통 단위.
- 실제: Trading `amount`는 최소 단위 정수 문자열(커넥터 `GetAggregatedQuoteRequest.amount` "1000000 = 1 USDT (decimals=6)"). DeFi는 "Amounts: Human-readable decimal strings (e.g. "1000.5"), not the token's smallest unit"(L3684), "Timestamps: Unix time in seconds"(L3685). 엔벨로프·RWA 시각은 ms.
- 문서: § DeFi Introduction › Data Format Conventions.
- 잃은 시간: 0.
- 우회: 금액 타입을 모듈별로 분리할 예정(M0-07). 10^18배 실수 위험 기록.
- 요청: 전 모듈 단위 통일 또는 필드명에 단위 표기.
- 증거: L3684–3685.

## 2026-09-23 18:01 UTC — [tx][docs] 브로드캐스트 body 설명이 오류 페이지와 흐름 문서에서 다름
- 목표: 브로드캐스트 요청 형태 확인(Q-14).
- 기대: 한 가지 body.
- 실제: Transaction API 오류 페이지의 40001 원인에 "Broadcast request is missing both `evmTx` and `solTx` (one is required)"(L2024). Trading·DeFi 통합 흐름과 커넥터는 `{binanceChainId, address, signedTransaction, enableMevProtection}`(L2575, L4065).
- 문서: § Error Codes (Transaction API) › Parameter Errors; § Integration Flow › Step 5.
- 잃은 시간: 0.
- 우회: 흐름 문서·커넥터 형태를 따름, G1/M1-03 실호출로 확인.
- 요청: 오류 설명 수정(아마 simulate에 해당).
- 증거: 위 줄 번호.

## 2026-09-23 18:02 UTC — [trading][docs] bStock 예시에 Ondo 접미사 토큰
- 목표: 발행사별 토큰 구분 규칙 확인(M0-05 준비).
- 기대: 예시가 접미사 규칙과 일치(Ondo `…on`, bStock `…B`, xStocks `…x`, L7430–7432).
- 실제: "BStock tokens (type=3): Exchange-traded stock tokens (e.g. PALLon/Palladium, TSLAB/Tesla)"(L2242) — `PALLon`은 Ondo 접미사.
- 문서: § Introduction (Trading API) › Equity Token Trading (RWA).
- 잃은 시간: 0.
- 우회: 발행사 판정은 접미사가 아니라 RWA 목록의 `platformId`로(M0-05).
- 요청: 예시 수정.
- 증거: L2242.

## 2026-09-23 18:03 UTC — [rwa][docs] RWA 응답 필드 설명이 llms-full.txt에 없고 커넥터 타입에만 있음
- 목표: 가격 괴리 가드(SPEC §5.5)의 참조가 정의 확인(Q-06).
- 기대: RWA Data 섹션에 응답 필드 설명.
- 실제: llms-full.txt의 RWA 설명은 기능 표(L3332–3341)와 API Reference 한 줄뿐. `referencePrice`가 "A per-share converted price derived from the on-chain token price, not an official quote from the traditional stock market"이라는 핵심 정의, `statusInfo`(openState·marketStatus·reasonCode·reasonMsg·nextOpenTime), `tokenToShareRatio`는 커넥터 `index.d.mts` 주석에만 있음.
- 문서: § Introduction (Market API) › RWA Data; § API Reference › RWA Data.
- 잃은 시간: 10분.
- 우회: `pnpm endpoints`가 커넥터 타입에서 필드를 뽑아 ENDPOINTS.md에 기록.
- 요청: llms-full.txt에 엔드포인트별 파라미터·응답 필드 표 포함.
- 증거: `docs/vendor/ENDPOINTS.md` §3·RWA 표, DECISIONS Q-06.

## 2026-09-23 18:12 UTC — [web3api][auth] 문서의 JS 서명 헬퍼는 `'`가 든 쿼리에서 서명과 전송 바이트가 달라짐(추정, 실측 전)
- 목표: 서명 대상 문자열 = 전송 문자열 보장(V-02).
- 기대: 문서 예제를 따르면 안전.
- 실제: 문서 JS 헬퍼는 `encodeURIComponent`로 쿼리를 만듦(L332). `encodeURIComponent("'")`는 `'`를 그대로 두지만 WHATWG URL 파서(Node fetch, axios의 `new URL`)는 쿼리의 `'`를 `%27`로 바꿔 보냄 → `keyword=McDonald's` 같은 값이면 서명한 path와 전송 path가 달라 40102가 날 것으로 예상. 오프라인 재현: `new URL("https://h/p?q='").search === "?q=%27"`. 커넥터는 URLSearchParams로 만든 뒤 그 결과로 서명해 문제없음(공백은 `+`).
- 문서: § Authentication › Complete JavaScript Example.
- 잃은 시간: 10분.
- 우회: 우리 인코더는 RFC 3986 엄격 인코딩(`!'()*`까지 인코딩) + 전송 전 `new URL()` 왕복 검사(`sign.ts` `buildTarget`, `sign.test.ts`).
- 요청: 예제를 "전송할 URL 문자열에서 path+query를 떼어 서명"하는 방식으로.
- 증거: `packages/binance/src/sign.test.ts` "encodes the apostrophe…". 서버 측 확인은 G1(`rwa/search`에 `'` 포함 keyword).

## 2026-09-23 18:16 UTC — [web3api][auth] 첫 호출(서명 없음): HTTP 401, code 40101 "API Key is required", 641 ms
- 목표: `pnpm reach` 미서명 도달 확인(M0-03).
- 기대: 키 없이 게이트웨이까지 도달, 문서상 40101 메시지는 "Invalid API Key"(L1890).
- 실제: `GET https://web3.binance.com/build/api/v1/dex/market/supported/chain` → HTTP 401, body `code 40101`, msg `"API Key is required"`, 641 ms(재실행 374 ms), 응답 `timestamp` 기준 시계 차 +454 ms. API 경로는 WAF 챌린지 없음(문서 사이트와 다름). 지역 차단 코드(40301) 없음 — 단 이 호출은 **미국 소재 클라우드 샌드박스**에서 나갔고 키 없는 요청이라 지역 판정 단계 전일 수 있음. 한국 회선 결과가 아님(Q-01은 M0-04에서).
- 문서: § Authentication › Error Codes; § Error Codes (Market API) › Authentication & Authorization Errors.
- 잃은 시간: 0.
- 우회: 없음.
- 요청: 40101 메시지를 문서와 일치(또는 문서에 메시지 변형 명시).
- 증거: `pnpm reach` 출력(REGION_TAG unset), 샌드박스 로컬 DB `api_calls` 1행(`market/getSupportedChains`, 401, 40101) — 커밋하지 않음.

## 2026-09-23 18:20 UTC — [web3api][latency] 커넥터 기본 타임아웃 1,000 ms·재시도 3회(실측 필요)
- 목표: 타임아웃 기본값 결정.
- 기대: 견적 같은 느린 호출에 맞는 기본값.
- 실제: `@binance/common@2.4.9` `ConfigurationRestAPI` 기본 `timeout: param.timeout ?? 1e3`(dist/index.mjs L672), `retries 3`, `backoff 1000`. 실제 p95가 1 s를 넘는 엔드포인트가 있으면 커넥터 사용자는 기본값에서 타임아웃을 겪게 됨. 위 미서명 호출이 641 ms였으므로 서명·견적 호출 실측 필요.
- 문서: llms-full.txt에 커넥터 타임아웃 언급 없음(§ JavaScript, L1096).
- 잃은 시간: 0.
- 우회: 우리 클라이언트 기본 15 s, 모든 호출의 지연을 api_calls에 기록해 p95로 판단.
- 요청: 문서에 권장 타임아웃과 엔드포인트별 지연 목표 공개.
- 증거: 위 소스 위치. p50/p95는 `pnpm dx:metrics`(G1 이후).
