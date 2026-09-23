# SPEC.md — 기술 명세

작성: 이도현 (시스템·거래 인프라 수석). 검토: 강민서(UX 접점), 박지우(계측·제출).
표기: **⚠️VERIFY** = 문서(`docs/vendor/llms-full.txt`)나 실호출로 확인한 뒤 `DECISIONS.md`에 결과를 적을 것. 확인 전에 그 위에 무언가를 쌓지 말 것.

## 1. 스택과 레포 구조

- Node 22, TypeScript 5, pnpm workspaces. 테스트 vitest. 린트 eslint + prettier.
- `apps/web`: Next.js(App Router) + Tailwind. Vercel 배포, 서버 함수 리전 **fra1**(프랑크푸르트). 서울 `icn1`은 M0-04 도달 결과에 따라 웹만 허용.
- `apps/agent`: 장기 실행 Node 워커(node-cron). Fly.io 또는 Render, 리전 **Frankfurt**. 금지 리전: 암스테르담·런던·도쿄·싱가포르(제한 지역이거나 차단 보고).
- `packages/core`: 순수 도메인. 외부 I/O 없음. 100% 단위 테스트 대상.
- `packages/binance`: Web3 API 클라이언트.
- `packages/chain`: viem 기반 BSC 읽기·서명. RPC: 공식 BSC 데이터시드 + 예비 1개.
- `packages/db`: Drizzle + Postgres(Neon, 프랑크푸르트). 로컬 개발도 Postgres(도커) — SQLite 분기 금지.
- `skills/ijaro`: Wallet Skill.
- 공통 설정: `packages/config` (zod로 env 검증, 캡 상수).

## 2. 환경 변수 (`.env.example` 참조)

| 변수 | 용도 |
| --- | --- |
| `BINANCE_WEB3_API_KEY`, `BINANCE_WEB3_API_SECRET` | Web3 API 서명 |
| `BINANCE_WEB3_BASE_URL` | 기본 `https://web3.binance.com/build` ⚠️VERIFY |
| `BSC_RPC_URL`, `BSC_RPC_URL_FALLBACK` | 체인 읽기·폴백 브로드캐스트 |
| `DATABASE_URL` | Postgres |
| `HOUSE_WALLET_PRIVATE_KEY` | 하우스 지갑 (서버 전용, 총 잔고 ≤ $300) |
| `EXECUTION_MODE` | `simulate`(기본) / `live` |
| `HOUSE_MAX_PER_TX_USD`=25, `SANDBOX_MAX_PER_PLAN_USD`=5, `DAILY_SPEND_CAP_USD`=50, `MIN_BUY_USD`=2, `MAX_PRINCIPAL_USD`=1000 | 캡 |
| `JUDGE_CODES` | 쉼표 구분 심사 코드 |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPS_CHAT_ID` | 운영 알림 |
| `REGION_TAG` | 계측용 (`fra`, `icn`, `kr-dev`) |

캡은 코드에서 `packages/config`를 통해서만 읽고, UI에 표시한다.

## 3. 외부 시스템

### 3.1 Binance Web3 API 클라이언트 (`packages/binance`)
사전 참고자료(선행 빌더 메모, 모두 ⚠️VERIFY):
- Base `https://web3.binance.com/build`. 헤더 `X-OC-APIKEY`, `X-OC-TIMESTAMP`(ISO 8601 ms), `X-OC-SIGN` = base64(HMAC-SHA256(secret, timestamp + METHOD + path + body)). **서명 대상 path에 `/build` 접두사와 쿼리스트링을 포함**(서명 실패 1순위 원인). 선택 `X-OC-RECV-WINDOW`.
- 응답 엔벨로프 `{ code, msg, data, success, timestamp }`. **API 오류가 HTTP 200으로 올 수 있음** → `success === false || code !== 0`을 오류로 취급. 게이트웨이 401은 `success` 필드 없음.
- 레이트 리밋: 엔드포인트당 5 req/s, 키·IP당 1,200/min. 429는 `Retry-After` 준수.
- 공식 커넥터 `@binance-web3/wallet`(npm)을 devDependency로 설치해 **경로·파라미터·서명의 1차 출처**로 사용. 우리 클라이언트를 직접 구현하는 이유: 원본 엔벨로프·raw 응답이 계측과 픽스처에 필요.

클라이언트 요구사항:
1. `request<T>(module, endpoint, opts)` 단일 진입점. 엔드포인트별 토큰버킷(5/s), 전역 1,200/min.
2. 모든 호출을 `api_calls`에 기록: ts, region, module, endpoint, method, http_status, code, msg(민감정보 마스킹), latency_ms, request_id, retry_count, fixture_path(옵션).
3. 오류를 `BinanceApiError { module, endpoint, httpStatus, code, msg, retryable }`로 정규화. 코드 매핑은 §11.
4. `recordFixture` 옵션: 응답을 `fixtures/<module>/<endpoint>-<yyyymmdd>-<n>.json`으로 저장(키·주소 마스킹).
5. 시계 오차 대비: 서버 `timestamp`와 로컬 시각 차이를 측정해 경고.

사용 엔드포인트 (모듈별 · 경로는 ⚠️VERIFY, llms-full.txt에서 확정 후 `docs/vendor/ENDPOINTS.md`에 정리):

| 모듈 | 용도 | 비고 |
| --- | --- | --- |
| RWA Data | 토큰·플랫폼 목록, 티커 검색, 온체인가·참조가, 회사 프로필·증명서, 장 상태·다음 개장, 섹터 필터 | 인스트루먼트 레지스트리 생성원 |
| Market | 가격 배치(`POST .../market/price`, 배열 body ⚠️VERIFY), 캔들, USDT 가격 | 5분 틱마다 배치 1회 |
| Trading | 견적(RFQ 발행사는 `userWalletAddress` 필수 ⚠️VERIFY), 승인 콜데이터, 스왑 콜데이터, MEV | 견적 만료·재견적 규칙 §5.6 |
| Transaction | 시뮬레이션, 브로드캐스트, 상태 조회 | 모든 쓰기의 관문 |
| Wallet | 잔액·토큰·이력 | 하우스·샌드박스 |
| DeFi | 프로토콜 목록·정보(보안점수·TVL·APY), 투자 목록, 포지션, 예치·상환 콜데이터 | Venus 코어 풀 USDT만 |
| b402 | 402 결제 요구·검증·정산 | Should |

공개 RWA 보조 엔드포인트(인증 불필요, 공식 스킬 문서 출처, 장애 시 폴백·교차검증용):
`https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/` 아래 `stock/detail/list/ai?type=1|2|3`(1 Ondo, 2 xStocks, 3 bStocks), `meta/ai`, `market/status/ai`, `asset/market/status/ai`, `…/v2/…/dynamic/ai`, K-Line. 헤더 `Accept-Encoding: identity`.

### 3.2 Agentic Wallet (`baw`, npm `@binance/agentic-wallet` 1.10.0)
- 서버에서 사용자용으로 실행 금지. 사용처는 (1) 사용자 기기의 비서 + 우리 Skill, (2) 팀 개발기의 검증·촬영.
- 확인된 명령: `auth signin/verify`, `wallet status/settings/balance/tx-history`, `market-order quote/swap/list`, `limit-order buy/sell/list/cancel`, `defi protocol-list/investment-list/position/deposit/redeem/preview`, `x402-payment preview/sign`, `approvals list/revoke`.
- 정책: 상태 변경 전 미리보기·확인, `--json` 필수, `orderId`는 체결이 아님(`market-order list`로 FINISHED/FAILED 확인), `wallet settings`의 `sessionExpireTime`·`dailyLimit`·`defiDailyLimit`·`x402DailyLimit` 존중.
- ⚠️VERIFY: RWA 토큰에 대한 `market-order swap` 지원, `limit-order` 지원 여부, `defi deposit` Venus USDT 지원 여부 (M0-09).

### 3.3 BNB Agent Studio (`bag`)
- 목적: 하우스 에이전트 ERC-8004 신원, 가능하면 런타임·MCP 등록.
- ⚠️VERIFY(M0-10): 런타임이 임의 Node 워커를 돌릴 수 있는지, 지갑 제공 방식, ERC-8183 태스크 인터페이스 노출 방법, 비용.

### 3.4 체인 상수 (사용 전 온체인 검증 필수)
| 이름 | 주소 | 검증 |
| --- | --- | --- |
| USDT (BSC) | `0x55d398326f99059fF775485246999027B3197955` | 공식 스킬 표 |
| USDC (BSC) | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 공식 스킬 표 |
| Venus vUSDT (코어 풀) | `0xfD5840Cd36d94D7229439859C0112a4185BC0255` | ⚠️VERIFY `symbol()`, `underlying()` |
| Venus Comptroller | `0xfD36E2c2a6789Db23113685031d7F16329158384` | ⚠️VERIFY |
| 주식 토큰 | **코드 상수 금지.** RWA Data API → 레지스트리 생성 → 온체인 `symbol/decimals` 검증 | M0-05 |

BEP-677(bStocks): `balanceOf`는 배당·분할에 불변, `uiMultiplier`가 변한다. 배수 변경을 감지하면 보유량 캐시 무효화. Ondo/xStocks는 RWA 목록의 `multiplier`.

## 4. 도메인 모델 (`packages/core/src/types.ts`)

```ts
type Issuer = 'bstocks' | 'ondo' | 'xstocks';
type PlanOwner = { kind: 'house' } | { kind: 'judge'; code: string } | { kind: 'skill'; token: string };
type PlanMode = 'safe' | 'yield';
type Window = 'regular_session' | 'anytime';

interface Instrument { ticker: string; issuer: Issuer; chainId: 56; address: `0x${string}`;
  symbol: string; decimals: number; multiplier: string; verifiedAt: string; }

interface Plan { id: string; owner: PlanOwner; mode: PlanMode;
  target: { type: 'ticker'; ticker: string } | { type: 'sector'; sector: string };
  issuerPreference: Issuer[];           // 기본 ['bstocks','ondo']
  principalUsd: number;                 // yield 모드만, ≤ MAX_PRINCIPAL_USD
  contributionUsd: number;              // 0 허용
  cadence: 'weekly' | 'daily' | 'once'; window: Window;
  limits: { maxPerBuyUsd: number; maxDailyUsd: number };
  status: 'active' | 'paused' | 'stopped'; pausedReason?: string;
  createdAt: string; nextDueAt: string; expiresAt?: string; /* judge: +7d */ }

type CycleOutcome =
  | { kind: 'BOUGHT'; spendUsd: number; tokens: string; shares: string; refGapPct: number }
  | { kind: 'DEFERRED'; reason: 'market_closed' | 'price_gap' | 'session_expiring' | 'quote_impact'; retryAt: string }
  | { kind: 'SKIPPED'; reason: 'below_min' | 'corporate_action' | 'daily_cap' | 'guardian' | 'no_instrument'; detail?: string }
  | { kind: 'FAILED'; code: string; message: string; fundsMoved: boolean };

interface Cycle { id: string; planId: string; startedAt: string; finishedAt?: string;
  steps: StepLog[]; outcome: CycleOutcome; whyKey: string; whyParams: Record<string, string>;
  receipts: Receipt[]; }

interface Receipt { kind: 'deposit' | 'redeem' | 'approve' | 'swap'; txHash: string; explorerUrl: string;
  chainId: 56; amounts: Record<string, string>; broadcastVia: 'transaction_api' | 'rpc'; simulatedAt: string; }

interface Holding { planId: string; instrument: Instrument; tokens: string; multiplierAtLastUpdate: string;
  shares: string; costUsd: string; updatedAt: string; }
```

DB 테이블: `plans, cycles, receipts, holdings, instruments, api_calls, tape_samples, guardian_events, judge_codes, skill_tokens, spend_ledger`.
`spend_ledger`는 일일 캡 계산의 단일 출처(UTC 일 기준).

## 5. 에이전트 루프 (`apps/agent`)

틱: 5분. 플랜마다 분산 락(`plans.lock_until`)으로 중복 실행 방지. 사이클은 멱등키 `planId:dueAt`.

### 5.1 DUE
`now ≥ plan.nextDueAt` 아니면 종료(기록 없음). due면 사이클 생성.

### 5.2 WINDOW
- `window === 'regular_session'`: RWA 장 상태(전체) + 종목 상태 `marketStatus === 'regular'`이고 `openState`이어야 통과. 아니면 `DEFERRED(market_closed, retryAt = nextOpenTime)`. `nextDueAt`을 `nextOpenTime + 2분`으로 옮긴다(개장 직후 첫 견적의 이상치를 피함).
- `anytime`: 통과하되 `limits.maxPerBuyUsd`를 절반으로 적용하고 사유에 "장외" 표기.

### 5.3 BUDGET
- safe: `budget = contributionUsd`.
- yield: `positionUsd = underlyingBalance(vUSDT)`(온체인 `balanceOfUnderlying` 또는 DeFi API 포지션, 둘 다 조회해 불일치 시 계측); `interest = positionUsd − principalUsd − alreadyHarvested`; `budget = interest + contributionUsd`.
- `spend = min(budget, maxPerBuyUsd, dailyRemaining)`. `spend < MIN_BUY_USD` → `SKIPPED(below_min)`, 누적액을 사유에 표시.

### 5.4 ASSET
RWA 종목 상태 코드: `TRADING` 통과. `ASSET_LIMITED(earnings)` / `ASSET_PAUSED(*)` → 티커 플랜은 `SKIPPED(corporate_action, detail)`, 섹터 플랜은 다음 후보로.
발행사 선택: `issuerPreference` 순서로 인스트루먼트가 존재하고 견적이 나오는 첫 발행사.

### 5.5 PRICE
RWA 온체인가 vs 참조가 괴리 `gap = onchain/reference − 1`. 정규장에서 `|gap| > 2%` → `DEFERRED(price_gap, retryAt = +30m)`. 참조가는 온체인 가격에서 파생된 값일 수 있으므로(⚠️VERIFY) 보조 지표로만 쓰고 사유에 "참조가(플랫폼 제공)"로 표기.

### 5.6 QUOTE
Trading API 견적 `spend` USDT → 토큰. `priceImpactPct > 1%` → spend를 절반으로 재견적(최대 2회), 여전히 초과면 `DEFERRED(quote_impact)`. 견적 유효시간 ⚠️VERIFY; 실행 직전 60초 넘으면 재견적.

### 5.7 REDEEM (yield만)
필요액 = `spend − 지갑 USDT 여유분`. DeFi API 상환 콜데이터 → Transaction API 시뮬레이션 → 서명 → 브로드캐스트 → 영수증. 실패 시 사이클 `FAILED(fundsMoved=false)`.

### 5.8 SIMULATE → EXECUTE → CONFIRM
승인 필요 시 **정확 금액** 승인(콜데이터는 Trading API). 스왑 콜데이터 → Transaction API 시뮬레이션(실패면 사유와 함께 `FAILED`, fundsMoved=false) → viem 서명 → Transaction API 브로드캐스트(실패 시 RPC 폴백, `broadcastVia` 기록) → 영수증 폴링(최대 3분). 실제 수령량은 영수증 로그에서 파싱(견적값 사용 금지).

### 5.9 RECORD
`holdings` 갱신(tokens, multiplier 스냅샷, shares = tokens × multiplier), `spend_ledger` 기록, `whyKey/whyParams` 저장(UX_COPY §4 키), 피드 발행, 운영 알림(FAILED만). `nextDueAt` 갱신(weekly: 다음 주 같은 창구, daily: 다음 정규장).

### 5.10 하우스 플랜 초기값
- Plan H-SAFE: NVDA, safe, contribution $5, daily, regular_session, maxPerBuy $5.
- Plan H-YIELD: QQQ(없으면 MSFT), yield, principal $200(예산 허용 시 $500), contribution $0, weekly, regular_session. 이자 누적 표시가 핵심 화면이므로 매수가 드물어도 유지.
(금액은 하우스 지갑 예산 ≤ $300 내에서 DECISIONS에서 확정.)

## 6. 가디언 (`packages/core/guardian.ts`, 틱마다 실행)
PLAN §7 표를 그대로 구현. 입력은 `GuardianInputs {comptrollerPaused, tvlChange24hPct, utilizationPct, usdtPrice, ...}`, 출력은 `GuardianAction[]`. 액션 실행은 `apps/agent`. 모든 발동은 `guardian_events`에 기록되고 Watch 화면에 노출된다. 전액 상환은 시뮬레이션 성공 시에만 브로드캐스트하고, 실패하면 알림 후 사람 개입 대기.

## 7. 실행 어댑터 (`apps/agent/src/executors`)
| 어댑터 | 서명 주체 | 사용 모드 | 비고 |
| --- | --- | --- | --- |
| `HouseWalletExecutor` | 서버(viem) | A, B | 캡: HOUSE_MAX_PER_TX_USD, 샌드박스는 SANDBOX_MAX_PER_PLAN_USD |
| `DecisionOnlyExecutor` | 없음 | C | 결정과 콜데이터·금액·주소·사유만 반환. 사용자 비서가 baw로 실행 후 `/report` |
| `SimulateExecutor` | 없음 | 개발·CI | Transaction API 시뮬레이션까지만 |

## 8. 웹 앱 (`apps/web`)

### 8.1 화면
| 경로 | 화면 | 핵심 요소 |
| --- | --- | --- |
| `/` | Watch | 하우스 플랜 2개 카드(원금·이자 누적·보유 주식 수·다음 매수 시각), 영수증 피드(사유 한 줄+BscScan), 장 상태 배지, 데이터 상태, [심사위원 코드] [내 비서로 시작] |
| `/judge` | Judge Mode | 코드 → 종목/섹터 → 모드·금액 → 미리보기 → 실행 → 영수증 → 정지 |
| `/plans/[id]` | 플랜 상세 | 타임라인, 가디언 이벤트, 한도 사용량, [멈추기/전액 상환] |
| `/risk` | 위험 고지 | UX_COPY §5 전문 |
| `/dx` | 개발자 경험 | 엔드포인트별 p50/p95·에러코드, 테이프 차트(정규장 vs 장외 괴리, 규모별 가격영향, 발행사 비교), 발견 목록 링크 |
| `/skill` | 스킬 설치 안내 | 한 줄 설치, 예시 대화, 안전 규칙 |

### 8.2 API
| 메서드·경로 | 용도 | 인증 |
| --- | --- | --- |
| `GET /api/health` | 프로세스 생존 | 없음 |
| `GET /api/judge/smoke` | Web3 API 도달·RPC·DB·마지막 틱 시각·하우스 잔고·마지막 영수증·테이프 최신 시각을 한 번에 | 없음(읽기) |
| `POST /api/judge/session` | 심사 코드 검증 → 세션 쿠키 | 코드 |
| `POST /api/plans` | 플랜 생성(B: 세션, C: 스킬 토큰 발급) | 세션/토큰 |
| `POST /api/plans/:id/preview` | 시뮬레이션 미리보기(사람 말 + 원본) | 세션/토큰 |
| `POST /api/plans/:id/run` | 즉시 1사이클(B) | 세션 |
| `GET /api/plans/:id/next` | 결정(C): 지금 할 일, 금액, 주소, 콜데이터 없이 baw 명령 파라미터, 사유 | 토큰 |
| `POST /api/plans/:id/report` | C 실행 결과 보고(txHash, orderId, 상태) | 토큰 |
| `POST /api/plans/:id/stop` | 정지(+전액 상환 요청) | 세션/토큰 |
| `GET /api/market/status`, `GET /api/instruments` | 읽기 | 없음 |
| `GET /api/dx/metrics`, `GET /api/tape/latest` | 읽기 | 없음 |

쓰기 라우트는 모두 레이트리밋(IP·세션)과 캡 검증. 심사 코드별 총액 캡. 샌드박스 플랜은 7일 후 자동 stop.

## 9. Wallet Skill (`skills/ijaro`)
- 형식은 Skills Hub의 `binance-agentic-wallet`을 따른다(frontmatter `name/description/metadata`, `references/`). `requires: bins: [baw]`, 선행 스킬 `binance-agentic-wallet` 설치 확인.
- 명령 라우팅: 플랜 만들기 → `POST /api/plans`; 지금 할 일 → `GET /next`; 실행 → 서버가 준 파라미터로 `baw defi deposit|redeem`, `baw market-order quote → swap`, 완료 확인 `market-order list --orderId`; 보고 → `POST /report`; 상태·정지.
- 안전 규칙(스킬 문서에 명시): 위험 고지 낭독 후 동의, 상태 변경 전 항상 미리보기·확인, 서버가 준 주소는 RWA 목록 API로 교차검증, 세션 만료 2시간 전 알림, `orderId`≠체결, 오류 원문 그대로 전달.
- 테스트: 팀 개발기에서 Claude Code로 안전 모드 $5 매수 1건, 이자 모드 예치 1건을 실제 실행하고 transcript를 `docs/skill-demo.md`에 저장(마스킹).

## 10. 계측·DX (박지우 요구사항)
- `api_calls`: §3.1. 주간 `pnpm dx:metrics` → `dx/metrics.md`(엔드포인트별 count, p50, p95, 오류코드 분포, 리전별).
- `tape_samples`: 10분마다 인스트루먼트(5티커 × 존재 발행사)별 온체인가·참조가·장 상태 + 견적 $5/$50/$500(expectedOut, priceImpact, route/vendor, 오류코드). 정규장·프리/포스트·주말 태그.
- `/dx` 페이지가 위 둘을 렌더. DX 리포트의 "Tokenized-stock specifics"는 여기서 나온다.
- 이벤트 훅: 오류코드 최초 관측, 문서와 다른 응답 형태, p95 > 2s → 운영 알림 + `dx/LOG.md`에 에이전트가 사실 기록(사람이 서술 보강).

## 11. 에러 분류표 (초기값, 코드는 ⚠️VERIFY)
| 출처 | 코드/조건 | 의미 | 처리 | 사용자 문구 키 |
| --- | --- | --- | --- | --- |
| Web3 API | 40001 | 파라미터 | 재시도 없음, 버그로 취급 | `err.internal` |
| Web3 API | 40101/40102/40103/40104 | 키·서명·타임스탬프·권한 | 서명·시계 점검, 알림 | `err.internal` |
| Web3 API | 40304 | 컴플라이언스/지역 | 리전 문제, 알림, UNAVAILABLE | `err.region` |
| Web3 API | 40369 | RFQ 장외 거부 | DEFERRED(market_closed) | `why.deferred.market_closed` |
| Web3 API | 40374 | 유동성 없음 | 다음 발행사 시도 → SKIPPED(no_instrument) | `why.skipped.no_liquidity` |
| Web3 API | 40365–40375 기타 | 거래 오류 | 코드별 매핑 후 FAILED | `err.trade` |
| HTTP | 429 | 레이트리밋 | Retry-After 대기, 1회 재시도 | — |
| Transaction API | simulate 실패 | 리버트 등 | FAILED(fundsMoved=false) | `why.failed.simulation` |
| 체인 | 영수증 status 0 | 실패 | FAILED(fundsMoved=gas only) | `why.failed.onchain` |
| 내부 | 캡 초과 | — | SKIPPED(daily_cap) | `why.skipped.daily_cap` |
| RWA | ASSET_PAUSED/LIMITED | 기업행동 | SKIPPED(corporate_action) | `why.skipped.corporate_action.<reason>` |

## 12. 테스트·실행 모드·CI
- `packages/core`: 결정 엔진·가디언·금액 수학 단위 테스트(경계값: 최소주문, 캡, 창구 경계 시각, 배수 변경).
- `packages/binance`: 서명 벡터 테스트(커넥터 소스와 동일 결과), 엔벨로프 파싱, 레이트리밋.
- 통합: 픽스처 리플레이(`fixtures/`), `EXECUTION_MODE=simulate`로 전체 루프.
- 수동 실거래: `pnpm cycle:once --plan <id> --live`는 금액·주소·시뮬레이션 결과를 출력하고 `y` 입력을 요구.
- CI(GitHub Actions): typecheck·lint·test. 시크릿 없음. 배포는 수동.

## 13. 배포·운영
- 웹: Vercel(fra1). 워커: Fly/Render Frankfurt, 재시작 정책 always, 1 인스턴스(락으로 중복 방지).
- 업타임 모니터: `/api/judge/smoke` 5분 간격, 실패 시 텔레그램.
- 런북(`docs/RUNBOOK.md`, M3에서 작성): 워커 재시작, DB 복구, 하우스 지갑 충전, 캡 변경 절차, 심사 기간 일일 점검표.
- 10/9 이후 배포 금지(핫픽스 예외, smoke 필수).

## 14. 보안 규칙
- 서버는 사용자 키·시드·Agentic Wallet 세션·API 키를 **절대 저장하지 않는다.** 모드 C의 서명은 사용자 기기.
- 하우스 키는 서버 env에만, 잔고 ≤ $300. 정확 승인만. 캡은 코드 강제.
- 모든 쓰기 라우트 인증·레이트리밋. CSP, HSTS. 의존성 감사(`pnpm audit`) M3.
- 로그·픽스처에 키·주소 마스킹. `.env*`, `.studio/`, baw 세션 파일 gitignore.
- 토큰 주소는 API + 온체인 검증을 거친 레지스트리에서만. 사용자 입력 주소 금지.
