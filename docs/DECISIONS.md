# DECISIONS.md — 잠긴 결정과 열린 질문

작성: 박지우. 갱신: 누구든 ⚠️VERIFY를 닫으면 여기에 적는다. 결정은 번호로 참조한다.

## 1. 잠긴 결정

| ID | 결정 | 근거 | 재검토 조건 |
| --- | --- | --- | --- |
| D-01 | 제품: 이자로 주식 사는 에이전트. 안전 모드 기본, 이자 모드 선택 | JUDGING §3 매핑, PLAN §2 | 없음 (대회 중 피벗 금지) |
| D-02 | 예약주문·지정가 엔진은 만들지 않는다 | Agentic Wallet `limit-order` 존재 | 없음 |
| D-03 | 서버는 사용자 키·세션을 저장하지 않는다. 모드 C 서명은 사용자 기기 | 공식 스킬 자격증명 정책, 커스터디 회피 | 없음 |
| D-04 | 우리 서버에 LLM 없음. 결정은 순수 규칙 | 심사 신뢰성, 재현성 | 없음 |
| D-05 | 이자 원천은 Venus 코어 풀 USDT 하나 | 허용 목록 최소화, 보안점수 표시 가능 | 토큰화 국채 토큰이 BSC에서 무허가 거래 가능하면 Q-08 |
| D-06 | 서버 리전 프랑크푸르트. 암스테르담·런던·도쿄·싱가포르 금지 | 제한 지역·차단 보고 | M0-04 결과 |
| D-07 | 주식 토큰 주소는 코드 상수 금지, API 생성 레지스트리 + 온체인 검증 | 하드코딩 감점, 발행사 변경 대응 | 없음 |
| D-08 | 정규장 창구 매수가 기본, 24시간은 옵션(한도 절반) | 장외 프리미엄 회피, DX 소재 | 없음 |
| D-09 | 캡: 하우스 1회 $25, 샌드박스 플랜 $5, 일일 $50, 최소 매수 $2(임시), 원금 상한 $1,000. **M0-06 제안(9/24, 장외 측정)**: `MIN_BUY_USD` 잠정 **$2 유지**(변경 없음) — bStock은 $1 견적도 나옴. Ondo는 최소 "5 USD" 초과($5.00 거부)라 Ondo로 체결하는 플랜은 매수액 ≥ $6 필요 → 발행사별 최소액을 인스트루먼트에 두는 안을 M1-01에 제안. 정규장 재측정 후 확정(Q-03) | 안전 | M0-06 |
| D-10 | 하우스 플랜 2개: H-SAFE(NVDA 일 $5), H-YIELD(QQQ 또는 MSFT, 원금 $200~500 주 1회). **M0-05·06 제안(9/24)**: 기본 발행사 **bStocks**(`issuerPreference ["bstocks","ondo"]`) — NVDA·TSLA·MSFT·QQQ 존재, $1 소액 견적 OK, 견적에 지갑 주소 불필요, 배수가 온체인(`uiMultiplier`). Ondo는 폴백(AAPL은 Ondo만). H-SAFE = NVDAB, H-YIELD = QQQB 제안. 확정은 Q-02(한국 거주자 bStocks 거래 가능 여부) 답을 받은 뒤 사람이 | 데모 빈도 + 창의성 증명 | M0-05·06 |
| D-11 | DX 리포트는 사람이 쓴다. 에이전트는 수치·표·증거만 | 공식 규정(AI 생성 불수용) | 없음 |
| D-12 | 스택: TS monorepo, Next.js(Vercel fra1), Node 워커(Fly/Render Frankfurt), Postgres(Neon fra), viem, Drizzle | 팀 숙련도, 배포 속도 | 없음 |
| D-13 | 브로드캐스트는 Transaction API 우선, RPC 폴백. 시뮬레이션은 항상 Transaction API | 모듈 커버리지 + 안정성 | 없음 |
| D-14 | 제출 목표 10/9(금). 10/9 이후 배포 금지 | 버퍼 확보 | 없음 |
| D-15 | 이름 가칭 "이자로 (Ijaro)". 확정은 10/1 전 | — | 10/1 |

## 2. 열린 질문 (M0에서 닫는다)

| ID | 질문 | 검증 방법 | 결과 | 분기 |
| --- | --- | --- | --- | --- |
| Q-01 | 한국 회선에서 Web3 API 도달? (40304 여부) | M0-04 `pnpm reach` KR/FRA/ICN | **실측(9/24 00:17 UTC, 한국 개발 PC, REGION_TAG=kr-dev): 도달 OK** — 미서명 401/40101(139 ms), 서명 RWA 목록·가격 배치 200/code 0, 지역 코드 없음. FRA·ICN은 M0-04에서. 문서(9/23): 제한 지역 목록에 KR 없음(§ Service-Restricted Countries & Regions). 지역 코드는 `40301`(지역)·`40302`(프록시/VPN 탐지)·`40303`("frequent location switching or concurrent multi-region access")·`40304`(DeFi 컴플라이언스). ⚠️ 같은 키를 KR·FRA·ICN에서 동시에 쓰면 40303, SSH 터널 폴백은 40302 위험 — M0-04에서 관측 | 차단 시 개발도 프랑크푸르트 경유(SSH 터널 또는 원격 개발) |
| Q-02 | 한국 거주자가 bStocks를 거래할 수 있나 | 텔레그램 질문 + M0-06 견적 | | 불가 시 기본 발행사 Ondo(D-10 수정), 문구 수정 |
| Q-03 | 소액($1~$5) 주문 최소금액과 경로(RFQ vs AMM) | M0-06 | **실측(9/24 00:46 UTC, US overnight = 장외만)**: 경로 — NVDA·QQQ 모두 두 발행사 `LiquidMesh/SWAP`(Ondo도 SWAP, dex 이름 "Rfq Halfmoon" — 문서 "Ondo는 항상 RFQ"와 다름). 최소액 — Ondo `40375 "Minimum order amount is 5 USD."`($1·$5 거부, $5.01·$6 통과), bStock은 $0.10·$1도 견적 OK(최소액 미관측). 가격영향 $50까지 ≈0%. 표: dx/LOG.md 2026-09-24 00:46. **정규장 재측정 필요**(13:30~20:00 UTC; 테이프가 $5/$50/$500을 10분마다 기록 중). 문서(9/23): Ondo 최소액은 msg로 반환, 예시 "20 USD", bStock 최소액 문서 없음 | 최소 > $5면 MIN_BUY 상향, Judge Mode 금액 조정 |
| Q-04 | Trading 견적 유효시간, RFQ 발행사 `userWalletAddress` 필수 여부 | 문서 + M0-06 | **실측(9/24 00:52 UTC)**: TTL — 견적 직후 `/swap` OK, 35초 뒤 같은 quoteId → `40401 "quoteId=… not found or expired"`(NVDAB·NVDAon 둘 다). 문서의 30초와 모순 없음(30초 정확 경계는 미측정) → 재견적 기준 25초 제안. `userWalletAddress` — Ondo는 누락 시 `40001 "userWalletAddress is required for RFQ (Ondo) quote"`(경로가 SWAP이어도), bStock은 없어도 견적 OK. 장외 `/swap`은 두 발행사 모두 `executionMode SWAP` + `tx`(to 라우터 `0xB444…DdA5`), `rfq` null. 픽스처 `fixtures/trading/buildSwapTransaction-20260924-*.json` | 재견적 규칙 조정 |
| Q-05 | DeFi API 예치·상환 콜데이터 형태(Venus USDT), 상환 지연 유무 | M0-07 | **실측(9/24 00:49 UTC, 하우스 주소, 잔고 USDT 0·BNB 0)**: `investmentId 5b77bfd8…63cb`(Venus USDT Earn). build 응답 `dataList` — deposit = APPROVE(`USDT.approve(vUSDT, type(uint256).max)` 무제한) → DEPOSIT(`vUSDT.mint(uint256)`, 셀렉터 `0xa0712d68`, to `0xfD58…0255`, gasLimit 없음); redeem = REDEEM(`vUSDT.redeem(uint256)`, `0xdb006a75`), `redeemDelayDays []` → **즉시 상환**. `simulate=true`는 미충전 주소를 `40484`로 거부(잔고 부족·포지션 없음이 같은 코드) → `simulate=false`로 콜데이터 확보. Transaction API 시뮬레이션: APPROVE `SUCCESS`(allowance 0→max), DEPOSIT `FAILED "execution reverted: BEP20: transfer amount exceeds balance"`, REDEEM `FAILED "execution reverted: math error"` — 콜데이터 형태는 확인, **성공 시뮬레이션은 하우스 충전(M0-11) 후 재실행 필요**. 픽스처 `fixtures/defi-transaction/build*-20260924-*.json`, `fixtures/transaction/simulateTransactions-20260924-{1,2,3}.json` | 콜데이터 미제공 시 직접 컨트랙트 호출(모듈 점수 일부 손실, 기록) |
| Q-06 | `referencePrice`의 정의(독립 시세 vs 온체인 파생) | 문서 + 정규장 실측 비교 | **실측(9/24 00:55 UTC)**: `referencePrice = tokenPrice ÷ tokenToShareRatio` — 테이프 9종 모두 상대 오차 ≤ 5.4e-10 → 온체인 파생 **확정**, 독립 시세 아님. 따라서 SPEC §5.5 괴리 가드(`onchain/reference − 1`)는 항상 ≈0으로 의미 없음. **미해결: 대체 기준은 사람 결정**(후보: underlying-market `marketData` — 독립 시세인지 미확인, 또는 발행사 간 가격 비교). 문서(9/23): 커넥터 설명 "derived from the on-chain token price" | 파생이면 UI에 "플랫폼 참조가"로 표기, 괴리 임계 완화 |
| Q-07 | `baw`의 RWA 토큰 `market-order swap`·`limit-order`·`defi deposit(Venus USDT)` 지원 | M0-09 | | swap 미지원 시 모드 C 범위 축소·DX 1순위 요청 |
| Q-08 | BSC에 무허가 거래 가능한 토큰화 국채 토큰이 있나 | RWA Data 플랫폼 목록 + Trading 견적 | | 있으면 이자 원천 옵션 2로 Should 추가 |
| Q-09 | Agent Studio 런타임이 우리 워커를 돌릴 수 있나, 지갑·비용 | M0-10 | | no-go면 신원 등록만 |
| Q-10 | Web3 API 레이트리밋 실제값(등록 후 상향치) | 문서 + 429 관측 | 문서(9/23) 기본값: IP당 1,200/60s, 키당 1,200/60s, 사용자당 6,000/60s, 엔드포인트당 5 RPS; 429 + `Retry-After`(초). DeFi는 "모든 DeFi 엔드포인트가 기본 5 QPS 공유". 등록 후 상향치는 **미확인: 문서에 없음** → 429·`X-OC-RateLimit-*` 헤더 관측(G1). **실측(9/24)**: 견적 `x-oc-ratelimit-limit: 5`, 6번째 요청이 첫 요청 후 422 ms에 `429 / 42900`, `Retry-After: 1` → 게이트웨이는 임의의 1초 창 5건(토큰버킷 5/5는 초과). 클라이언트를 슬라이딩 창 5건/1,250 ms로 수정 후 429 0건(dx/LOG.md 01:52). 등록 후 상향치는 여전히 미확인 | 토큰버킷 조정 |
| Q-11 | Agentic Wallet 세션 상한(48h?)과 비활성 로그아웃 실제값 | M0-09 `wallet settings` | 문서(9/23): "maximum validity period"와 비활성 자동 로그아웃이 있고 로그아웃은 조용히 일어난다(`sessionExpireTime`으로 확인) — § bStock AI PnL Trading Competition. 수치는 **미확인: 문서에 값 없음** → M0-09 | 모드 C 알림 임계 조정 |
| Q-12 | Venus USDT 현재 APY, 이용률, 보안점수 | M0-07 | **실측(9/24 00:49 UTC)**: DeFi API — Venus USDT `apyBps 316`(3.16%), 투자 TVL $185,541,887, Venus 프로토콜 TVL $1,353,914,642, securityScore **93.1**(codeSecurity 96, fundamentalHealth 92.5, operationalResilience 84.96, communityTrust 98, governanceStrength 88.45, marketStability 94.18). 온체인(블록 123664140) — 이용률 **72.78%**(cash 50.52M, borrows 135.12M, reserves 52.9), MINT·REDEEM 일시정지 없음, `supplyRatePerBlock 445461184` → 블록당 복리 연 **3.17%**(BSC 블록 간격 실측 0.450초 = 연 70,056,648블록, 9/24 02:05 UTC) ≈ API 3.16%. 처음 적은 1.89%는 0.75초 블록 가정 오류였음(dx/LOG.md 02:11 정정). 기본 공급 이자만으로 API 값과 맞으므로 `apyBps`에 XVS 보상은 없거나 0. APY를 블록 수로 환산할 때는 블록 간격을 상수로 두지 말고 실측하거나 API `apyBps`를 쓴다. 하우스 원금 결정은 사람 몫. 픽스처 `fixtures/defi-data/*-20260924-*.json` | 하우스 원금 결정 |
| Q-13 | bStocks `uiMultiplier` 읽기 방법(BEP-677 함수명) | 온체인 ABI 확인 | **실측(9/24 00:41 UTC)**: bStocks 토큰(beacon proxy) 구현에 `uiMultiplier()`(1e18 스케일), `newUIMultiplier()`, `effectiveAt()`(unix 초, 0 = 예정 없음) — 바이트코드 셀렉터로 확인, 문서엔 ABI 없음. 값은 API `tokenToShareRatio`와 정확히 같음(NVDAB 1.000778223752807865, MSFTB 1.001313964833366845, QQQB 1.000724838657573033, TSLAB 1). Ondo 토큰엔 이 함수들이 없음 → Ondo 배수는 API `tokenToShareRatio`. 코드: `packages/chain` `readBstockMultiplier`, `pnpm registry`가 대조 | Ondo는 목록 `multiplier` → 실제 필드명은 `tokenToShareRatio` |
| Q-14 | Transaction API 브로드캐스트 응답·상태 조회 형태 | M0-07 시뮬 + M1-03 | **시뮬레이션 실측(9/24 00:49 UTC)**: `POST …/simulate` body `{binanceChainId, evmTx:{from,to,value,data}}` → HTTP 200 code 0이 **실패 시에도** 옴; `data = {status:"SUCCESS"|"FAILED", failReason:""|"execution reverted: …", balanceChanges:[], allowanceChanges:[{tokenAddress, owner, spender, preAmount, postAmount}]}` → `status`를 반드시 봐야 함. **브로드캐스트·상태 조회 응답: 미해결 — M0 제약(브로드캐스트 금지), M1-03 첫 실거래에서 확인**. 문서(9/23): broadcast → `data.txHash`, `data.orderId`; 상태는 `transaction-detail-by-txhash` `data[].txStatus` | 폴백 RPC 경로 계측 |
| Q-15 | RFQ 경로(Ondo 전부, bStock의 PcsXRfq 경로)는 트랜잭션 브로드캐스트가 아니라 EIP-712 서명 주문(`GET /swap`의 `rfq.typedDataToSign` → `POST /order/submit` → `GET /order/{orderId}`)이라 Transaction API로 시뮬레이션할 대상이 없다. CLAUDE.md 규칙 5("브로드캐스트 전 시뮬레이션", "새 지출 경로는 사람의 명시적 yes")를 어떻게 적용하나 | 문서(§ Integration Flow (Trading API) › RFQ Mode) + M0-06 견적에서 경로 비율 관측 | 미해결: 사람 결정 필요. 관측(9/24 장외): Ondo·bStock 모두 `executionMode SWAP` 견적·`/swap tx`가 나와(dx/LOG.md 00:46·00:52) 장외에선 RFQ 서명이 필요 없었음 — 정규장 경로는 재측정. 선택지 (a) bStock의 SWAP(LiquidMesh) 경로만 사용 — 시뮬레이션·브로드캐스트 규칙 그대로, Ondo 제외 (b) RFQ 허용 — typed data의 금액·수령자·만료를 서명 전 검증하고 캡 적용, 새 지출 경로로 승인 기록 | (a)면 Q-02 분기(Ondo 대체)와 충돌하므로 같이 결정 |
| Q-16 | DeFi build의 APPROVE 항목은 **무제한**(`type(uint256).max`) 승인(§ Integration Flow (DeFi API) › Calldata Validity & Approvals). 규칙 5 "정확 금액 승인만"과 충돌 | M0-07 콜데이터 디코드 | 미해결. 제안: APPROVE 항목은 서명하지 않고 같은 spender에 대해 정확 금액 `approve(spender, amount)`를 직접 인코딩(spender는 APPROVE 콜데이터 디코드로 얻고 DEPOSIT 항목 `to`와 교차검증), 시뮬레이션 후 브로드캐스트. Trading `/approve-transaction`은 `approveAmount`를 받으므로 정확 승인 가능 | 불가하면 이자 모드 예치를 직접 컨트랙트 호출로(Q-05 분기와 동일) |


### 2.1 SPEC §3.1 ⚠️VERIFY — 문서 확인 결과 (M0-02, 2026-09-23 UTC)

출처는 `docs/vendor/llms-full.txt`(scripts/fetch-docs.sh로 받은 스냅샷, 8,416줄)의 섹션 제목과 줄 번호, 그리고 공식 커넥터
`@binance-web3/wallet@12.3.0`/`@binance-web3/common@1.1.0`. 엔드포인트별 표는 `docs/vendor/ENDPOINTS.md`. 실호출 검증은 G1(키 발급 후).

| ID | 항목 | SPEC 가정 | 문서 결과 | 판정 | 출처 |
| --- | --- | --- | --- | --- | --- |
| V-01 | Base URL | `https://web3.binance.com/build` | 같음. `/build` 없는 `…/api/v1/…`는 엣지에서 리다이렉트되지만 서명에 쓰면 안 됨 | 확인 | § Authentication › Base URL & Required `/build` Prefix (L158); 커넥터 `WEB3_WALLET_REST_API_PROD_URL` |
| V-02 | 서명 문자열 | `timestamp + METHOD + path + body`, path에 `/build`와 쿼리 포함 | 같음. path는 전송된 그대로의 원시 인코딩(재정렬·디코드 금지), GET/HEAD body는 `""` | 확인 | § Authentication › 3.1 Build the Pre-Hash String (L193) |
| V-03 | 서명 알고리즘 | base64(HMAC-SHA256(secret, preHash)) | 같음(UTF-8). 커넥터는 Ed25519 키도 지원 | 확인 | § Authentication › 3.2 Sign with HMAC-SHA256 (L239); `@binance-web3/common` `Web3RequestSigner.signWeb3` |
| V-04 | 헤더명 | `X-OC-APIKEY`, `X-OC-TIMESTAMP`(ISO 8601 ms), `X-OC-SIGN`, 선택 `X-OC-RECV-WINDOW` | 같음 + 선택 `X-OC-NONCE`(재전송 방지, 없으면 `X-OC-SIGN`이 nonce). RECV-WINDOW 기본 5,000ms·최대 60,000ms, 창 밖이면 `40103`. 단, 커넥터는 이 둘을 `recvWindow`/`nonce`라는 이름의 헤더로 보냄(불일치, dx/LOG.md) | 확인(+추가) | § Authentication › Step 2 (L144), › Timestamp & Anti-Replay (L375) |
| V-05 | 엔벨로프 | `{code, msg, data, success, timestamp}`, HTTP 200 오류 가능, 게이트웨이 401엔 `success` 없음 | 기본 `OCResult<T>` 같음(`code=0` 성공). Market·Trading·Transaction·Wallet 오류 페이지: "오류 포함 모든 응답 HTTP 200". Authentication·DeFi·B402 페이지: 게이트웨이 오류는 400/401/403/429/500/503 + body `{code,msg,data:null,timestamp}`(`success` 없음). **B402는 다른 엔벨로프** `{status,type,code:string,errorData,data,subData,params}`, 성공 코드 `"000000000"` | 확인(+B402 예외) | § Overview › Unified Response Format (L94); 각 § Error Codes › Response Format (L1842, L1988, L2952, L3356, L4226); § Integration Guide (B402) (L4881) |
| V-06 | 레이트리밋 | 엔드포인트당 5 req/s, 키·IP당 1,200/min, 429는 `Retry-After` | 같음 + 사용자당 6,000/60s. `Retry-After`는 초. 응답 헤더 `X-OC-RateLimit-Limit/-Remaining`, `X-OC-Used-Weight`. DeFi는 전 엔드포인트 공유 5 QPS. 등록 후 상향치는 **미확인: 문서에 없음**(Q-10) | 확인(+추가) | § Authentication › Rate Limits (L392); § DeFi Introduction › Rate Limits (L3688) |
| V-07 | 견적 유효시간 | 미정(§5.6 "실행 직전 60초 넘으면 재견적") | `quoteId` TTL 30초, 초과 시 `40401` | **수정**: 재견적 기준 < 30초 | § Introduction (Trading API) › Key Constraints (L2276); § Error Codes (Trading API) › Quote (L3047) |
| V-08 | RFQ `userWalletAddress` | 필수? | RFQ 경로 필수(Ondo·bStock), 서명 지갑과 일치해야 함 | 확인 | § Key Constraints (L2276) |
| V-09 | Market 가격 배치 | `POST …/market/price`, 배열 body | POST·배치 최대 100개는 확인. body 스키마는 llms-full.txt에도 커넥터 타입(`GetTokenPriceRequest`)에도 없음. **실측(9/24 00:17 UTC, 한국)**: body `[{"binanceChainId":"56","tokenContractAddress":"0x…"}]` 3개 → HTTP 200 code 0, 가격 3건 | 확인(실측, 문서 미기재) | § Introduction (Market API) › General Data (L3302); § Error Codes (Market API) (L3392) |
| V-10 | 엔드포인트 경로 | 모듈별 ⚠️VERIFY | llms-full.txt API Reference 65개 = 커넥터 65개, 메서드·경로 전부 일치(`pnpm endpoints`, 불일치 0) | 확인 | § API Reference; `docs/vendor/ENDPOINTS.md` |
| V-11 | 에러코드(§11) | 40001, 40101–40104, 40304(지역), 40369(RFQ 장외), 40374(유동성), 40365–40375, 429 | 40001·40101–40104·40374 같음. 지역/컴플라이언스는 **40301**(지역)·40302(VPN/프록시)·40303(비정상 IP)·40304(DeFi 컴플라이언스). 장외는 bStock `40369`, Ondo `40367`. Ondo 최소액 `40375`. 레이트리밋 body 코드 `42900`. 코드는 모듈별 의미가 다름(`40470`) | **수정**(M1-07에 반영) | 각 § Error Codes |
| V-12 | 참조가 정의(§5.5) | 독립 시세? | 온체인 토큰가에서 파생된 주당 환산가 | 확인(Q-06) | 커넥터 타입 설명 |

### 2.2 M0-05 인스트루먼트 매트릭스 (BSC, 2026-09-24 00:45 UTC)

출처: RWA Data `GET /api/v1/dex/market/rwa/tokens?binanceChainId=56`(488종: ondo 442, bstock 46; xStocks는 BSC 목록에 없음) → `pnpm registry`가 온체인 검증 후 `instruments`에 기록(9행). 주소는 코드에 없고 이 표와 DB에만 있다(D-07). 픽스처 `fixtures/rwa/getRwaTokenList-20260924-1.json`.

| 티커 | bStocks | Ondo | xStocks | 온체인 검증 (symbol / decimals / 배수) |
| --- | --- | --- | --- | --- |
| NVDA | NVDAB `0x02fc…7436` | NVDAon `0xa9ee…6f75` | — | 둘 다 symbol·decimals 18 일치; NVDAB uiMultiplier 1.000778223752807865 = API |
| TSLA | TSLAB `0x5b19…292f` | TSLAon `0x2494…9d93` | — | 일치; TSLAB uiMultiplier 1 = API |
| AAPL | — (없음) | AAPLon `0x390a…18c4` | — | 일치 |
| MSFT | MSFTB `0x8010…b9b0` | MSFTon `0x6bfe…44c3` | — | 일치; MSFTB uiMultiplier 1.001313964833366845 = API |
| QQQ | QQQB `0x2058…efc7` | QQQon `0x0cde…559a` | — | 일치; QQQB uiMultiplier 1.000724838657573033 = API |

Ondo 배수(API `tokenToShareRatio`): NVDAon 1.0017152487959898, TSLAon 1, AAPLon 1.003376073740221058, MSFTon 1.005730856892783903, QQQon 1.004082430180208355.

## 3. Ideas parked (범위 밖, 기록만)
- 발행사 간 최적 체결 (bStocks vs Ondo 실시간 비교 후 체결)
- BNB 스테이킹 보상 이자원
- 웹 지갑 연결(모드 D)
- 사용자 텔레그램 알림
- 주식 선물하기(전송)
