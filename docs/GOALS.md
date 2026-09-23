# GOALS.md — `/goal` 지시서 (Opus 5.5용)

작성: 박지우·이도현. `/goal`은 조건이 충족될 때까지 Claude가 턴을 스스로 이어가고, 매 턴 끝에 별도 평가 모델이 "충족/미충족/불가능"을 판정한다(공식 문서: https://code.claude.com/docs/en/goal.md). 그래서 지시서는 아래 원칙으로 쓴다.

## 0. 사용 원칙
1. **한 번에 골 하나.** 아래 순서대로. 앞 골이 끝나기 전에 다음 골을 주지 않는다.
2. **사람 손이 필요한 일은 골 안에 넣지 않는다.** 각 골의 "선행 조건"을 사람이 먼저 끝낸다. (API 키, 계정, 자금, 텔레그램 답변)
3. **평가 모델은 Claude의 출력만 본다.** 그래서 모든 골은 "매 턴 끝에 `GOAL STATUS` 블록으로 조건별 PASS/FAIL과 증거(명령 출력 인용)를 보고"하게 되어 있다. Claude가 이 블록을 빼먹으면 평가가 흔들린다.
4. **턴 상한**을 넣어 무한 루프를 막는다. 상한에 걸리면 남은 항목과 이유를 적고 멈추게 했다.
5. 권장 실행 환경: 레포 루트에서 Claude Code를 **auto 모드**로 열고 `/goal <조건>` 입력. 진행 확인은 `/goal`, 중단은 `/goal clear`. 백그라운드 작업 체크인 주기는 `CLAUDE_CODE_GOAL_CHECKIN_MINUTES`(기본 30분).
6. 골이 "불가능"으로 종료되면 이유를 읽고 선행 조건을 고친 뒤 같은 골을 다시 준다.
7. 골 사이마다 사람이 할 일: `git log`와 `docs/TASKS.md` 변경 확인, `dx/LOG.md`에 `- 소감:` 추가, 지출이 있었으면 영수증 확인.

## 1. 순서표

| 골 | 내용 | 선행 조건(사람) | 자금 이동 | 턴 상한 |
| --- | --- | --- | --- | --- |
| G0 | 레포 부트스트랩·문서 검증·클라이언트 오프라인 부분 | 없음 | 없음 | 30 |
| G1 | API 도달·인벤토리·소액 견적·Venus 스파이크·테이프 로컬 가동 | API 키, 로컬 Postgres, 하우스 지갑 주소 | 없음 | 40 |
| G2 | 테이프를 프랑크푸르트 호스트에 배포 | Neon DB, Fly/Render 앱·토큰, env 설정 | 없음 | 15 |
| G3 | M1 핵심(스키마·결정 엔진·실행 어댑터)을 simulate 모드로 완성 | 없음 | 없음 | 40 |
| G4 | 메인넷 첫 영수증(안전 1건, 이자 모드 3건) — 사람 입회 | 하우스 지갑 충전, 정규장 시간대, 사람이 `y` 입력 | **있음(≤$60)** | 15 |
| G5 | 스케줄러·멱등·하우스 플랜 2개 호스트 가동 | G2 호스트 | 있음(캡 내 자동) | 20 |
| G6 | 웹: Watch·Judge Mode·정지·위험 고지·i18n·문구 린트 | 없음 | 없음 | 40 |
| G7 | 가디언·기업행동·/dx·smoke·모니터 알림 | 텔레그램 봇 토큰, 업타임 모니터 계정 | 없음 | 30 |
| G8 | Skill API + Wallet Skill + Agent Studio 코드 부분 | `bag` 스파이크 결과(Q-09) | 없음 | 25 |
| G9 | M3: README 심사 경로·보안 점검·런북·장애 리허설·b402 | 배포 URL, 영상 링크 | 있음(x402 소액, 옵션) | 25 |

각 골의 전문은 아래. `/goal ` 뒤에 그대로 붙여넣는다(4,000자 이내 확인됨).

---

## G0 — 부트스트랩

```
이자로(Ijaro) M0 부트스트랩을 끝낸다. 먼저 CLAUDE.md, docs/JUDGING.md, docs/TASKS.md를 읽는다. 완료 조건(모두 충족):
1) M0-01: pnpm workspace가 만들어져 apps/web(Next.js App Router), apps/agent, packages/{core,binance,chain,db,config}, skills/ijaro, scripts, fixtures, dx가 존재하고, `pnpm install && pnpm typecheck && pnpm lint && pnpm test`가 모두 exit 0이다(각 명령의 마지막 출력 줄 인용). .github/workflows/ci.yml이 같은 세 명령을 실행한다. packages/config가 .env.example의 모든 변수를 zod로 검증하고, 캡 상수(HOUSE_MAX_PER_TX_USD 등)를 여기서만 읽는다.
2) M0-02: `bash scripts/fetch-docs.sh`가 성공해 docs/vendor/llms-full.txt가 존재하고(줄 수 인용), @binance-web3/wallet이 devDependency로 설치되어 있으며, docs/vendor/ENDPOINTS.md에 RWA Data, General market data, Trading, Transaction, Wallet, Address portfolio, DeFi data, DeFi transaction, b402, Authentication 각 모듈의 경로·메서드·필수 파라미터·주요 응답 필드가 llms-full.txt의 섹션 제목을 출처로 표로 정리되어 있다. docs/SPEC.md §3.1의 ⚠️VERIFY 중 문서만으로 확인 가능한 항목(base URL, 서명 문자열 구성, 헤더명, 엔벨로프, 레이트리밋, 견적 유효시간)의 결과가 docs/DECISIONS.md §2에 기록되어 있다. 문서에서 못 찾은 항목은 "미확인: 이유"로 남긴다.
3) M0-03 오프라인 부분: packages/binance에 서명 함수, 엔벨로프 파서(HTTP 200 오류 처리 포함), 엔드포인트별 토큰버킷, api_calls 기록 훅, 픽스처 저장 옵션이 있고, 서명 벡터 테스트가 커넥터 소스와 동일한 서명을 만든다는 것을 통과한 테스트 이름으로 보여준다. `pnpm reach`가 존재하고 키가 없으면 "UNAVAILABLE: no API key"를 출력한다.
4) M0-12: dx/LOG.md에 이 작업 중 발견한 문서 불일치·의문이 docs/DX_PROTOCOL.md §3.1 형식으로 추가되어 있다(없으면 "발견 없음" 항목).
5) docs/TASKS.md의 M0-01, M0-02, M0-12와 M0-03 오프라인 항목이 [x]와 증거로 갱신되고, 모든 변경이 커밋되어 `git status`가 clean이다.
제약: 자금 이동 없음, .env 커밋 금지, 목업 데이터 금지, 범위 밖 기능 금지, 문서에 없는 엔드포인트를 지어내지 않음. 매 턴 끝에 "GOAL STATUS" 블록으로 조건 1~5 각각을 PASS/FAIL과 증거(명령 출력 인용)로 보고한다. 30턴 안에 못 끝내면 남은 항목과 이유를 GOAL STATUS에 적고 멈춘다.
```

## G1 — 도달·스파이크·테이프(로컬)

선행: `.env`에 BINANCE_WEB3_API_KEY/SECRET, DATABASE_URL(로컬 Postgres), HOUSE_WALLET_PRIVATE_KEY(또는 주소만), REGION_TAG=kr-dev. 포털을 연 시각과 키 발급 시각을 dx/LOG.md에 사람이 먼저 적는다.

```
이자로 M0 스파이크를 끝낸다. CLAUDE.md와 docs/TASKS.md M0-03~M0-08, docs/DECISIONS.md §2를 읽는다. 완료 조건(모두 충족):
1) M0-03/04: `pnpm reach`가 이 머신에서 미서명 도달, 서명 호출(RWA 토큰 목록, Market 가격 배치)의 HTTP 상태·code·지연 ms를 출력하고 api_calls 테이블에 행이 생겼다(SELECT count 인용). 첫 서명 호출 성공 UTC 시각과 그 전에 겪은 오류 코드·원인이 dx/LOG.md에 기록되어 있다. 40304 등 지역 차단이 나오면 그 사실을 DECISIONS Q-01에 적고 나머지 조건은 가능한 범위에서 진행한다.
2) M0-05: RWA Data API(폴백: 공개 bapi list type 1/2/3)로 BSC 토큰 목록을 받아 NVDA, TSLA, AAPL, MSFT, QQQ의 발행사별 존재 매트릭스를 DECISIONS에 기록하고, 존재하는 각 토큰의 symbol/decimals를 온체인으로 검증했으며(bStocks는 uiMultiplier도), `pnpm registry`가 instruments 테이블을 채운다(행 수 인용). 코드에 주식 토큰 주소 상수가 없다.
3) M0-06: 최소 2개 인스트루먼트(NVDA의 bStocks·Ondo 우선)에 $1/$5/$50 견적을 요청해 expectedOut, priceImpact, route/vendor, 오류코드를 표로 dx/LOG.md에 기록했다. 정규장(13:30~20:00 UTC)이 아니면 장외 결과만 기록하고 DECISIONS Q-03에 "정규장 재측정 필요"라고 적는다. MIN_BUY_USD 잠정값과 기본 발행사를 DECISIONS D-09/D-10에 제안했다.
4) M0-07: DeFi API로 Venus 프로토콜 정보(보안점수·TVL·APY)와 USDT 투자 항목을 픽스처로 저장했고, vUSDT 주소를 온체인 symbol()/underlying()로 검증했으며, exchangeRateStored·이용률을 읽는 함수와 이자 계산 함수(packages/core/amounts.ts)가 테스트를 통과한다. DeFi API 예치·상환 콜데이터를 하우스 지갑 주소로 Transaction API 시뮬레이션까지 했고(브로드캐스트 금지) 결과를 픽스처와 DECISIONS Q-05에 기록했다.
5) M0-08 로컬: apps/agent의 테이프 잡이 10분마다 인스트루먼트별 온체인가·참조가·장 상태와 $5/$50/$500 견적을 tape_samples에 기록하며, 로컬에서 60분 이상 돌아 행이 쌓였다(두 시점의 count 인용). `pnpm tape:once`가 동작한다.
6) DECISIONS Q-03, Q-04, Q-05, Q-06, Q-12, Q-13, Q-14가 답 또는 "미해결: 이유"로 채워졌고, TASKS의 해당 티켓이 [x]/[~]와 증거로 갱신되었으며 커밋되어 git status가 clean이다.
제약: 브로드캐스트·자금 이동 금지(EXECUTION_MODE=simulate 유지), 키·주소는 로그와 픽스처에서 마스킹, 레이트리밋 준수(엔드포인트당 5/s). 매 턴 끝에 GOAL STATUS 블록으로 조건 1~6을 PASS/FAIL과 증거로 보고. 40턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```

## G2 — 테이프 호스트 배포

선행: Neon(프랑크푸르트) DATABASE_URL, Fly.io 또는 Render 앱 생성과 CLI 토큰, 호스트 env에 API 키·DATABASE_URL·REGION_TAG=fra 설정. 금지 리전: ams, lhr, nrt, sin.

```
이자로 테이프를 프랑크푸르트 호스트에서 가동한다. docs/SPEC.md §13, docs/TASKS.md M0-08을 읽는다. 완료 조건: 1) apps/agent가 Fly.io 또는 Render의 Frankfurt 리전에 배포되어 상태가 running이다(플랫폼 CLI 상태 출력 인용, 리전 명시). 2) 호스트에서 `pnpm reach`에 해당하는 도달 확인이 성공했고 api_calls에 REGION_TAG=fra 행이 있다(SELECT 인용). 3) tape_samples가 배포 후 30분 간격 두 시점에서 증가했다(count 두 개 인용). 4) 재시작 정책이 always이고 인스턴스가 1개이며, 워커가 죽었다 살아도 중복 기록이 없도록 잡에 락 또는 멱등키가 있다(코드 위치 인용). 5) DECISIONS D-06/Q-01에 최종 리전 결정과 근거를 기록했고 TASKS M0-08이 [x]로 갱신되어 커밋되었다. 제약: 자금 이동 없음, 시크릿은 플랫폼 env에만, 레포에 없음. 매 턴 끝에 GOAL STATUS 블록으로 조건 1~5를 PASS/FAIL과 증거로 보고. 15턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```

## G3 — M1 핵심 (simulate)

```
이자로 M1의 핵심을 EXECUTION_MODE=simulate로 완성한다. CLAUDE.md, docs/SPEC.md §4~§7·§11, docs/TASKS.md M1-01~M1-04·M1-07·M1-08을 읽는다. 완료 조건(모두 충족):
1) M1-01: Drizzle 스키마에 plans, cycles, receipts, holdings, instruments, api_calls, tape_samples, guardian_events, judge_codes, skill_tokens, spend_ledger가 있고 마이그레이션이 왕복(up/down)하며, 시드가 하우스 플랜 H-SAFE(NVDA, safe, $5, daily, regular_session)와 H-YIELD(DECISIONS D-10의 티커, yield, weekly)를 만든다.
2) M1-02: packages/core의 decideCycle이 순수 함수이며 WINDOW(정규장 판단, nextOpenTime+2분), BUDGET(이자 계산, 적립, 캡, MIN_BUY 누적), ASSET(기업행동 코드별 SKIPPED, 섹터 후보 대체, 발행사 폴백), PRICE(괴리 2%), QUOTE(가격영향 1% 초과 시 절반 재견적 2회)를 구현하고 CycleOutcome과 whyKey(docs/UX_COPY.md §4의 키만 사용)를 낸다. 테스트가 30개 이상이고 packages/core 커버리지가 100%다(커버리지 요약 인용).
3) M1-03/04: HouseWalletExecutor가 정확 금액 승인 콜데이터 → Transaction API 시뮬레이션 → (live일 때만) 서명·브로드캐스트 → 영수증 폴링 → 실수령량 파싱 순서로 구현되어 있고, `pnpm cycle:once --plan H-SAFE`가 simulate 모드에서 DUE→RECORD를 모두 거쳐 승인·스왑 시뮬레이션 성공과 금액·주식 수 환산을 출력하며 cycles 행을 만든다(출력 인용). --live 플래그는 금액·주소·시뮬 결과를 보여주고 y 입력을 요구하는 프롬프트가 있음을 코드로 보여준다.
4) M1-07: docs/SPEC.md §11의 코드 매핑이 구현되어 있고 코드별 단위 테스트가 있으며, 429는 Retry-After를 따르고, 미지 코드 최초 관측 시 dx 이벤트가 기록된다.
5) M1-08: 홀딩이 multiplier 스냅샷과 shares=tokens×multiplier를 유지하고 배수 변경 감지 테스트가 통과한다.
6) `pnpm typecheck && pnpm lint && pnpm test` exit 0, TASKS 갱신, 커밋, git status clean.
제약: 브로드캐스트·자금 이동 금지, 결정 경로에 LLM 호출 금지, 목업 금지(픽스처는 tests/·fixtures/에만), UX_COPY에 없는 문구 키 금지. 매 턴 끝에 GOAL STATUS 블록으로 조건 1~6을 PASS/FAIL과 증거로 보고. 40턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```

## G4 — 메인넷 첫 영수증 (사람 입회)

선행: 하우스 지갑에 USDT ≥ $80, BNB 가스 ≥ $5. 미국 정규장 시간(KST 22:30~05:00). 사람이 터미널 앞에 있어 `--live` 프롬프트에 `y`를 입력한다. `.env`의 EXECUTION_MODE는 그대로 simulate로 두고 `--live` 플래그로만 실행한다.

```
이자로의 첫 메인넷 영수증을 만든다. docs/TASKS.md M1-03, M1-05를 읽는다. 사람이 입회 중이며 모든 실제 지출은 `pnpm cycle:once ... --live` 프롬프트에서 사람이 y를 입력했을 때만 발생한다. 완료 조건: 1) 안전 모드: H-SAFE 플랜으로 $5 이하 매수 1건이 메인넷에서 확정되어 receipts에 swap(필요 시 approve) 행과 BscScan 링크가 있고 holdings에 주식 수가 반영되었으며 whyKey가 why.bought.regular다(tx 해시 인용). 2) 이자 모드: H-YIELD 플랜으로 DECISIONS D-10의 원금(≤ $50로 시작)을 Venus에 예치한 deposit 영수증, MIN_BUY_USD 이상을 상환한 redeem 영수증, 그 금액으로 매수한 swap 영수증이 있다. 이자가 MIN_BUY_USD에 못 미치면 적립 병행으로 체결하되 영수증 amounts에 interest와 contribution을 구분 기록한다. 3) 모든 승인은 정확 금액이었고(approve 영수증의 amount 인용) 브로드캐스트 경로(transaction_api 또는 rpc)가 receipts.broadcastVia에 기록되었다. 4) spend_ledger가 오늘 지출 합계를 정확히 반영한다(SELECT 인용). 5) 겪은 오류·지연·문서 불일치를 dx/LOG.md에 기록했고 TASKS M1-03·M1-05가 [x]로 갱신되어 커밋되었다. 제약: 1회 $25, 이 골 전체 $60 초과 금지. 캡 변경 금지. 프롬프트 없이 지출하는 코드 경로 추가 금지. 실패 시 같은 지출을 자동 재시도하지 않고 원인을 기록한 뒤 사람에게 묻는다. 매 턴 끝에 GOAL STATUS 블록으로 조건 1~5를 PASS/FAIL과 tx 해시로 보고. 15턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```

## G5 — 스케줄러와 하우스 플랜 가동

선행: G2 호스트, 하우스 지갑 잔고, 호스트 env에 HOUSE_WALLET_PRIVATE_KEY와 EXECUTION_MODE=live, 캡 값 확인.

```
이자로 워커가 호스트에서 하우스 플랜 2개를 자율 가동하게 한다. docs/SPEC.md §5, docs/TASKS.md M1-06·M1-09를 읽는다. 완료 조건: 1) 5분 틱이 plans.lock_until 락과 멱등키(planId:dueAt)로 중복 실행을 막는다는 테스트가 통과한다. 2) 장 마감 중 틱이 DEFERRED(market_closed) 사이클을 만들고 retryAt이 RWA nextOpenTime이며 nextDueAt이 nextOpenTime+2분으로 갱신된다(DB 행 인용). 3) 호스트에서 H-SAFE와 H-YIELD가 active이고 워커 로그에 두 플랜의 틱이 보인다(로그 인용). 4) FAILED 발생 시 텔레그램 운영 알림이 1회 전송되는 것을 테스트 메시지로 확인했다(또는 토큰이 없으면 로그 알림으로 대체하고 DECISIONS에 기록). 5) 배포 후 24시간 내 사이클 레코드가 정규장에 BOUGHT 또는 사유 있는 SKIPPED/DEFERRED로 쌓인다(count와 최근 3건의 whyKey 인용). 24시간을 기다릴 수 없으면 최근 2개 틱의 결과와 다음 예정 시각을 인용하고 TASKS M1-09를 [~]로 둔다. 6) TASKS M1-06 [x], 커밋, git status clean. 제약: 캡 변경 금지, 새 지출 경로 금지. 매 턴 끝에 GOAL STATUS 블록으로 조건 1~6을 PASS/FAIL과 증거로 보고. 20턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```

## G6 — 웹 제품 (Watch·Judge Mode·정지·위험 고지·i18n)

```
이자로 웹 제품의 핵심 화면을 완성한다. CLAUDE.md, docs/PLAN.md §5, docs/SPEC.md §8, docs/UX_COPY.md, docs/TASKS.md M2-01~M2-05를 읽는다. 완료 조건(모두 충족):
1) `/`(Watch): 하우스 플랜 카드 2개(원금·쌓인 이자·모은 주식 수·다음 매수), 영수증 피드(사유 한 줄+BscScan 링크), 장 상태 배지, 데이터 상태 LIVE/STALE/UNAVAILABLE, CTA 2개가 실데이터로 렌더된다. API 키가 없을 때도 페이지가 뜨고 UNAVAILABLE 사유를 보여준다.
2) `/judge`: 코드 입력 → 종목/섹터 → 모드(안전 기본, 이자 토글 시 위험 고지 동의) → 금액 → 미리보기(Transaction API 시뮬레이션을 UX_COPY judge.preview.line으로) → 실행 진행 3단계 → 영수증 → [플랜 멈추기]가 동작한다. 코드별 캡, 7일 자동 stop, 리셋이 구현되어 있다. Playwright e2e `pnpm e2e`가 simulate 모드에서 이 흐름을 끝까지 통과한다(출력 인용).
3) `/plans/[id]`: 타임라인, 한도 사용량, [멈추기]. 이자 모드 정지 시 전액 상환 단계가 시뮬레이션되어 표시된다.
4) `/risk`: UX_COPY §5 전문(KR/EN). 이자 모드 토글은 동의 없이는 켜지지 않는다.
5) 모든 문자열이 UX_COPY 키 기반이고 KR/EN 토글이 동작하며, `pnpm lint:copy`가 §6 금지어 0건을 출력한다. 375px 뷰포트 Playwright 스크린샷에서 가로 스크롤이 없다(document.scrollWidth<=375 assert 통과 인용).
6) `/api/judge/smoke`가 Web3 API 도달·RPC·DB·마지막 틱·하우스 잔고·마지막 영수증·테이프 최신 시각을 JSON으로 돌려주고 로컬에서 항목별 ok를 보여준다.
7) `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` exit 0, TASKS M2-01~05 [x], 커밋, git status clean.
제약: 목업 금지(e2e는 simulate 모드와 픽스처만), 첫 화면에 hex 주소·토큰 수량 노출 금지(주식 수와 달러로), 메타마스크류 지갑 연결 금지, 자금 이동 없음. 매 턴 끝에 GOAL STATUS 블록으로 조건 1~7을 PASS/FAIL과 증거로 보고. 40턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```

## G7 — 가디언·기업행동·/dx·모니터

선행: TELEGRAM_BOT_TOKEN/OPS_CHAT_ID, 업타임 모니터 계정(사람이 smoke URL 등록).

```
이자로의 가디언, 기업행동 처리, /dx 페이지, 모니터링을 완성한다. docs/PLAN.md §7, docs/SPEC.md §6·§10, docs/TASKS.md M2-06·M2-07·M2-11·M2-12를 읽는다. 완료 조건: 1) packages/core/guardian.ts가 PLAN §7의 규칙(프로토콜 일시중지, TVL 24h −30%, 이용률 95%, USDT<0.99 30분, 괴리 2%, 가격영향 1%, 한도, 종목 상태, AW 세션)을 GuardianInputs→GuardianAction[]으로 구현하고 규칙별 테스트가 통과한다. 전액 상환 액션은 Transaction API 시뮬레이션 성공 시에만 브로드캐스트하는 코드 경로를 보여준다. 2) 가디언 발동이 guardian_events에 기록되고 Watch와 플랜 상세에 UX_COPY 문구로 표시된다(수동 트리거 스크린샷 경로 인용). 3) RWA 종목 상태 ASSET_PAUSED/ASSET_LIMITED 픽스처로 SKIPPED(corporate_action)와 whyKey why.skipped.corporate_action.<reason>이 나오고, 섹터 플랜은 다음 후보로 대체되는 테스트가 통과한다. 4) `/dx`가 api_calls 기반 엔드포인트별 count·p50·p95·오류코드·리전 표와 tape_samples 기반 차트 3종(정규장 vs 장외 괴리, 규모별 가격영향, 발행사 비교)을 실데이터로 렌더하고 각 차트에 측정 방법 캡션이 있다. `pnpm dx:metrics`가 dx/metrics.md를 생성한다(첫 10줄 인용). 5) `/api/health`가 있고 smoke 실패 시 텔레그램 알림이 1회 전송됨을 테스트로 확인했다(토큰 없으면 로그 대체 후 DECISIONS 기록). 6) 테스트 exit 0, TASKS 갱신, 커밋, git status clean. 제약: 자금 이동 없음, 목업 금지. 매 턴 끝에 GOAL STATUS 블록으로 조건 1~6을 PASS/FAIL과 증거로 보고. 30턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```

## G8 — Skill API·Wallet Skill·Agent Studio(코드 부분)

선행: DECISIONS Q-07(baw의 RWA·Venus 지원)과 Q-09(bag 런타임) 답. 실제 baw 실행 테스트(M2-09의 [HUMAN] 부분)는 이 골 뒤에 사람이 함께 한다.

```
이자로의 Skill API와 Wallet Skill을 완성한다. docs/SPEC.md §8.2·§9, docs/TASKS.md M2-08~M2-10, docs/vendor/binance-skills-hub/skills/binance-web3/binance-agentic-wallet/SKILL.md의 형식을 읽는다. 완료 조건: 1) POST /api/plans(스킬 토큰 발급), POST /api/plans/:id/preview, GET /api/plans/:id/next, POST /api/plans/:id/report, POST /api/plans/:id/stop이 토큰 인증·레이트리밋·캡 검증과 함께 구현되고, /next 응답이 지금 할 일(none|deposit|redeem|buy|stop), 금액, 토큰 주소(레지스트리 출처 표기), baw 명령 파라미터(binanceChainId, fromToken, toToken, fromTokenQty 등), 사유 whyKey, 만료 시각을 담는다. OpenAPI 문서가 docs/api/openapi.yaml에 있고 통합 테스트가 픽스처로 통과한다. 2) skills/ijaro/SKILL.md가 Skills Hub 형식(frontmatter name/description/metadata, requires bins baw, 선행 스킬 binance-agentic-wallet 확인)을 따르고 references/plan.md, run.md, safety.md가 있다. safety.md는 위험 고지 낭독·동의, 상태 변경 전 미리보기·확인, 서버 제공 주소를 공개 RWA 목록 API로 교차검증, orderId≠체결(market-order list로 FINISHED 확인), 세션 만료 2시간 전 알림, 오류 원문 그대로 전달을 명시한다. 3) run.md의 절차가 /next → baw defi deposit|redeem 또는 market-order quote→swap → market-order list 확인 → /report 순서이며, 예시 대화가 KR/EN으로 있다. 4) `/skill` 페이지가 설치 한 줄(확정 경로), 3단계 안내, "서버는 결정만, 서명은 내 기기" 문구를 UX_COPY 키로 보여준다. 5) Agent Studio: DECISIONS Q-09가 go면 하우스 에이전트 신원 등록 스크립트와 등록 절차 문서를, no-go면 신원 등록만을 위한 스크립트와 문서를 docs/agent-studio.md에 남긴다(실제 등록 tx는 사람 확인 후). 6) 테스트 exit 0, TASKS M2-08 [x], M2-09·M2-10 [~](사람 부분 남김), 커밋, git status clean. 제약: 서버가 사용자 키·세션을 저장하는 코드 금지, 자금 이동 없음. 매 턴 끝에 GOAL STATUS 블록으로 조건 1~6을 PASS/FAIL과 증거로 보고. 25턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```

## G9 — M3 완성도 (README 심사 경로·보안·런북·장애 리허설·b402)

선행: 배포 URL(웹·워커), 영상 링크(없으면 자리표시 문구), 하우스 지갑 잔고(x402 호출 옵션 시).

```
이자로 M3를 끝낸다. docs/TASKS.md M3-01~M3-06, docs/DEMO.md §2, docs/SPEC.md §13·§14를 읽는다. 완료 조건: 1) README.md 상단이 DEMO.md §2 구조(한 문장, 라이브·영상·DX 링크, 3분 체험 절차, 하우스 실기록 표, 모듈 매트릭스, Agentic Wallet 설치 한 줄, 위험, 실행법, 라이선스)로 채워졌고 실기록 표는 `pnpm readme:receipts`가 DB에서 생성한다(표 첫 5행 인용). 2) 보안 점검: 시크릿 스캔(git 히스토리 포함) 0건, 무제한 approve 코드 0건(grep 인용), 모든 쓰기 라우트에 인증·레이트리밋·캡 검증 테스트, CSP·HSTS 헤더 확인, `pnpm audit --prod`에 high 이상 0건 또는 예외 사유 기록. 3) docs/RUNBOOK.md: 워커 재시작, DB 복구, 하우스 지갑 충전, 캡 변경 절차(사람 승인 필수), 심사 기간 일일 점검표(10/12~10/23). 4) 장애 리허설: Web3 API 차단·RPC 차단·워커 강제 종료 각각에서 UI가 STALE/UNAVAILABLE 사유를 보여주고 워커가 재기동 후 중복 없이 재개함을 로그로 증명. 5) b402(컷라인 6·7순위, 시간이 있을 때만): 유료 플랜 리포트 엔드포인트가 402→결제 검증→200 흐름을 픽스처로 통과하거나, 시간이 없으면 TASKS M3-01을 [-]로 표시하고 DECISIONS에 사유 기록. 6) JUDGING §4 자가채점표의 10/8 행 초안(에이전트 추정치, 사람이 확정)을 채웠고, 테스트 exit 0, 커밋, git status clean. 제약: 10/9 이후 배포 금지 규칙 준수, 캡 변경 금지, 자금 이동은 x402 호출 시 건당 0.2 U 이하·총 2 U 이하. 매 턴 끝에 GOAL STATUS 블록으로 조건 1~6을 PASS/FAIL과 증거로 보고. 25턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```

---

## 2. 사람이 골 사이에 하는 일 (요약)
- G0 뒤: API 키·로컬 Postgres·하우스 지갑 주소를 `.env`에. dx/LOG.md에 포털·키 발급 시각 기록.
- G1 뒤: 텔레그램 답변을 DECISIONS Q-02에 기록. Neon·Fly/Render 계정·env.
- G3 뒤: 하우스 지갑 충전. 정규장 시간에 G4 실행(입회).
- G5 뒤: 첫 자가채점(9/27 또는 10/4).
- G7 뒤: baw로 스킬 실제 실행(M2-09 [HUMAN]), Agent Studio 등록 확인, 업타임 모니터에 smoke URL 등록.
- G9 뒤: 영상 촬영·편집, DX 리포트 작성(사람), 제출.
