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
| D-09 | 캡: 하우스 1회 $25, 샌드박스 플랜 $5, 일일 $50, 최소 매수 $2(임시), 원금 상한 $1,000 | 안전 | M0-06 |
| D-10 | 하우스 플랜 2개: H-SAFE(NVDA 일 $5), H-YIELD(QQQ 또는 MSFT, 원금 $200~500 주 1회) | 데모 빈도 + 창의성 증명 | M0-05·06 |
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
| Q-03 | 소액($1~$5) 주문 최소금액과 경로(RFQ vs AMM) | M0-06 | 문서(9/23): 경로 — Ondo는 항상 RFQ, bStock은 LiquidMesh SWAP + PcsXRfq RFQ 혼합, xStocks는 AMM SWAP(§ Introduction (Trading API) › Equity Token Trading). 최소액 — Ondo는 `40375 ONDO_FROM_USD_AMOUNT_TOO_SMALL`의 msg로 반환(문서 예시 "Minimum order amount is 20 USD."), bStock 최소액은 문서에 없음. 실측 대기(M0-06) | 최소 > $5면 MIN_BUY 상향, Judge Mode 금액 조정 |
| Q-04 | Trading 견적 유효시간, RFQ 발행사 `userWalletAddress` 필수 여부 | 문서 + M0-06 | 문서(9/23): `quoteId` TTL **30초**, 초과 시 `/swap`이 `40401 QUOTE_EXPIRED`(SPEC §5.6의 "60초" 가정은 틀림 → 30초 미만으로). RFQ 경로(Ondo·bStock)는 `/quote`에 `userWalletAddress` **필수**(누락 시 40001), 그 지갑이 EIP-712 서명자여야 함. `/swap`도 `userWalletAddress` 필수 + `slippagePercent` 또는 `autoSlippage=true`. 실측 대기(M0-06) | 재견적 규칙 조정 |
| Q-05 | DeFi API 예치·상환 콜데이터 형태(Venus USDT), 상환 지연 유무 | M0-07 | 문서(9/23): Venus는 `defiProtocolId=venus`, Earn, deposit/redeem/claim 지원. build 응답 `data.dataList[]`(APPROVE 먼저, 그다음 DEPOSIT/REDEEM; 항목 필드 `callDataType, from, to, value(hex), data, gasLimit, gasPrice(null), maxPriorityFeePerGas, maxFeePerGas`), `simulate=true`면 `preview`, redeem은 `redeemDelayDays`(`[]`=즉시; 대기 예시는 helio·astherus, Venus 언급 없음). 금액은 사람 단위 소수 문자열. ⚠️ APPROVE는 무제한 → Q-16. 실측 대기(M0-07) | 콜데이터 미제공 시 직접 컨트랙트 호출(모듈 점수 일부 손실, 기록) |
| Q-06 | `referencePrice`의 정의(독립 시세 vs 온체인 파생) | 문서 + 정규장 실측 비교 | 문서(9/23, 커넥터 타입 설명 `GetRwaTokenPriceResponseDataInner`, `…UnderlyingMarketDataResponseDataMarketData`): "A per-share converted price **derived from the on-chain token price**, not an official quote from the traditional stock market." → 파생. API 안에는 독립 주가가 없음. SPEC §5.5 괴리 가드는 이 값으론 의미가 약함 — 정규장 실측으로 확인 후 사람 결정 | 파생이면 UI에 "플랫폼 참조가"로 표기, 괴리 임계 완화 |
| Q-07 | `baw`의 RWA 토큰 `market-order swap`·`limit-order`·`defi deposit(Venus USDT)` 지원 | M0-09 | | swap 미지원 시 모드 C 범위 축소·DX 1순위 요청 |
| Q-08 | BSC에 무허가 거래 가능한 토큰화 국채 토큰이 있나 | RWA Data 플랫폼 목록 + Trading 견적 | | 있으면 이자 원천 옵션 2로 Should 추가 |
| Q-09 | Agent Studio 런타임이 우리 워커를 돌릴 수 있나, 지갑·비용 | M0-10 | | no-go면 신원 등록만 |
| Q-10 | Web3 API 레이트리밋 실제값(등록 후 상향치) | 문서 + 429 관측 | 문서(9/23) 기본값: IP당 1,200/60s, 키당 1,200/60s, 사용자당 6,000/60s, 엔드포인트당 5 RPS; 429 + `Retry-After`(초). DeFi는 "모든 DeFi 엔드포인트가 기본 5 QPS 공유". 등록 후 상향치는 **미확인: 문서에 없음** → 429·`X-OC-RateLimit-*` 헤더 관측(G1) | 토큰버킷 조정 |
| Q-11 | Agentic Wallet 세션 상한(48h?)과 비활성 로그아웃 실제값 | M0-09 `wallet settings` | 문서(9/23): "maximum validity period"와 비활성 자동 로그아웃이 있고 로그아웃은 조용히 일어난다(`sessionExpireTime`으로 확인) — § bStock AI PnL Trading Competition. 수치는 **미확인: 문서에 값 없음** → M0-09 | 모드 C 알림 임계 조정 |
| Q-12 | Venus USDT 현재 APY, 이용률, 보안점수 | M0-07 | | 하우스 원금 결정 |
| Q-13 | bStocks `uiMultiplier` 읽기 방법(BEP-677 함수명) | 온체인 ABI 확인 | 문서(9/23): RWA 목록·underlying-profile에 `tokenToShareRatio`("1.003701 means 1 token ≈ 1.003701 underlying shares")가 있고 별도 `multiplier` 필드는 없음. BEP-677 함수명은 **미확인: llms-full.txt에 온체인 ABI 설명 없음** → 온체인 확인(M0-05) | Ondo는 목록 `multiplier` → 실제 필드명은 `tokenToShareRatio` |
| Q-14 | Transaction API 브로드캐스트 응답·상태 조회 형태 | M0-07 시뮬 + M1-03 | 문서(9/23): `POST …/broadcast-transaction` body `{binanceChainId, address, signedTransaction, enableMevProtection?}` → `data.txHash`, `data.orderId`. 상태는 Wallet API `GET …/transaction-detail-by-txhash`의 `data[].txStatus`(pending/success/fail), 직후엔 빈 배열 가능. 시뮬레이션 `POST …/simulate` 응답 `status, failReason, balanceChanges[], allowanceChanges[]`. 실측 대기 | 폴백 RPC 경로 계측 |
| Q-15 | RFQ 경로(Ondo 전부, bStock의 PcsXRfq 경로)는 트랜잭션 브로드캐스트가 아니라 EIP-712 서명 주문(`GET /swap`의 `rfq.typedDataToSign` → `POST /order/submit` → `GET /order/{orderId}`)이라 Transaction API로 시뮬레이션할 대상이 없다. CLAUDE.md 규칙 5("브로드캐스트 전 시뮬레이션", "새 지출 경로는 사람의 명시적 yes")를 어떻게 적용하나 | 문서(§ Integration Flow (Trading API) › RFQ Mode) + M0-06 견적에서 경로 비율 관측 | 미해결: 사람 결정 필요. 선택지 (a) bStock의 SWAP(LiquidMesh) 경로만 사용 — 시뮬레이션·브로드캐스트 규칙 그대로, Ondo 제외 (b) RFQ 허용 — typed data의 금액·수령자·만료를 서명 전 검증하고 캡 적용, 새 지출 경로로 승인 기록 | (a)면 Q-02 분기(Ondo 대체)와 충돌하므로 같이 결정 |
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

## 3. Ideas parked (범위 밖, 기록만)
- 발행사 간 최적 체결 (bStocks vs Ondo 실시간 비교 후 체결)
- BNB 스테이킹 보상 이자원
- 웹 지갑 연결(모드 D)
- 사용자 텔레그램 알림
- 주식 선물하기(전송)
