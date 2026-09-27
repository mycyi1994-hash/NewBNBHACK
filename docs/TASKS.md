# TASKS.md — 티켓 백로그

작성: 박지우. 실행자: Opus 5.5 (엔지니어). 사람 담당 항목은 **[HUMAN]**.
규칙: 위에서 아래로. 한 번에 하나. 완료 시 체크박스 + 증거(명령 출력, tx 해시, 픽스처 경로, 스크린샷 경로). 기준 열은 JUDGING §3의 어느 행에 점수를 내는지.

상태 표기: `[ ]` 대기 · `[~]` 진행 · `[x]` 완료 · `[-]` 컷

---

## M0 접근·스파이크 (9/23 ~ 9/25) — 목표: 불확실성 제거, 계측 시작

### M0-00 [HUMAN] 등록·계정·자금
- [ ] 참가 등록 폼 제출(무료 API·레이트리밋 상향)
- [ ] 빌더 텔레그램 가입 후 질문 3개 게시: (a) 한국 거주자의 bStocks 거래 가능 여부 (b) `limit-order`·`market-order swap`의 RWA 토큰 지원 (c) 소액(≤$5) 주문 최소금액과 RFQ/AMM 경로
- [ ] Web3 API 키 신청(개발자 포털). **키를 연 시각을 기록**(온보딩 측정 시작점)
- [ ] Binance 앱에서 Agentic Wallet 생성, 소액 USDT·BNB 입금
- [ ] 계정: Vercel, Neon(프랑크푸르트), Fly 또는 Render, 업타임 모니터, 텔레그램 봇
- [ ] 하우스 지갑 예산 ≤ $300 (USDT $250 + BNB 가스 $10 상당) 준비

### M0-01 레포 부트스트랩 · 기준: 기술
- [x] pnpm workspace, TS strict, eslint/prettier, vitest, `packages/{core,binance,chain,db,config}`, `apps/{web,agent}`, `skills/ijaro`, `scripts/`, `fixtures/`, `dx/`
  - 증거: `pnpm-workspace.yaml`(apps/*, packages/*, scripts), `tsconfig.base.json`(strict + noUncheckedIndexedAccess), `eslint.config.mjs`(type-aware), `.prettierrc.json`, `vitest.config.ts`(패키지별 project). Node 22, TS 5.9.3, ESLint 10.11, Vitest 5.0.1, Next.js 16.3.6(App Router, Tailwind 4) — `pnpm --filter @ijaro/web build` 성공(`○ /` static).
- [x] GitHub Actions: typecheck·lint·test
  - 증거: `.github/workflows/ci.yml` — `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm lint` → `pnpm test`, api_calls 통합 테스트용 일회용 Postgres 16 서비스. 시크릿 없음.
- [x] `.env.example` 반영, `packages/config` zod 검증, 캡 상수
  - 증거: `packages/config/src/index.ts`(18개 변수 전부 zod, 캡 동결·상호 검증, live 모드 필수값, 비밀값 미노출). 테스트 `validates exactly the variables declared in .env.example`, `no source file outside packages/config mentions a cap variable`(캡은 config에서만 읽음) 통과. ESLint `no-restricted-properties`가 config 밖 `process.env` 금지.
- 수용: 클린 클론에서 `pnpm i && pnpm typecheck && pnpm lint && pnpm test` 녹색 — **확인**(2026-09-23 18:27 UTC, `git clone` 새 사본, `--frozen-lockfile`): install `Done in 2.1s using pnpm v10.33.0` · typecheck `scripts typecheck: Done` · lint `All matched files use Prettier code style!` · test `Tests 82 passed | 1 skipped (83)`(DB 없을 때), 테스트 DB를 주면 `Tests 83 passed (83)`. **CI 녹색**: GitHub Actions `ci` run #2 (https://github.com/mycyi1994-hash/NewBNBHACK/actions/runs/35902818616, 커밋 `03cc5d7`, 2026-09-23 18:30 UTC) — install·typecheck·lint·test 모두 success, `Test Files 9 passed (9)` · `Tests 83 passed (83)`(Postgres 서비스로 `@ijaro/db` 포함). run #1은 새 푸시로 취소됨(concurrency).

### M0-02 문서 수집 · 기준: DX
- [x] `scripts/fetch-docs.sh` 실행 → `docs/vendor/llms.txt`, `llms-full.txt`(gitignore), Skills Hub 얕은 클론
  - 증거: `bash scripts/fetch-docs.sh` 성공 — `143 llms.txt`, `8416 llms-full.txt`, skills-hub `9960c67`. 문서 호스트가 curl에 HTTP 202 WAF 챌린지(빈 본문)를 줘서 스크립트가 검증 후 헤드리스 Chromium으로 폴백(`scripts/fetch-docs-browser.mjs`, dx/LOG.md 17:44).
- [x] `@binance-web3/wallet` devDependency 설치, 서명·경로 소스 위치를 `docs/vendor/ENDPOINTS.md`에 정리(커밋)
  - 증거: `packages/binance/package.json` devDependency `@binance-web3/wallet` 12.3.0(서명은 `@binance-web3/common` 1.1.0 `Web3RequestSigner.signWeb3`). ENDPOINTS.md의 표는 `pnpm endpoints`(`scripts/gen-endpoints.ts`)가 llms-full.txt API Reference와 커넥터를 operationId로 조인해 생성: `65 doc operations, 65 connector operations, 4 anomalies`, 메서드·경로 불일치 0.
- [x] SPEC §3.1의 ⚠️VERIFY 항목을 문서 기준으로 1차 확인 → DECISIONS 기록
  - 증거: `docs/DECISIONS.md` §2.1 V-01~V-12(base URL, 서명 문자열, 헤더명, 엔벨로프, 레이트리밋, 견적 유효시간 30초 등), Q-01/03/04/05/06/10/11/13/14 결과 칸, 새 질문 Q-15(RFQ는 브로드캐스트가 아님)·Q-16(DeFi APPROVE 무제한). 문서로 못 닫은 항목은 "미확인: 이유"(V-09 가격 배치 body, Q-10 상향치, Q-13 ABI).
- 수용: ENDPOINTS.md에 모듈별 경로·필수 파라미터·응답 필드 표 — **확인**: General Data, Address Portfolio, RWA Data, Trading API, Transaction API, Wallet API, Defi Data, Defi Transaction, B402 Payments 표 + §1 Authentication, 각 행에 llms-full.txt 섹션 제목·줄 번호 출처.

### M0-03 Web3 API 클라이언트 v0 · 기준: 기술·DX
- [x] 서명, 엔벨로프, 엔드포인트별 토큰버킷, 429 처리, `api_calls` 기록, 픽스처 저장 (오프라인 부분, G0)
  - 증거: `packages/binance/src/` — `sign.ts`(RFC 3986 인코딩 + 전송 경로 왕복 검사), `envelope.ts`(OCResult·B402, HTTP 200 오류, WAF/HTML 본문), `rate-limit.ts`(엔드포인트 5/s, 전역 20/s, DeFi 그룹 5/s, 429 일시정지), `client.ts`(`request(module, endpoint, opts)` 단일 진입점, 429는 `Retry-After` 후 1회 재시도, 시계 오차 감지), `telemetry.ts`(`onApiCall` 훅, 마스킹), `fixtures.ts`(`fixtures/<module>/<endpoint>-<yyyymmdd>-<n>.json`, 키·지갑 주소 가림). `packages/db` `api_calls` 테이블·마이그레이션. `pnpm test` 중 `@ijaro/binance` 64개 통과.
  - 로컬 Postgres 실증(샌드박스, 커밋 안 함): `pnpm db:migrate` 2회(멱등) → `pnpm reach`가 `api_calls: 1 rows recorded` → `pnpm dx:metrics --out <scratch>` `1 api_calls rows summarized`.
- [x] `pnpm reach` 오프라인 부분(G0): 스크립트, 미서명 도달, 키가 없으면 UNAVAILABLE
  - 증거: `scripts/reach.ts`. 출력 `unsigned  GET  /api/v1/dex/market/supported/chain  HTTP 401 code 40101 641 ms "API Key is required" — reached the gateway (expected: signature required)`(2026-09-23 18:16 UTC, 미국 소재 샌드박스, REGION_TAG unset) 다음 줄 `UNAVAILABLE: no API key (BINANCE_WEB3_API_KEY / BINANCE_WEB3_API_SECRET not set) — skipped signed probes: rwa/getRwaTokenList, market/getTokenPrice`, exit 3.
- [x] `pnpm reach`: 서명 호출(RWA 토큰 목록, Market 가격 배치) → 지연·코드 출력
  - 증거: 2026-09-24 00:17:25 UTC 한국 개발 PC(REGION_TAG=kr-dev) — `signed GET /api/v1/dex/market/rwa/tokens HTTP 200 code 0 186 ms — 488 RWA tokens on BSC (ondo 442, bstock 46)`, `signed POST /api/v1/dex/market/price HTTP 200 code 0 58 ms — 3 prices (SOXSon, CRWDon, PANWon)`. 가격 배치 body 형식은 DECISIONS V-09.
- [x] 서명 벡터 테스트(커넥터와 동일 서명 생성)
  - 증거: `packages/binance/src/signature-vectors.test.ts` 통과 — `X-OC-SIGN matches the official connector > GET RWA token list with query (getRwaTokenList)`, `> GET aggregated quote with RFQ wallet (getAggregatedQuote)`, `> GET with characters that need encoding (searchRwaToken)`, `> POST JSON body (buildDeFiDepositTransaction)`, `> POST B402 envelope body (getB402SupportedConfigurationsV2)`, `> documents a connector anomaly: GET /order/{orderId} also signs a JSON body`, `pre-hash string from the docs > matches the GET example in llms-full.txt § Authentication › 3.1 (L223)`. 커넥터의 실제 요청 경로(axios 어댑터로 캡처)와 바이트 단위 일치, 고정 벡터 5개는 `openssl dgst -sha256 -hmac`으로도 재현.
- 수용: 첫 성공 호출의 UTC 시각·지연·시행착오가 `dx/LOG.md`에 기록(서술은 [HUMAN]) — **확인**: 첫 서명 호출 성공 2026-09-24 00:17:25 UTC, RWA 목록 186 ms·가격 배치 58 ms, 서명·시각 오류 없음(dx/LOG.md 2026-09-24 00:17 항목). 포털·키 발급 시각과 소감은 [HUMAN].
  - api_calls 실기록(한국 개발 PC, DB 127.0.0.1:5433): 00:28:12 UTC 첫 3행, 00:37:01 재실행 `api_calls: 3 rows recorded` → `pnpm db:count` `SELECT count(*) FROM api_calls; → 6`(00:37:35 UTC). 그 전 실패는 로컬 DB `28P01`(다른 PostgreSQL이 5432 점유) — dx/LOG.md 00:28 항목.

### M0-04 리전 도달성 결정 · 기준: 기술
- [ ] `pnpm reach`를 (a) 한국 개발기 (b) 프랑크푸르트 러너 (c) Vercel icn1 함수에서 실행, 결과·코드(40304 여부) 기록
  - (a) 한국 개발기: 2026-09-24 00:17 UTC 도달 OK(서명 200, 지역 코드 없음) — DECISIONS Q-01.
  - (b) 프랑크푸르트 러너(Fly `fra`): 2026-09-24 02:31:42 UTC 도달 OK(미서명 401/40101 356 ms, 서명 200/0 350·253 ms, 지역 코드 없음), 병행 중 한국 PC 02:33:02 UTC도 40303 없음 — DECISIONS Q-01, D-06. (c) Vercel icn1은 웹 배포(M2) 때.
- 수용: DECISIONS D-REGION 확정(웹 리전, 워커 리전, 개발 방식)

### M0-05 인스트루먼트 인벤토리 · 기준: 기술·창의
- [x] RWA Data API로 BSC(56) 토큰·플랫폼 목록 수집(폴백: 공개 bapi type 1/2/3)
  - 증거: RWA Data API 직접 성공(폴백 불필요) — `GET /api/v1/dex/market/rwa/tokens?binanceChainId=56` 488종(ondo 442, bstock 46, BSC에 xStocks 없음). 픽스처 `fixtures/rwa/getRwaTokenList-20260924-1.json`.
- [x] 후보 티커 NVDA, TSLA, AAPL, MSFT, QQQ 존재 발행사 확인; 온체인 `symbol/decimals` 검증; bStocks `uiMultiplier` 읽기
  - 증거: `pnpm registry`(2026-09-24 00:45:40 UTC) — 매트릭스 NVDA·TSLA·MSFT·QQQ = bStocks+Ondo, AAPL = Ondo만. 9종 모두 `OK  … symbol … = API …; decimals 18 = API 18`, bStocks 4종 `uiMultiplier … = API tokenToShareRatio …`. 함수명은 바이트코드에서 확인(DECISIONS Q-13, dx/LOG.md 00:41).
- [x] `instruments` 테이블 + 생성 스크립트 `pnpm registry`(코드 상수 금지)
  - 증거: `packages/db/drizzle/0001_instruments_tape.sql`, `scripts/registry.ts` + `apps/agent/src/registry.ts`. 출력 `instruments: 9 verified rows upserted, 9 rows in table`; `pnpm db:count` → `SELECT count(*) FROM instruments; → 9`. 코드의 주소 상수는 BSC USDT(주식 아님, 기동 시 `assertUsdt`로 검증)뿐.
- 수용: 5티커 × 발행사 매트릭스가 DECISIONS에, 픽스처 저장 — **확인**: DECISIONS §2.2, 픽스처 위.

### M0-06 소액 견적 스파이크 · 기준: 기술·DX
- [~] 정규장(22:30~05:00 KST)과 장외 각각, NVDAB·NVDAon(+QQQ 계열)에 $1/$5/$50 견적: expectedOut, priceImpact, route/vendor, 오류코드
  - 장외(US overnight, 2026-09-24 00:46 UTC) 완료: `pnpm spike:quotes` 표가 dx/LOG.md 00:46 항목. NVDAB·QQQB $1/$5/$50 전부 LiquidMesh/SWAP, 영향 ≈0%; NVDAon·QQQon $1·$5 → `40375 "Minimum order amount is 5 USD."`, $50 OK(LiquidMesh/SWAP, "Rfq Halfmoon"). 픽스처 `fixtures/trading/getAggregatedQuote-20260924-*.json`. **정규장 재측정 남음**(DECISIONS Q-03) — 테이프가 $5/$50/$500을 10분마다 기록하므로 13:30 UTC 이후 행으로도 확인 가능.
- [~] 최소 체결 가능 금액과 기본 발행사 결정
  - 제안만(확정은 사람): D-09 `MIN_BUY_USD` $2 유지, Ondo는 > $5; D-10 기본 발행사 bStocks, Ondo 폴백. Q-02 미확인.
- 수용: DECISIONS D-MIN-BUY, D-ISSUER 확정; 결과 표가 `dx/LOG.md`에 — 표 **확인**, 확정은 정규장 재측정·사람 결정 대기.

### M0-07 Venus 스파이크 · 기준: 기술·창의
- [x] DeFi API: Venus 프로토콜 정보(보안점수·TVL·APY), USDT 투자 항목, 포지션 조회
  - 증거: `pnpm spike:venus`(2026-09-24 00:49 UTC) — securityScore 93.1, 프로토콜 TVL 1,353,914,642, USDT Earn `apyBps 316`, 투자 TVL 185,541,887.44, 하우스 포지션 `totalValue 0`. 픽스처 `fixtures/defi-data/{getProtocolDetail,listDeFiInvestments,getInvestmentDetail,getDeFiPositions}-20260924-*.json`.
- [x] 온체인: vUSDT `exchangeRateStored`, `balanceOfUnderlying`, Comptroller 가드 플래그, 이용률 계산
  - 증거: `packages/chain` `readVTokenState`(한 블록에 고정해 읽음) — vToken `0xfD58…0255`(DEPOSIT 항목 `to`; Data API `poolAddress`는 null) `symbol()`=vUSDT, `underlying()`=USDT, exchangeRateStored 265115854764046092440821898, 이용률 72.78%, actionPaused MINT/REDEEM false. `balanceOfUnderlying`은 view가 아니라서 `balanceOf × exchangeRateStored`(`underlyingFromVTokens`)로 계산. 테스트 `packages/chain/src/index.test.ts`(기록된 블록 123664140 값 재생).
- [~] DeFi API 예치·상환 콜데이터 형태 확인 → Transaction API 시뮬레이션(하우스 지갑, 브로드캐스트 없음)
  - 형태 확인·시뮬레이션 실행 완료: deposit = APPROVE(무제한) + DEPOSIT(`mint`), redeem = REDEEM(`redeem`), `redeemDelayDays []`. 시뮬레이션: APPROVE `SUCCESS`, DEPOSIT `FAILED "BEP20: transfer amount exceeds balance"`, REDEEM `FAILED "math error"` — 하우스 지갑 미충전(USDT 0·BNB 0, M0-11). 픽스처 `fixtures/defi-transaction/*-20260924-*.json`, `fixtures/transaction/simulateTransactions-20260924-{1,2,3}.json`. DECISIONS Q-05·Q-16.
- [x] `packages/core/amounts.ts`: 이자 계산 함수 + 테스트
  - 증거: `toUnits/fromUnits`, `underlyingFromVTokens`, `vTokensForUnderlying`, `utilizationBps`, `interestUnits`, `supplyApyFromRatePerBlock` — `packages/core/src/amounts.test.ts` 통과(`pnpm test`).
- 수용: 시뮬레이션 성공 픽스처, 이자 계산 테스트 녹색 — 이자 테스트 **녹색**; 성공 픽스처는 APPROVE만(예치·상환 성공 시뮬레이션은 M0-11 충전 후 `pnpm spike:venus` 재실행).

### M0-08 테이프 가동 · 기준: DX
- [x] `apps/agent` 잡: 10분마다 인스트루먼트별 온체인가·참조가·장 상태 + 견적 3규모 → `tape_samples`
  - 증거(로컬, 한국 개발 PC): `apps/agent/src/tape.ts`·`main.ts` — 인스트루먼트 9종 × $5/$50/$500, RWA price(tokenPrice·referencePrice·갱신 시각), RWA list statusInfo, 우리 시계 `session` 태그, 견적 expectedOut·priceImpact·vendor·executionMode·route·오류코드·지연. 10분 경계 정렬. 에이전트 실행 00:46:14Z 첫 실행 → 00:50, 01:00, …, 01:50:00Z(64분, 8회, 로그 `tape: … 27 rows …, 5 quote errors, session overnight`). count: `SELECT count(*) FROM tape_samples; → 54`(00:46:26Z) → `81`(00:59:37Z) → `243`(01:50:31Z). 기록된 오류는 전부 Ondo $5의 `40375`(45행). `pnpm tape:once` 동작(00:45:51Z, `tape_samples: 27 rows inserted`). 이 64분 동안 견적에서 429가 44건 나왔고(재시도로 전부 복구) 클라이언트 제한을 슬라이딩 창으로 고친 뒤(dx/LOG.md 01:52) 01:54:58Z `pnpm tape:once` 429 0건; 에이전트는 01:55:49Z 새 코드로 재시작.
- [x] 프랑크푸르트 러너에 배포, **9/25 20:00 KST 이전 가동**
  - 증거: Fly.io 앱 `ijaro-agent`, 머신 `d8de470f023428` `fra` `started`(2026-09-24 02:30:28 UTC, `fly status`), `shared-cpu-1x:512MB`, `fly machine status -d` → `"restart": {"policy": "always"}`, `fly machine list` 1대. 설정 `fly.toml`(primary_region fra, [[restart]] always), 이미지 `Dockerfile` + `.dockerignore`(`.env*` 제외; 빌드 중 `.env*` 발견 시 실패, 로컬 이미지에서 `env-files-found: 0`). 시크릿 6개는 `fly secrets import`(stdin)로만. DB Neon(마이그레이션 0000–0002). 첫 실행 `tape: slot 2026-09-24T02:30:00.000Z … 27/27 rows written`; 호스트 `pnpm reach` 성공, api_calls `region=fra` 33행(DECISIONS Q-01). 재시작 안전: `apps/agent/src/main.ts` `tapeTick`이 `tapeSlot()`(10분 슬롯)으로 `tapeSlotRecorded` 선확인, `packages/db/src/index.ts` `insertTapeSamples`가 `ON CONFLICT DO NOTHING`(유니크 `tape_samples_slot_uq` = slot_at·instrument_id·size_usd, `drizzle/0002_tape_slot.sql`). `fly machine restart`(02:32:08 UTC) 뒤 로그 `tape: slot 2026-09-24T02:30:00.000Z already recorded — skipped`. 테스트 `packages/db/src/tape.test.ts`(Postgres, 재실행 시 0행 기록). 배포 후 증가: Neon `SELECT count(*) FROM tape_samples;` → **27**(02:31:55 UTC) → **108**(03:02:26 UTC), 슬롯 02:30·02:40·02:50·03:00 각 27행, (slot_at, instrument_id, size_usd) 중복 0, fra api_calls 121건 중 429 0.
- [x] `GET /api/tape/latest`
  - 증거: `apps/web/app/api/tape/latest/route.ts` — 최신 실행 행 + `state` LIVE(20분 이내)/STALE/UNAVAILABLE(사유). 로컬 `next dev --webpack`에서 `LIVE 2026-09-24T02:20:00.007Z … rows 27`. 워크스페이스 TS 패키지의 `.js` import 때문에 webpack `extensionAlias`와 `--webpack` 사용(Turbopack은 `./schema.js`를 못 찾음). 웹 배포(Vercel)는 M2.
- 수용: 24시간 후 행 수 ≥ 예상치의 90%, 주말 태그 정상

### M0-09 baw 스파이크 [HUMAN+에이전트] · 기준: AW 특별상·DX
- [ ] 팀 개발기: `npm i -g @binance/agentic-wallet@1.10.0`, `auth signin/verify`, `wallet settings`(세션 상한·한도 기록), `market-order quote` NVDAB, `limit-order buy` RWA 시도(지원 여부 기록), `defi investment-list`/`position`/`deposit` preview(Venus USDT)
- 수용: 지원 매트릭스와 소요 시간이 DECISIONS·dx/LOG.md에

### M0-10 Agent Studio 스파이크 · 기준: Studio 특별상
- [ ] `bag` 설치, 에이전트 생성 흐름, 지갑 제공 방식, 런타임 제약(임의 워커 가능?), MCP 등록, ERC-8004 등록 비용
- 수용: DECISIONS D-STUDIO go/no-go

### M0-11 하우스 지갑 준비 [HUMAN] · 기준: 기술
- [ ] 오프라인 키 생성, 러너 env 등록, 충전, 주소를 DECISIONS에(공개), 캡 확인
- 수용: `pnpm reach`가 Wallet API로 하우스 잔고 표시

### M0-12 DX 규약 시작 · 기준: DX
- [x] `dx/LOG.md` 첫 항목들(등록·키 발급·첫 호출), `pnpm dx:metrics` 스켈레톤
  - 증거: `dx/LOG.md`에 에이전트 항목 19건(2026-09-23 17:44–18:20 UTC): 문서 호스트 WAF 챌린지, 가격 배치 body 부재, 커넥터↔문서 불일치 4건, 오류 HTTP 상태 모순, 레이트리밋 헤더 표, B402 엔벨로프 예외, DeFi 예제·무제한 승인·코드 충돌·단위, 첫 미서명 호출 등. 등록·키 발급 시각은 [HUMAN] 항목(M0-00, GOALS G1 선행 조건)으로 사람이 기록.
  - `pnpm dx:metrics`(`scripts/dx-metrics.ts` + `renderMetricsMarkdown`): api_calls → `dx/metrics.md`(엔드포인트·리전별 호출 수, 오류율, nearest-rank p50/p95, 오류 코드). DATABASE_URL이 없으면 `UNAVAILABLE: no DATABASE_URL — dx/metrics.md not regenerated`(exit 3).
- 수용: DX_PROTOCOL 형식 준수 — **확인**: 각 항목이 §3.1 형식(목표·기대·실제·문서·잃은 시간·우회·요청·증거, UTC, 태그). 서술(소감)은 사람 몫으로 비워 둠.

---

## M1 세로 관통 (9/26 ~ 9/30) — 목표: 메인넷 영수증

### M1-01 도메인·DB · 기준: 기술
- [x] SPEC §4 타입, Drizzle 스키마 11개 테이블, 마이그레이션, 시드(하우스 플랜 2개)
  - 타입 완료(2026-09-24, 클라우드 세션): `packages/core/src/types.ts` — SPEC §4 v2(금액은 소수 문자열, 계산은 18자리 bigint, `FAILED.fundsMoved` none/gas_only, `BOUGHT.interestUsd`).
  - 스키마 완료(2026-09-26, 클라우드 세션): `packages/db/src/schema.ts` 13개 테이블(SPEC §4의 11개 + v2 `tx_outbox`·`jobs`), 마이그레이션 `packages/db/drizzle/0004_m1_core.sql`. 금액은 numeric(38,18) 문자열. FK 10개(연쇄 삭제 없음 — 영수증은 플랜과 함께 지워지지 않음), CHECK 17개(상태·종류 값, 금액 ≥ 0, 일 한도 ≥ 1회 한도, **원금 0인 yield 플랜은 active 불가** — D-16).
  - 헬퍼: `plans.ts`(플랜 락 `lock_until` 조건부 UPDATE, 사이클 멱등 `(plan_id, due_at)`, 영수증 tx 해시 1회), `ledger.ts`(캡 예약: advisory lock + 한 트랜잭션에서 전 캡 검사 후 삽입, 전역 일일·플랜 일일·심사 코드 총액), `queue.ts`(jobs `FOR UPDATE SKIP LOCKED`, tx_outbox 발신자별 nonce 유일), `auth.ts`(심사 코드·스킬 토큰은 SHA-256만 저장), `mappers.ts`(행 → core 타입, 모르는 값은 예외).
  - 시드: `pnpm db:seed` — H-SAFE(NVDA safe $5 daily regular_session, 1회·일 $5), H-YIELD(QQQ yield weekly regular_session, 1회·일 $5), 발행사 `['bstocks','ondo']`, 둘 다 `paused(awaiting_funding)`, 원금은 예치 영수증에서 기록(D-16). 기존 플랜은 덮어쓰지 않음. `JUDGE_CODES` 해시 동기화. 실행 출력(스크래치 DB): `house plans: created [H-SAFE, H-YIELD], kept [] (new plans paused: awaiting_funding, first due 2026-09-28T13:32:00.000Z)` → 재실행 `created [], kept [H-SAFE, H-YIELD]`.
  - 되돌리기: drizzle-kit은 up만 만들므로 `packages/db/drizzle-down/<tag>.sql` 5개를 손으로 쓰고 `rollbackMigration`(최신 1개만, 역 SQL + 기록 삭제를 한 트랜잭션)과 `pnpm db:rollback <tag> --yes`(없으면 거부)를 추가.
- 수용: 마이그레이션 왕복, 타입 테스트 — **확인**(2026-09-26 17:44 UTC, 새 DB): `src/migrations.test.ts` 전용 임시 DB에서 up → down 5개(최신부터) → up, 열·제약·인덱스 스냅샷이 동일. 행 → 도메인 타입 테스트 `src/mappers.test.ts`. DB 테스트 39개(캡 동시 예약 10건 중 정확히 2건만 통과 — advisory lock을 지우면 3회 모두 실패하는 것을 확인, 락 5명 동시 획득 시 1명, 잡 동시 청구 시 중복 없음, nonce 중복 거부, CHECK 위반 거부). 전체 `pnpm test` 25파일 222개 통과, `pnpm typecheck`·`pnpm lint` 통과, core 커버리지 100%.

### M1-02 결정 엔진 `decideCycle` · 기준: 기술·창의
- [x] 순수 함수: WINDOW/BUDGET/ASSET/PRICE/QUOTE 판단, 결과 `CycleOutcome` + whyKey
  - 증거: `packages/core/src/decide.ts` `decideCycle(input)` → `not_due` | `done`(DEFERRED/SKIPPED/FAILED + whyKey) | `quote` | `execute`, 부수효과 없음. 규칙은 SPEC §5 v2: 우리 NYSE 달력(`nextRegularOpen`), 공식 스킬의 reason code, 기업행동은 발행사 전환 없이 SKIPPED, 독립 주가가 있을 때만 괴리, Ondo 최소 5.01, 25초 지난 견적 재요청, RFQ 미실행, 가격영향 절반 재견적 2회, 이자 매수는 원금을 상환하지 않음. `boughtOutcome()`이 영수증 수령량으로 BOUGHT와 사유를 만든다.
- [x] 경계 테스트: 창구 경계 시각, 최소주문, 캡, 기업행동 코드, 발행사 폴백, 가격 괴리, 가격영향 축소 재견적
  - 증거: `packages/core/src/decide.test.ts` 57개(DUE 4 · GUARDIAN 1 · WINDOW 4 · BUDGET 9 · ASSET 11 · PRICE 4 · QUOTE 12 · BOUGHT 4 · 경계 6) — 모든 whyKey와 파라미터를 UX_COPY §4 표와 대조(`packages/core/test/ux-copy.ts`). 달력 테스트(주말·휴장일·DST).
- 수용: 테스트 ≥ 30, 커버리지 100%(core) — **확인**(2026-09-24 05:21 UTC): `pnpm coverage:core` → `Statements 100% (243/243)`, `Branches 100% (212/212)`, `Functions 100% (34/34)`, `Lines 100% (211/211)`(임계 100% 강제). 전체 `pnpm test` 18파일 183개 통과(DB 포함).

### M1-03 HouseWalletExecutor · 기준: 기술
- [x] 정확 승인 → Transaction API 시뮬레이션 → viem 서명 → Transaction API 브로드캐스트(RPC 폴백) → 영수증 폴링 → 실수령량 파싱
  - 코드(2026-09-26, 클라우드 세션):
    - `packages/binance/src/endpoints.ts`: 문서 필드명의 타입 래퍼. 견적·승인·스왑·시뮬레이션·가스·브로드캐스트·상세·DeFi 빌드. 멱등 호출만 재시도한다.
    - `packages/chain/src/tx.ts`: approve·mint·redeem 디코드, 영수증 Transfer 합산, 가스 상한 있는 서명용 tx.
    - `apps/agent/src/executor/send.ts`: nonce → 서명 → outbox SIGNED → 브로드캐스트(Transaction API, 컴플라이언스 외 실패는 RPC) → PENDING → 영수증(3분) → CONFIRMED/FAILED. `reconcileOutbox`가 부팅·사이클 전에 하우스 행만 정리한다(받은 적 없는 바이트는 그대로 재전송).
    - `apps/agent/src/executor/trade.ts`: 정확 승인 검증·허용량 확인·시뮬레이션 후 전송. 스왑은 발신자·value·경로·시뮬레이션·견적 나이를 검증한다.
    - `apps/agent/src/cycle.ts` `runCycle`: decideCycle 단계마다 I/O. 캡 예약, 영수증, 홀딩(배수 변경 시 guardian_events), 원장 정산, 다음 due, FAILED 알림. 안전 규칙: DECISIONS D-17.
  - 증거: `apps/agent/src/cycle.test.ts` 6개. 실제 Postgres, 가짜 API·체인, 공개 테스트 키로 수행했다.
    - simulate: 승인 시뮬 SUCCESS, 스왑 시뮬 allowance FAILED, 서명 0.
    - live: 호출 순서 quote → approve-transaction → simulate → broadcast → swap → simulate → broadcast. 허용량 = 정확히 $5, nonce 연속, receipts approve·swap, holdings, outbox CONFIRMED×2, 다음 due 9/29 09:32 ET.
    - 무제한 승인은 서명 0으로 FAILED 처리하고 알림을 보냈다.
    - 토요일: 견적 없이 DEFERRED, 월 09:32로 넘어갔다.
    - 40431: RPC 폴백.
    - 영수증 미도착: awaiting_tx → 다른 플랜 `outbox_busy` → 채굴 후 정리하고 매수.
- [x] `pnpm cycle:once --plan H-SAFE --live` (확인 프롬프트)
  - `scripts/cycle-once.ts`: simulate 패스를 먼저 돌려 금액·주소·시뮬 결과를 출력한다. `--live`는 `EXECUTION_MODE=live`, 하우스 키, 대화형 터미널에서 `y` 입력이 모두 있어야 한다(`scripts/confirm.ts`, TTY가 아니면 거부). `executorDeps(rt, 'live')`도 설정이 live가 아니면 서명자를 주지 않는다.
  - 남음: [PC] simulate 실행 출력 인용(GOALS G3-3). [HUMAN] 메인넷 실행(G4).
- 수용: **메인넷 NVDAB(또는 결정된 발행사) $5 매수 1건**, `receipts` 저장, BscScan 링크, 사유 한 줄. [HUMAN] 지출 승인 기록

### M1-04 안전 모드 완주 · 기준: 기술
- [~] 스케줄러 없이 CLI로 사이클 전체(DUE→RECORD), 홀딩 갱신(주식 수)
  - 코드·테스트 완료(9/26): `pnpm cycle:once`가 `runCycle`로 DUE→RECORD 전체를 수행한다. 수동 실행은 일정을 바꾸지 않는다. 홀딩 shares = tokens × 배수(`sharesFromTokens`)이고, `cycle.test.ts` live 시나리오로 검증했다. 남음: [PC] 실데이터 simulate 실행 1회 인용.
- 수용: 사이클 레코드 + 홀딩 shares 계산 검증

### M1-05 이자 모드 완주 · 기준: 기술·창의
- [~] 예치(DeFi API 콜데이터→시뮬→브로드캐스트), 이자 조회(온체인·DeFi API 교차), 상환, 매수
  - 코드(9/26): `apps/agent/src/executor/venus.ts`.
    - `discoverVenusUsdt`: DeFi Data로 투자를 찾고, 예치 빌드로 vToken을 찾고, 온체인 `underlying()`이 USDT인지 확인한다.
    - `depositPrincipal`: DEPOSIT이 `mint(정확한 금액)`인지, 대상이 vUSDT인지 확인한다. APPROVE 항목은 쓰지 않고 정확 승인을 쓴다.
    - `redeemFromVenus`: 플랜 보유 vToken 이하이고 요청액 가치 이하일 때만 상환한다. 지연일이 있으면 거부한다.
    - 플랜별 `plans.vtoken_units`(마이그레이션 0006). `runCycle`은 이자 → 상환 → 매수 순이고 `harvested_unspent_usd`를 갱신한다.
    - `pnpm yield:deposit --plan <id> --usd <n> [--live]`: 원금 캡을 확인하고 `y`를 받는다. 원금·vToken은 확정 영수증에서 1회만 기록한다. 늦은 영수증은 `--record <tx>`로 기록한다.
    - `pnpm yield:redeem --plan <id> [--live] | --record <tx>`(9/27, 사람 yes D-21, `apps/agent/src/operator.ts`): 플랜의 Venus 포지션 전체를 하우스로 되찾는다.
      - 미리보기는 빌드·콜데이터 검사·시뮬레이션만 하고 아무것도 바꾸지 않는다.
      - live는 `y`, outbox 정리, 플랜 락, 시뮬 통과 뒤에만 서명하고 플랜을 paused(operator_redeem)로 둔다. 스킬 플랜은 거부한다.
      - `--record`는 우리 outbox가 그 플랜의 redeem으로 서명한 tx만 받는다.
  - 증거: `venus.test.ts` 7개(1 USDT 실측 콜데이터 사용).
    - 시뮬된 승인은 정확 금액이었다(API 항목은 2^256−1).
    - 잘못된 금액·시장은 거부했다. 원금을 건드리는 상환과 지연 상환도 거부했다.
    - live 예치 → 상환에서 로그로 vToken 발행과 USDT 수령을 파싱했다.
  - 증거(9/27): `apps/agent/src/operator.test.ts` 4개.
    - 미리보기는 서명·변경이 없다. 없음·스킬·safe·포지션 없음은 거부한다.
    - live 상환은 receipts redeem을 남기고, 원금 0, 이자는 harvested에 둔다. 멈춘 플랜은 stopped로 남는다.
    - 시뮬 실패면 서명 0에 알림을 보낸다. 락이 잡혀 있으면 거부한다.
    - 미채굴 tx는 다른 플랜을 `outbox_busy`로 막고, 채굴 뒤 `--record`는 한 번만 적용된다.
    - 가디언 redeem_all·정지 잡의 live 상환 분기는 전에 테스트가 없었다. 이제 같은 기록 경로(`applyPositionRedeem`)로 검증된다.
  - 남음: [HUMAN] $1 실거래 시험(`docs/LIVE_TEST.md`: 예치·매수·상환), 원금 결정(REPLAN R1), 이자 매수 swap 영수증(G4).
- 수용: **메인넷 영수증 3종(deposit, redeem, swap)**, 이자 표시. 이자 부족 시 적립 병행으로 체결하되 영수증에 구분 표기

### M1-06 스케줄러·창구·멱등 · 기준: 기술
- [~] 5분 틱, 락, 멱등키, `nextDueAt`(개장+2분), DEFERRED(market_closed) 기록과 retryAt
  - 코드(9/26): `apps/agent/src/scheduler.ts` `schedulerTick`(5분). 순서는 outbox 정리(live) → 대기 사이클 마무리(`awaiting.ts`) → 가디언 → 웹 jobs(preview는 항상 simulate) → due 플랜을 하나씩(서명자 하나).
    - 락: `plans.lock_until` 조건부 UPDATE.
    - 멱등: 예약 사이클은 (plan, due_at). 수동 실행은 요청마다 새 사이클.
    - 다음 due: `packages/core/src/schedule.ts` `nextDue`(core 100%).
    - 워커 `main.ts`가 테이프와 함께 돌린다. live는 설정·활성 플랜일 때만 서명한다.
  - 증거: `scheduler.test.ts`. 시간을 옮겨 가며 확인했다.
    - 토요일 11:00 ET 틱: DEFERRED(market_closed, retryAt 월 13:32Z).
    - 일요일: 실행 없음.
    - 월 09:33 ET 틱: 자동 BOUGHT, 다음 due 화 09:32.
  - 남음: [PC] 배포 워커 로그로 실주말→월요일 확인(G5).
- 수용: 주말 실행 시 DEFERRED 레코드 생성, 월요일 개장 후 자동 매수(로그로 증명)

### M1-07 에러 분류 v1 · 기준: 기술·DX
- [~] SPEC §11 매핑, 재시도·백오프, 429, 알림(FAILED만), 미지 코드 최초 관측 시 dx 이벤트
  - 분류(2026-09-26, 클라우드 세션): `packages/binance/src/taxonomy.ts` `classifyError()` — (모듈, 코드) → 행동(`retry`·`requote`·`next_issuer`·`market_closed`·`reduce_size`·`rpc_fallback`·`defer`·`fail`)·운영 알림 여부·문구 키·문서화 여부. 코드는 모듈별 공식 오류 표에서만 가져왔다(40470처럼 모듈마다 뜻이 다른 코드 포함). 표에 없는 코드는 `documented:false` → 사이클은 안전하게 FAILED, 운영 알림.
  - 재시도·429: `RequestOptions.retries`(기본 0, 멱등 호출만) — 일시 오류(네트워크·타임아웃·5xx·50000/50001·40432·40465·40482·40483)에 0.5 s·1 s·2 s… 백오프. 429는 기존대로 Retry-After 후 1회. `BinanceApiError.classify()`.
  - 엔진 연결: `QuoteObservation.errorAction`(`next_issuer`·`market_closed`) — 에이전트가 분류 결과를 넘기면 40421·40365·40366도 다음 발행사로 넘어간다(core 100% 유지).
  - 알림: `apps/agent/src/alerts.ts` — 텔레그램(설정 시) 또는 로그, 같은 키 1시간 1회, 토큰은 로그·본문에서 가림. `cycleAlert()`는 FAILED에만 알림. `pnpm alert:test`로 1회 발송 확인(여기선 토큰이 없어 `channel log, result logged`).
  - dx 이벤트: `dx_events` 표(마이그레이션 0005, (종류, 모듈, 엔드포인트, 코드)당 1행) + `watchDxFindings`(api_calls 싱크 래퍼)가 문서에 없는 코드·봉투 아닌 응답의 첫 관측만 알림. `pnpm dx:events [--mark-logged]`가 dx/LOG.md 형식(사실만)으로 출력.
- 수용: 코드별 단위 테스트, 알림 1회 실동작
  - 코드별 테스트 **확인**: `taxonomy.test.ts`(SPEC §11 표 33행 + 무코드 실패 + 공식 표 5개와 양방향 대조), `replay.test.ts`(실측 픽스처 재생: 40401, 42900/429 재시도·포기, 40375 최소액, 40484, code 0 안의 simulate FAILED·SUCCESS), `client.test.ts` 재시도·백오프, `alerts.test.ts`, `dx-watch.test.ts`, `dx.test.ts`. 전체 `pnpm test` 31파일 300개 통과.
  - 남음: [HUMAN/PC] 텔레그램 토큰이 있는 호스트에서 `pnpm alert:test` 1회(`result sent`) 인용.

### M1-08 홀딩·배수 · 기준: 창의·UX
- [x] 영수증마다 multiplier 스냅샷, 변경 감지 이벤트, shares 재계산
  - 계산 완료: `packages/core/src/holdings.ts` — `sharesFromTokens`(정확, 내림), `revalueHolding`(배수 변경 감지), `upcomingMultiplierChange`(bStocks `newUIMultiplier`·`effectiveAt` 예정 안내).
  - 연결(9/26): 매수 영수증마다 `addToHolding`이 배수를 스냅샷하고 전체 토큰 × 현재 배수로 shares를 다시 계산한다. 배수가 바뀌었으면 `guardian_events`(`multiplier_changed`, warn, from/to)를 남긴다. 증거: `cycle.test.ts` "a buy on top of a holding written at another multiplier…".
- 수용: 배수 변경 시뮬레이션 테스트 — `holdings.test.ts`(분할로 배수 1→10이면 2주 → 20주, balanceOf 불변)

### M1-09 하우스 플랜 가동 · 기준: 기술
- [~] H-SAFE(일 $5, 정규장), H-YIELD(원금 확정액, 주 1회) 9/30부터 연속 가동
  - 코드 준비(9/26): `pnpm db:seed`(둘 다 paused), `pnpm yield:deposit`(원금), `pnpm plan:status --activate`(live면 `y`, 원금 없는 yield는 DB가 거부 → 안내 문구). 워커가 활성 플랜을 5분 틱으로 돌린다.
  - 코드(9/27): `pnpm plan:set`은 하우스 플랜 금액·주기를 캡 안에서 바꾼다.
    - 검사는 core `changePlanSettings`(테스트 7개, core 100%): 최소 매수 ≤ 1회 ≤ 하우스 1회 캡, 1회 ≤ 일 ≤ 일일 캡, safe 적립액 ≥ 최소 매수.
    - 심사위원·스킬 플랜은 거부한다. 켜진 플랜은 `y`를 받는다.
    - $1 시험에서 H-SAFE를 $1/$1/$1로 둘 때 쓴다.
  - 남음: [HUMAN] 하우스 지갑 충전·$1 시험(`docs/LIVE_TEST.md`)·원금 결정(REPLAN R1–R4). 그 뒤 활성화와 연속 가동(G5).
- 수용: 10/4까지 사이클 레코드 ≥ 4일치, FAILED 0 또는 원인 기록

---

## M2 제품화 (10/1 ~ 10/4) — 목표: 심사위원 3분 완주

### M2-01 Watch 홈 · 기준: UX·기술
- [x] 하우스 카드 2개, 영수증 피드(사유+링크), 장 상태 배지, LIVE/STALE/UNAVAILABLE, CTA 2개
  - 코드(9/26): `apps/web/app/page.tsx` — 히어로(제목·부제·CTA 2개) + 이자 카운터(하우스 이자 플랜의 vToken을 체인에서 읽은 값, 15초마다 다시 읽음 — 외삽 없음, `components/home/InterestCounter.tsx`), 하우스 카드 2개(원금·이자·모은 주식·다음 매수·오늘 한도·영수증 수·마지막 사유), 영수증 피드(사유 한 줄 + BscScan), 장외 괴리 인사이트(테이프 7일), 종목 카드(발행사·Ondo 최소 $5.01), 믿을 수 있는 이유(캡은 설정값에서, 지킴이 상태는 표본에서). 헤더: 장 상태 배지(우리 NYSE 달력), 테이프 데이터 상태, KO/EN. 모든 블록이 LIVE / n분 전 / 불러올 수 없음(이유)을 단다(`components/ui.tsx` `StateBadge`, 읽기 실패는 `lib/server/settle.ts`가 이유 라벨로 바꾸고 원인은 서버 로그에만).
- 수용: 모바일 375px에서 가로 스크롤 없음, 첫 화면 3초 이해 리허설(강민서 체크리스트)
  - [x] 375px 가로 스크롤 없음: `pnpm ui:check`(Playwright Chromium, `scripts/ui-check.ts`) — 로컬 `next start` + 스크래치 DB, 7개 페이지 × KO/EN × 375/1440px 28회 전부 `scrollWidth 375 / 375`(1440도 동일), 페이지 오류 0, `ui:check — 0 problems`.
  - [ ] [HUMAN] 3초 이해 리허설.

### M2-02 Judge Mode · 기준: UX·기술
- [x] 코드 → 종목/섹터 → 모드·금액 → 미리보기(사람 말+원본 토글) → 실행 진행 → 영수증 → [멈추기]
  - 코드(9/26): `apps/web/app/judge/page.tsx` + `components/judge/JudgeFlow.tsx` — ① 코드(`POST /api/judge/session`) ② 종목(레지스트리, 체험 한도로 못 사는 Ondo 전용 종목은 비활성+사유) ③ 적립/이자 모드(이자 모드는 위험 고지 모달, "이해했어요" 체크 전엔 버튼 비활성)·금액·사는 시간(장 마감이면 다음 개장 시각/장외 한도 절반 안내) ④ 미리보기 = 워커의 시뮬레이션 잡 결과(사람 말 + '자세히'에 발행사·조각 수·최소 수령) ⑤ 실행 잡 ⑥ 영수증(BOUGHT/예약됨 DEFERRED/SKIPPED/FAILED/시뮬레이션 모드/확인 대기 각각의 문구) + [플랜 멈추기]. 섹터 고르기는 그리지 않았다(M2-07 섹터 결정 대기, "곧 출시" 금지).
  - 워커가 웹 잡을 5분 틱에서만 집어 3분 완주가 불가능했던 문제: 틱 사이 3초마다 잡만 처리(`apps/agent/src/scheduler.ts` `processJobs`, `main.ts` `JOB_POLL_MS`, 틱과 같은 잠금 — 서명자 하나·nonce 한 줄). 테스트 "picks up web jobs between ticks without running due plans".
  - 로컬 브라우저 흐름(스텁 워커, 스크래치 DB): 틀린 코드 → "코드가 맞지 않아요" → 코드 → NVDA → 확인 → 미리 돌려보기 → (토요일이라) "미국 장이 닫혀 있어요. 9월 28일 (월) 22:32에 다시 시도해요." → 지금 사기 → 예약됨 + 플랜 기록 링크 + 멈추기, 6.1초. 스텁 워커는 이 상황에서 decideCycle이 내는 결과(market_closed, 다음 개장 +2분)만 흉내 냈다 — 실제 체결 증거가 아니다.
- [~] 코드별 캡, 7일 자동 stop, 리셋
  - 캡: 코드당 총액 = 샌드박스 캡(`judgeTotalUsd`, 원장), 남은 한도 표시. 7일: 플랜 `expiresAt` → `runCycle`이 stopped(expired). 리셋(코드 사용량 초기화)은 만들지 않았다 — 운영 절차가 정해지면 → [HUMAN] 결정.
- 수용: 리허설 3분 이내 완주 3회 연속, 실패 경로(장 마감·캡 초과) 문구 확인
  - [x] 실패 경로 문구: 장 마감(예약됨), 코드 오류, 한도 소진(`judge.code.error.exhausted`, `code_exhausted` 409 — `apps/web/test/judge.test.ts`), 미리보기 실패(`judge.preview.failed`).
  - [ ] [HUMAN] 배포 + 워커 가동 상태에서 3분 완주 3회(돈 결정 R1–R4 이후).

### M2-03 플랜 상세·정지·전액 상환 · 기준: UX·기술
- [x] 코드(9/26): `apps/web/app/plans/[id]/page.tsx` — 이름·상태·주체, 원금·이자(체인에서 읽음; 스킬 플랜은 지갑 포지션)·모은 주식(평균 매수가)·다음 매수, 한도 막대(`plan.limits`), 지킴이(열린 판정 또는 "이상 없음 · 마지막 점검", 이용률·USDT·규모·가격영향 기준), 기록 타임라인(결과 필터 칩, 시뮬레이션 기록 표시, 사이클별 영수증 링크), 사이클 없는 예치·상환 영수증, 보유 주식(배수), 소유 심사위원에게만 [플랜 멈추기](`components/plan/StopPlan.tsx`: 확인 → stop 잡 → 폴링 → 새로고침; 이자 플랜은 원금 전부 꺼냄 안내). 없는 플랜은 404.
- 수용: 이자 모드 정지 시 상환 영수증 표시
  - [~] 화면: 상환 영수증(`kind=redeem`)은 "이자 통장에서 꺼냈어요" + BscScan으로 표시된다. 실제 상환 영수증은 live 실행이 필요 → [HUMAN] 돈 결정 이후.

### M2-04 위험 고지·안전 기본값·용어 치환 · 기준: UX
- [x] UX_COPY §5 전문, 금지어 린트 스크립트(`pnpm lint:copy`)
  - `/risk`와 이자 모드 모달이 §5 전문을 쓴다(`components/RiskText.tsx`). {apy}·{score}는 워커가 기록한 값만(APY는 DeFi 목록 `apyBps`를 6시간마다, 보안 점수는 프로토콜 상세 `securityScore`를 가디언 틱마다 — `main.ts`, `guardian.ts`); 값이 없으면 그 문장을 빼고 "불러올 수 없어요"를 단다.
  - 안전 기본값: 체험은 적립만·정규장이 기본, 이자 모드는 고지 동의 후에만.
  - `pnpm lint:copy`(`apps/web/scripts/copy.ts lint`, `pnpm lint`에 포함): UX_COPY와 생성 파일 일치, KR/EN 자리표시자 일치, §6 금지어를 문구·웹 소스·`skills/`에서 검사.
- 수용: 금지어 0건
  - [x] `lint:copy — 252 keys, 11 banned words, 0 problems`.

### M2-05 KR/EN i18n · 기준: UX
- 수용: 모든 문자열이 키 기반, 언어 토글
  - [x] `pnpm copy:gen`이 docs/UX_COPY.md(§3·§4·§5·§7)에서 `apps/web/lib/i18n/copy.ts`를 만든다(252키, KR/EN). 화면은 `t(key)`만 쓴다(키는 타입으로 검사). 값이 빠진 자리표시자가 있는 문장은 통째로 뺀다(미국 주가 없는 `why.bought.*`의 괴리 문장, 추정하지 않는 수수료).
  - [x] 언어: 쿠키(KO/EN 토글) → 없으면 브라우저 언어(한국어면 ko, 아니면 en). 시간: 브라우저 시간대를 쿠키로(`components/LocaleSync.tsx`), 없으면 ko=서울·en=UTC.
  - §7은 에이전트 초안(DESIGN_BRIEF [신규 문구] KR + 영어)이다 → [HUMAN] 강민서 검토·확정.
  - 증거: `apps/web/test/i18n.test.ts`(생성 파일 일치, 자리표시자 일치, 문장 빼기, 포맷), ui:check KO/EN 28회.

### M2-06 가디언 · 기준: 기술·창의·UX
- [~] PLAN §7 규칙, 이벤트 표시, 전액 상환 액션(시뮬 성공 시만)
  - 규칙(9/26): `packages/core/src/guardian.ts` `evaluateGuardian`(순수, core 100%).
    - 프로토콜 일시중지: MINT → redeem_all, REDEEM → pause_buys.
    - TVL 24h −30% → redeem_all.
    - 이용률 > 95% → stop_deposits.
    - USDT < 0.99 30분 → pause_buys.
    - 괴리·가격영향·한도·종목 상태는 decideCycle 단계에 있다.
  - 실행: `apps/agent/src/guardian.ts` `guardianTick`.
    - 입력을 `guardian_samples`에 남긴다(마이그레이션 0007: 온체인 플래그·이용률, DeFi TVL, Market USDT 가격).
    - 발동 1회 기록·알림. 입력이 읽힌 규칙만 해제한다.
    - redeem_all은 yield 플랜을 멈추고, live에서만 시뮬 SUCCESS 후 상환한다(실패하면 알림 후 사람 판단).
    - `runCycle`은 열린 판정으로 SKIPPED(guardian). `yield:deposit`은 stop_deposits면 거부한다.
  - 증거:
    - `guardian.test.ts`(core, 경계값).
    - `packages/db/src/guardian.test.ts`(24h 전 표본, 페그 이탈 시점).
    - `scheduler.test.ts`: USDT 0.985 35분 → 열림·알림·매수 SKIPPED·서명 0 → 회복 시 해제. TVL −33% → yield 플랜 paused(`guardian:tvl_drop`).
  - [x] 웹 표시(9/26): 플랜 상세 지킴이 패널(열린 판정·감시 항목·마지막 점검), 홈 "믿을 수 있는 이유"의 지킴이 상태.
- 수용: 규칙별 테스트, 수동 트리거로 UI 표시 확인

### M2-07 기업행동·섹터 후보 · 기준: 창의·기술
- 수용: PAUSED/LIMITED 픽스처로 SKIPPED 사유 표시, 섹터 후보 대체 테스트
  - [x] 기업행동 부분.
    - decideCycle: ASSET_PAUSED·ASSET_LIMITED를 발행사를 바꾸지 않고 SKIPPED(corporate_action)로 처리한다. earnings·배당·분할 키가 있고, 나머지는 detail에 남긴다. 증거: `decide.test.ts`.
    - 실측 목록 재생: `apps/agent/src/market.test.ts`. `fixtures/rwa/getRwaTokenList-20260924-1.json`에는 기업행동이 없어서 대신 두 가지를 확인했다.
      - 장외에 TRADING인 bStocks도 정규장 플랜은 목 09:32 ET로 DEFERRED.
      - 실제 Ondo `MARKET_PAUSED "Paused for session transition"`은 API nextOpenTime + 2분으로 DEFERRED.
  - [ ] 섹터 후보 대체: 구현하지 않았다. REPLAN R10이 "섹터 타깃 지금 컷"을 제안했고, DESIGN_BRIEF도 분야 선택을 그리지 않는다. 컷라인은 사람 합의가 필요하다 → [HUMAN] 결정 대기.

### M2-08 Skill API · 기준: AW 특별상·기술
- [x] `/api/plans`, `/preview`, `/next`, `/report`, `/stop`, 토큰 발급·검증, 레이트리밋
  - 코드(9/26): `apps/web/app/api/**/route.ts` 18개 + `apps/web/lib/server/*`. 웹은 서명하지 않고 Binance Web3 API도 부르지 않는다(워커가 쓴 DB·공개 BSC RPC만 읽고, 실행은 `jobs`로 워커에 넘긴다; Q-01 단일 키·리전).
    - 심사위원: `POST /api/judge/session`(코드 SHA-256 대조, HMAC 서명 쿠키 `ijaro_judge` HttpOnly·SameSite=Lax·7일, 코드 원문 저장 없음) → `POST /api/plans`(샌드박스 캡 이내, 등록 티커만, 코드당 총액·시간당 5개) → `/run`·`/preview`·`/stop`(202 + `/api/jobs/:id` 폴링, 플랜당 10분 10건).
    - 스킬(mode C): `POST /api/plans {owner:"skill"}` → 토큰 `ijr_…` 1회 표시(해시만 저장). `GET /next` = decideCycle(테이프 추정가·지갑의 Venus 포지션·가디언·플랜 한도) → `baw` argv(quote의 `acceptMinToCoinAmount` = 추정치 −1%, swap의 `confirm`·`report`), 사유 키, `expiresAt` +5분; calldata·서명 없음. `POST /report` = 체인 확인(채굴·성공·플랜 지갑 발신·Transfer 로그)만 기록, 한도 초과는 기록 후 `report_over_limit`로 정지, 예치 보고로 yield 플랜 활성화.
    - 레이트리밋: 코드 시도 IP당 분 10회, 스킬 플랜 IP당 시간 5개, `/next` 플랜당 분 30회, `/report` 분 20회(인스턴스 메모리) + 지속 한도(플랜 수·잡 수·지출 원장)는 Postgres.
  - 이 과정에서 고친 것: 지출 원장의 하우스 일 한도(`global_day`)가 스킬 플랜(사용자 지갑) 지출까지 더하던 버그 → 하우스·심사위원 플랜만 합산(`packages/db/src/ledger.ts`, 테스트 "keeps skill plans … out of the house wallet's daily cap"은 수정 전 실패 `expected '3' to be '5'` → 수정 후 통과). 캡 값 변경 없음.
  - 증거: `apps/web/test/{judge,skill,read,openapi}.test.ts` 22개(웹 전용 DB `<test db>_web`, 가짜 체인). 전체 `pnpm test` 45파일 371개 통과, core 100%. `next build --webpack` 성공(API 19개 경로). 로컬 `next start`(스크래치 DB) 실측: 잘못된 코드 401 → 코드 200 + 쿠키 → $6 `over_cap` → $5 플랜 `paused(awaiting_run)` → `/run` 202 → 잡 `queued`; 스킬 플랜 201 + 토큰 → `/next` 토큰 없음 401, 테이프 없음 `wait data_unavailable` → 미채굴 해시 `/report` 202 `pending`(공개 RPC 조회).
- 수용: OpenAPI 문서, `/next` 응답에 baw 명령 파라미터·사유·만료 시각
  - [x] `GET /api/openapi`(OpenAPI 3.1, 요청 본문은 라우트가 검증에 쓰는 zod 스키마에서 생성 — `lib/server/schemas.ts`). `openapi.test.ts`가 라우트 파일·메서드와 문서를 1:1 대조.
  - [x] `/next`: `steps[].run`(baw argv), `why`(UX_COPY 키)·`reason`, `expiresAt` — `skill.test.ts`.

### M2-09 Wallet Skill v1 · 기준: AW 특별상·DX
- [x] `skills/ijaro/SKILL.md` + references(plan.md, run.md, safety.md), 설치 경로 확정
  - (9/26) Skills Hub `binance-agentic-wallet` 형식(frontmatter name/description/metadata, `requires` baw·curl·jq, 선행 스킬). 라우팅: 플랜 만들기(`POST /api/plans`, 토큰은 `~/.config/ijaro/config.json` 600에만 — 대화에 출력 금지), 이자 모드 예치(`defi preview DEPOSIT` → 확인 → `defi deposit` → `/report`), 실행(`/next` 단계: redeem → quote(`acceptMinToCoinAmount`·심볼 확인) → swap(`market-order list`로 FINISHED/FAILED까지) → `/report`), 상태·정지. 안전: 위험 고지 동의, 매 상태 변경 전 미리보기·확인, **토큰 주소를 공식 RWA 목록(스킬 허브가 문서화한 공개 엔드포인트 `…/rwa/stock/detail/list/ai?type=3|1`)과 대조**, 세션 만료 2시간 전 알림, orderId≠체결, 오류 원문 전달.
  - `/next`가 내는 argv를 벤더 문서와 대조: `market-order quote|swap`(`--fromTokenQty --fromToken --toToken --binanceChainId --slippage --json`), `market-order list --orderId`, `defi preview --action REDEEM`·`defi redeem --investmentId --tokenAddress --amount` — `docs/vendor/binance-skills-hub/.../binance-agentic-wallet/references/{market-order,defi}.md`와 일치.
  - 설치 경로(Claude Code 개인 스킬): `git clone --depth 1 https://github.com/mycyi1994-hash/NewBNBHACK ijaro-src && mkdir -p ~/.claude/skills && cp -r ijaro-src/skills/ijaro ~/.claude/skills/` + `IJARO_URL`. `/skill` 화면과 README에 같은 줄. 설정 저장 jq 명령은 로컬에서 실행 확인(jq 1.7).
- [ ] [HUMAN+에이전트] Claude Code에서 실제 실행: 안전 모드 $5 매수 1건, 이자 모드 예치 1건 → `docs/skill-demo.md`(마스킹)
- 수용: 클린 머신 설치→첫 실행 ≤ 10분, 소감·막힘이 dx/LOG.md에

### M2-10 Agent Studio · 기준: Studio 특별상
- [ ] 하우스 에이전트 신원 등록(ERC-8004), 가능하면 런타임/MCP, 사이트에 신원 링크
- 수용: 등록 tx·에이전트 ID가 README에

### M2-11 /dx 페이지 · 기준: DX
- [x] p50/p95·오류코드·리전, 테이프 차트 3종(정규장 vs 장외 괴리, 규모별 가격영향, 발행사 비교), 발견 목록
  - 코드(9/26): `apps/web/app/dx/page.tsx` + `lib/server/dx.ts`(`GET /api/dx/metrics`·`/api/dx/tape`와 같은 로더) — 요약 4개(호출·오류율·전체 p95 — 그룹 평균이 아니라 전체 호출의 백분위, `summarizeCalls().total`·테이프 견적 수), 엔드포인트 표(코드 칩), 지역 표, 시간대별 괴리 막대(미국 주가가 있던 표본만, n 표시), 발행사·크기별 가격영향 막대, 발행사 비교 표, 발견 목록(dx_events).
- 수용: 실데이터 렌더, 캡션에 측정 방법
  - [x] 캡션: 블록마다 `측정 방법: …`.
  - [~] 렌더는 로컬(스크래치 DB의 합성 행 — 배치 확인용)로만 확인. 실데이터 렌더는 배포 후 → [HUMAN] 배포된 /dx 확인.

### M2-12 health·smoke·모니터·알림 · 기준: 기술
- 수용: `/api/judge/smoke` 전 항목 녹색, 모니터가 실패를 텔레그램으로 1회 전달(테스트)
  - [x] 코드(9/26): `GET /api/health`, `GET /api/judge/smoke`(DB·워커 마지막 틱 15분·Web3 API는 워커의 `api_calls` 마지막 성공 30분·BSC RPC 블록·하우스 잔고·마지막 영수증·테이프; red면 503). `pnpm smoke [--url] [--strict] [--alert]`(`scripts/smoke.ts`), 모니터 `.github/workflows/monitor.yml`(30분마다 `pnpm smoke --alert`, 저장소 변수 `IJARO_APP_URL` 없으면 꺼짐, 기본 브랜치에서만 cron 동작).
  - 증거: `read.test.ts`(틱 없음 → red 503, 전부 기록 → green, RPC 다운 → red). 로컬 실측 `pnpm smoke --url http://127.0.0.1:3100 --alert` → `database green, worker red(no tick recorded), web3api red, rpc green(block 124196543), house degraded, receipts degraded, tape red` → `status: red`, exit 1, 알림 채널 log(텔레그램 미설정).
  - [ ] [HUMAN] 배포된 웹 + 워커에서 전 항목 녹색, `IJARO_APP_URL`·`TELEGRAM_BOT_TOKEN`·`TELEGRAM_OPS_CHAT_ID` 설정 후 모니터 텔레그램 1회 수신 확인.

---

## M3 완성도 (10/5 ~ 10/7)

### M3-01 b402 + x402 · 기준: Studio 특별상·창의 (컷 후보 6·7순위)
- [ ] 유료 플랜 리포트 엔드포인트(b402), "AI 추천" 옵션에서 공식 Stock Analyze Agent x402 호출(하우스 지갑, 건당 캡)
- 수용: 402 → 결제 → 200 흐름 픽스처, 지출 원장 기록

### M3-02 모바일·접근성·성능 QA · 기준: UX
### M3-03 README 심사위원 경로 · 기준: 전체
- [~] 한 문장, 링크, 영상, Judge Mode, 영수증 표(자동 생성 스크립트), 모듈 매트릭스, DX 링크, 실행법, 위험 고지, 라이선스
  - (9/26) `README.md`: EN 한 줄, 60초 요약, 3분 체험 경로, 영수증 표 자리 + `pnpm receipts:table`(DB → 마크다운, `scripts/receipts-table.ts`), 모듈 매트릭스(PLAN §6.1에 코드 기준 상태 열 — 미사용·미구현도 그대로), 스킬 설치, 구조, 안전 장치, 위험, 실행법, 문서 지도.
  - [ ] [HUMAN] 라이브 링크·영상·DX 리포트 링크·라이선스 확정, 영수증 표 붙이기(돈 결정 이후).
### M3-04 영상 촬영 · 기준: 전체 — DEMO.md
### M3-05 보안 점검 · 기준: 기술 — 시크릿 스캔, 캡 검증, CSP, `pnpm audit`
- [x] (9/26) `docs/SECURITY.md`. 시크릿 스캔(전체 git 이력: 공개 테스트 키·가짜 벡터·가짜 예시 URL뿐, 추적 env 파일은 `.env.example`만), 캡 검증(설정 한 곳·원장 잠금·정확 승인·시뮬레이션 필수), CSP(`apps/web/proxy.ts`, 요청마다 nonce, 인라인 스크립트 금지; 홈 스크립트 7개 전부 nonce, ui:check CSP 위반 0) + HSTS·nosniff·DENY·Referrer·Permissions(`next.config.ts`), `pnpm audit --prod` 취약점 0(전체는 drizzle-kit 개발 경로 esbuild moderate 1 — 개발 서버 문제, 미사용 → [HUMAN] 수용 확인).
  - 점검 중 고친 자금 안전 버그: 스킬 플랜 정지·가디언 상환이 하우스 지갑에서 상환될 수 있던 경로 차단(D-19, 테스트는 수정 전 실패 확인), 스킬 플랜 run/preview 잡 거부.
  - 공개 응답에서 원문 오류 제거(DB 호스트·RPC URL 누출 방지): 화면·API·smoke는 라벨만, 원문은 서버 로그.
### M3-06 장애 리허설 · 기준: 기술 — API 다운·RPC 다운·워커 재시작·DB 복구, UI 3상태 확인, RUNBOOK 작성
- [x] RUNBOOK: `docs/RUNBOOK.md`(구성, 매일 점검, 멈추기, 장애별 절차 — API·RPC·워커·아웃박스·DB·가디언, 캡 변경은 사람 yes 먼저, 충전, 배포, 명령 모음).
- [x] 리허설(로컬, 9/26):
  - DB 다운: 닫힌 포트 DB로 `next start` → 7개 화면 200 + "불러올 수 없어요 (database unavailable)", API는 처음엔 500 → **고침**: `guard()`로 503 `{"state":"UNAVAILABLE","reason":"database unavailable"}`, smoke는 red 503 `database unreachable`(테스트 `read.test.ts`, 응답에 호스트 없음 확인).
  - RPC 다운: smoke `rpc` red 503(`read.test.ts`).
  - 워커 재시작: 이전 워커가 `running`으로 남긴 잡을 부팅 때 실패로 닫음(**새로 추가** — 전에는 영원히 running, `requeueStaleJobs`는 호출되지 않았음; `queue.test.ts`).
  - UI 3상태: LIVE/STALE/UNAVAILABLE — `read.test.ts`(테이프 없음 → 25분 전 → 1분 전), 빈 DB 화면 캡처.
  - [ ] [HUMAN] 배포 환경에서 API 다운(키 교체)·Fly 재시작·Neon 복구 리허설 1회.
- [x] 실거래 전 점검 `pnpm live:check`(9/27): config·플랜·outbox·하우스 잔고(RPC)·Venus 상태·가디언·레지스트리·워커·테이프·api_calls → GO / NO-GO.
  - 읽기 전용이다. Web3 API를 부르지 않고 서명하지 않는다.
  - 규칙은 `scripts/live-check-rules.ts`에 있다(테스트 8개, 분기 100%).
  - 절차와 멈춤 조건은 `docs/LIVE_TEST.md`에 있다.
  - 로컬 확인: 스크래치 DB에서 NO-GO(config·house·registry). 공개 BSC RPC 잔고 읽기가 동작했다.
### M3-07 [-] 모드 D 웹 지갑 연결 (기본 컷)
### M3-08 [-] BNB 스테이킹 이자원 (기본 컷)

---

## M4 제출 (10/8 ~ 10/9)

### M4-01 [HUMAN] DX 리포트 작성 — DX_PROTOCOL §5 구조, `dx/metrics.md`·`dx/LOG.md`·테이프 인용, 공식 폼 제출
### M4-02 [HUMAN] 영상 편집 ≤ 4분, 업로드(비공개 링크 아님)
### M4-03 제출 — 레포 public, 라이선스(MIT 권장), 릴리스 태그 v1.0, 제출 폼, 등록 확인
### M4-04 프리즈·운영 모드 — RUNBOOK 일일 점검표(10/12~10/23), 배포 금지

---

## 주간 자가채점 (JUDGING §4) — 9/27, 10/4, 10/8 [HUMAN+에이전트]
