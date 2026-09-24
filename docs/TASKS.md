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

### M0-04 리전 도달성 결정 · 기준: 기술
- [ ] `pnpm reach`를 (a) 한국 개발기 (b) 프랑크푸르트 러너 (c) Vercel icn1 함수에서 실행, 결과·코드(40304 여부) 기록
  - (a) 한국 개발기: 2026-09-24 00:17 UTC 도달 OK(서명 200, 지역 코드 없음) — DECISIONS Q-01. (b)(c) 남음.
- 수용: DECISIONS D-REGION 확정(웹 리전, 워커 리전, 개발 방식)

### M0-05 인스트루먼트 인벤토리 · 기준: 기술·창의
- [ ] RWA Data API로 BSC(56) 토큰·플랫폼 목록 수집(폴백: 공개 bapi type 1/2/3)
- [ ] 후보 티커 NVDA, TSLA, AAPL, MSFT, QQQ 존재 발행사 확인; 온체인 `symbol/decimals` 검증; bStocks `uiMultiplier` 읽기
- [ ] `instruments` 테이블 + 생성 스크립트 `pnpm registry`(코드 상수 금지)
- 수용: 5티커 × 발행사 매트릭스가 DECISIONS에, 픽스처 저장

### M0-06 소액 견적 스파이크 · 기준: 기술·DX
- [ ] 정규장(22:30~05:00 KST)과 장외 각각, NVDAB·NVDAon(+QQQ 계열)에 $1/$5/$50 견적: expectedOut, priceImpact, route/vendor, 오류코드
- [ ] 최소 체결 가능 금액과 기본 발행사 결정
- 수용: DECISIONS D-MIN-BUY, D-ISSUER 확정; 결과 표가 `dx/LOG.md`에

### M0-07 Venus 스파이크 · 기준: 기술·창의
- [ ] DeFi API: Venus 프로토콜 정보(보안점수·TVL·APY), USDT 투자 항목, 포지션 조회
- [ ] 온체인: vUSDT `exchangeRateStored`, `balanceOfUnderlying`, Comptroller 가드 플래그, 이용률 계산
- [ ] DeFi API 예치·상환 콜데이터 형태 확인 → Transaction API 시뮬레이션(하우스 지갑, 브로드캐스트 없음)
- [ ] `packages/core/amounts.ts`: 이자 계산 함수 + 테스트
- 수용: 시뮬레이션 성공 픽스처, 이자 계산 테스트 녹색

### M0-08 테이프 가동 · 기준: DX
- [ ] `apps/agent` 잡: 10분마다 인스트루먼트별 온체인가·참조가·장 상태 + 견적 3규모 → `tape_samples`
- [ ] 프랑크푸르트 러너에 배포, **9/25 20:00 KST 이전 가동**
- [ ] `GET /api/tape/latest`
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
- [ ] SPEC §4 타입, Drizzle 스키마 11개 테이블, 마이그레이션, 시드(하우스 플랜 2개)
- 수용: 마이그레이션 왕복, 타입 테스트

### M1-02 결정 엔진 `decideCycle` · 기준: 기술·창의
- [ ] 순수 함수: WINDOW/BUDGET/ASSET/PRICE/QUOTE 판단, 결과 `CycleOutcome` + whyKey
- [ ] 경계 테스트: 창구 경계 시각, 최소주문, 캡, 기업행동 코드, 발행사 폴백, 가격 괴리, 가격영향 축소 재견적
- 수용: 테스트 ≥ 30, 커버리지 100%(core)

### M1-03 HouseWalletExecutor · 기준: 기술
- [ ] 정확 승인 → Transaction API 시뮬레이션 → viem 서명 → Transaction API 브로드캐스트(RPC 폴백) → 영수증 폴링 → 실수령량 파싱
- [ ] `pnpm cycle:once --plan H-SAFE --live` (확인 프롬프트)
- 수용: **메인넷 NVDAB(또는 결정된 발행사) $5 매수 1건**, `receipts` 저장, BscScan 링크, 사유 한 줄. [HUMAN] 지출 승인 기록

### M1-04 안전 모드 완주 · 기준: 기술
- [ ] 스케줄러 없이 CLI로 사이클 전체(DUE→RECORD), 홀딩 갱신(주식 수)
- 수용: 사이클 레코드 + 홀딩 shares 계산 검증

### M1-05 이자 모드 완주 · 기준: 기술·창의
- [ ] 예치(DeFi API 콜데이터→시뮬→브로드캐스트), 이자 조회(온체인·DeFi API 교차), 상환, 매수
- 수용: **메인넷 영수증 3종(deposit, redeem, swap)**, 이자 표시. 이자 부족 시 적립 병행으로 체결하되 영수증에 구분 표기

### M1-06 스케줄러·창구·멱등 · 기준: 기술
- [ ] 5분 틱, 락, 멱등키, `nextDueAt`(개장+2분), DEFERRED(market_closed) 기록과 retryAt
- 수용: 주말 실행 시 DEFERRED 레코드 생성, 월요일 개장 후 자동 매수(로그로 증명)

### M1-07 에러 분류 v1 · 기준: 기술·DX
- [ ] SPEC §11 매핑, 재시도·백오프, 429, 알림(FAILED만), 미지 코드 최초 관측 시 dx 이벤트
- 수용: 코드별 단위 테스트, 알림 1회 실동작

### M1-08 홀딩·배수 · 기준: 창의·UX
- [ ] 영수증마다 multiplier 스냅샷, 변경 감지 이벤트, shares 재계산
- 수용: 배수 변경 시뮬레이션 테스트

### M1-09 하우스 플랜 가동 · 기준: 기술
- [ ] H-SAFE(일 $5, 정규장), H-YIELD(원금 확정액, 주 1회) 9/30부터 연속 가동
- 수용: 10/4까지 사이클 레코드 ≥ 4일치, FAILED 0 또는 원인 기록

---

## M2 제품화 (10/1 ~ 10/4) — 목표: 심사위원 3분 완주

### M2-01 Watch 홈 · 기준: UX·기술
- [ ] 하우스 카드 2개, 영수증 피드(사유+링크), 장 상태 배지, LIVE/STALE/UNAVAILABLE, CTA 2개
- 수용: 모바일 375px에서 가로 스크롤 없음, 첫 화면 3초 이해 리허설(강민서 체크리스트)

### M2-02 Judge Mode · 기준: UX·기술
- [ ] 코드 → 종목/섹터 → 모드·금액 → 미리보기(사람 말+원본 토글) → 실행 진행 → 영수증 → [멈추기]
- [ ] 코드별 캡, 7일 자동 stop, 리셋
- 수용: 리허설 3분 이내 완주 3회 연속, 실패 경로(장 마감·캡 초과) 문구 확인

### M2-03 플랜 상세·정지·전액 상환 · 기준: UX·기술
- 수용: 이자 모드 정지 시 상환 영수증 표시

### M2-04 위험 고지·안전 기본값·용어 치환 · 기준: UX
- [ ] UX_COPY §5 전문, 금지어 린트 스크립트(`pnpm lint:copy`)
- 수용: 금지어 0건

### M2-05 KR/EN i18n · 기준: UX
- 수용: 모든 문자열이 키 기반, 언어 토글

### M2-06 가디언 · 기준: 기술·창의·UX
- [ ] PLAN §7 규칙, 이벤트 표시, 전액 상환 액션(시뮬 성공 시만)
- 수용: 규칙별 테스트, 수동 트리거로 UI 표시 확인

### M2-07 기업행동·섹터 후보 · 기준: 창의·기술
- 수용: PAUSED/LIMITED 픽스처로 SKIPPED 사유 표시, 섹터 후보 대체 테스트

### M2-08 Skill API · 기준: AW 특별상·기술
- [ ] `/api/plans`, `/preview`, `/next`, `/report`, `/stop`, 토큰 발급·검증, 레이트리밋
- 수용: OpenAPI 문서, `/next` 응답에 baw 명령 파라미터·사유·만료 시각

### M2-09 Wallet Skill v1 · 기준: AW 특별상·DX
- [ ] `skills/ijaro/SKILL.md` + references(plan.md, run.md, safety.md), 설치 경로 확정
- [ ] [HUMAN+에이전트] Claude Code에서 실제 실행: 안전 모드 $5 매수 1건, 이자 모드 예치 1건 → `docs/skill-demo.md`(마스킹)
- 수용: 클린 머신 설치→첫 실행 ≤ 10분, 소감·막힘이 dx/LOG.md에

### M2-10 Agent Studio · 기준: Studio 특별상
- [ ] 하우스 에이전트 신원 등록(ERC-8004), 가능하면 런타임/MCP, 사이트에 신원 링크
- 수용: 등록 tx·에이전트 ID가 README에

### M2-11 /dx 페이지 · 기준: DX
- [ ] p50/p95·오류코드·리전, 테이프 차트 3종(정규장 vs 장외 괴리, 규모별 가격영향, 발행사 비교), 발견 목록
- 수용: 실데이터 렌더, 캡션에 측정 방법

### M2-12 health·smoke·모니터·알림 · 기준: 기술
- 수용: `/api/judge/smoke` 전 항목 녹색, 모니터가 실패를 텔레그램으로 1회 전달(테스트)

---

## M3 완성도 (10/5 ~ 10/7)

### M3-01 b402 + x402 · 기준: Studio 특별상·창의 (컷 후보 6·7순위)
- [ ] 유료 플랜 리포트 엔드포인트(b402), "AI 추천" 옵션에서 공식 Stock Analyze Agent x402 호출(하우스 지갑, 건당 캡)
- 수용: 402 → 결제 → 200 흐름 픽스처, 지출 원장 기록

### M3-02 모바일·접근성·성능 QA · 기준: UX
### M3-03 README 심사위원 경로 · 기준: 전체
- [ ] 한 문장, 링크, 영상, Judge Mode, 영수증 표(자동 생성 스크립트), 모듈 매트릭스, DX 링크, 실행법, 위험 고지, 라이선스
### M3-04 영상 촬영 · 기준: 전체 — DEMO.md
### M3-05 보안 점검 · 기준: 기술 — 시크릿 스캔, 캡 검증, CSP, `pnpm audit`
### M3-06 장애 리허설 · 기준: 기술 — API 다운·RPC 다운·워커 재시작·DB 복구, UI 3상태 확인, RUNBOOK 작성
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
