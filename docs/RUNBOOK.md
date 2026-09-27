# RUNBOOK — 운영 절차 (M3-06, SPEC §13)

작성: 코딩 에이전트(9/26). 명령은 레포 루트 기준이다. 비밀값은 여기에 쓰지 않는다 — 플랫폼 env에만 있다.

## 0. 구성 한눈에

| 부분 | 어디 | 하는 일 | 비밀 |
| --- | --- | --- | --- |
| 워커 `apps/agent` | Fly.io `ijaro-agent` (fra, 머신 1대, restart always) | 테이프 10분, 스케줄러 틱 5분(아웃박스·대기 사이클·가디언·잡·기한 된 플랜), 웹 잡 3초, 레지스트리 24시간, Venus 확인 6시간. **유일한 서명자** | Binance Web3 API 키·시크릿, 하우스 키, DB URL, 텔레그램 |
| 웹 `apps/web` | Vercel(fra1) 예정 | 화면·API. 서명하지 않고 Web3 API를 부르지 않는다(워커가 쓴 DB + 공개 BSC RPC만) | DB URL, `SESSION_SECRET`, `JUDGE_CODES` |
| DB | Neon Postgres | 모든 상태(플랜·사이클·원장·아웃박스·잡·테이프·api_calls) | — |
| 모니터 | GitHub Actions `monitor.yml` | 30분마다 `pnpm smoke --alert` (기본 브랜치에서만, `IJARO_APP_URL` 변수 있을 때만) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPS_CHAT_ID` |

실행 모드: `EXECUTION_MODE=simulate`(기본)는 아무것도 서명하지 않는다. `live`는 **active 플랜만** 캡 안에서 서명한다. 하우스 플랜은 `paused(awaiting_funding)`로 시드되고 사람이 켠다.

## 1. 매일 점검 (심사 기간 10/12~10/23, KST 09:00·21:00)

1. `pnpm smoke --url https://<웹>` → 전부 green인지. degraded면 어떤 항목인지 적는다.
2. 워커 로그: `fly logs -a ijaro-agent | tail -100` — `tick:`·`tape:`·`jobs:` 줄이 5·10분 간격으로 있는지, `FAILED`·`errors:`가 없는지.
3. `pnpm plan:status` — 하우스 플랜 상태·다음 시각이 예상대로인지.
4. 하우스 잔고(smoke `house`): USDT가 하루 캡($50) × 남은 일수보다 적으면 §5.
5. `/dx`에 새 발견(dx_events)이 있으면 `pnpm dx:events` 출력을 `dx/LOG.md`에 옮긴다.
6. 이상은 `dx/LOG.md`에 UTC 시각과 함께 적는다(CLAUDE.md 판정 기간 규칙). 배포는 핫픽스만, 배포 뒤 `pnpm smoke`.

## 2. 멈추기 (무엇이든 이상할 때 먼저)

- 전체 서명 중지: Fly에서 `EXECUTION_MODE=simulate`로 바꾸고 재시작 — `fly secrets set EXECUTION_MODE=simulate -a ijaro-agent`(재시작 포함). 이후 워커는 서명하지 않는다.
- 플랜 하나: `pnpm plan:status --plan <id> --pause --reason ops_hold`.
- 심사위원 코드 하나 막기: 웹 env `JUDGE_CODES`에서 빼고 재배포 → 웹이 첫 코드 확인 때 표를 맞춘다(없는 코드는 비활성, 해시만 저장; 목록이 비어 있으면 아무것도 바꾸지 않음). `pnpm db:seed`도 같은 동기화를 한다.
- 스킬 토큰 폐기: DB `skill_tokens.revoked_at` 설정(`revokeSkillToken`) — 스킬 플랜은 사용자 지갑이 서명하므로 우리 쪽 자금은 움직이지 않는다.

## 3. 장애별 절차

### 3.1 Binance Web3 API 오류·다운
- 증상: smoke `web3api` degraded/red, 테이프 `quote errors` 급증, 틱 `errors:`.
- 확인: `pnpm dx:metrics`(엔드포인트별 코드 분포), `/dx`. 403/40304는 지역·컴플라이언스(Q-01: 키는 fra에서만), 429는 레이트리밋(클라이언트가 Retry-After로 1회 재시도).
- 영향: 결정은 멈춘다(견적·시뮬레이션 없이는 서명하지 않는다). 화면은 테이프가 STALE/UNAVAILABLE로 표시된다 — 정상 동작.
- 조치: 기다린다. 30분 넘으면 텔레그램 알림 확인, `dx/LOG.md`에 기록(요청 id 포함).

### 3.2 BSC RPC 다운
- 증상: smoke `rpc` red(메시지는 `rpc unreachable`만 — 원문은 웹 로그), 워커 영수증 대기.
- 조치: `BSC_RPC_URL`/`BSC_RPC_URL_FALLBACK`을 다른 공개 RPC로 바꾸고 재시작. 브로드캐스트 뒤 영수증이 3분 안에 안 오면 아웃박스 행은 PENDING으로 남고 새 서명이 막힌다(§3.4).

### 3.3 워커 재시작·크래시
- `fly machine restart <id> -a ijaro-agent`. 재시작은 안전하다: 테이프 슬롯은 한 번만 기록(`tape_samples_slot_uq`), 사이클은 (plan, due_at) 유일, 아웃박스는 체인과 대조, 이전 워커가 `running`으로 남긴 잡은 부팅 때 실패로 닫는다(다시 돌리지 않는다 — 이미 브로드캐스트했을 수 있고, 그 결과는 대기 사이클 처리가 체인에서 마무리한다; 화면에는 "플랜 기록을 보세요"가 뜬다).
- 확인: 로그 `agent: configuration valid`, `agent: scheduler registered`, 다음 `tick:` 줄.

### 3.4 아웃박스 PENDING이 풀리지 않음
- 증상: 틱이 `outbox_busy`, 새 사이클 서명 없음.
- 확인: `select tx_hash, status, nonce, created_at from tx_outbox where status in ('SIGNED','PENDING');`, BscScan에서 해시 조회.
- 조치: 워커는 매 틱 같은 바이트를 재전송하고 채굴되면 CONFIRMED로 바꾼다. 노드에서 사라졌고 nonce가 이미 다른 tx로 쓰였다면 사람이 원인을 확인한 뒤에만 행을 정리한다(자금 판단 = 사람).

### 3.5 DB 장애·복구
- 웹은 DB가 없어도 죽지 않는다: 화면은 "불러올 수 없어요 (database unavailable)", API는 503 UNAVAILABLE, smoke는 red 503(리허설: `apps/web/test/read.test.ts` "answers 503 UNAVAILABLE, not a 500 page…", 로컬 `next start`를 닫힌 포트 DB로 띄워 7개 화면 200 + 이유 표시 확인).
- 복구: Neon 콘솔에서 시점 복구(branch restore) → `DATABASE_URL` 교체 → `pnpm db:migrate`(advisory lock, 여러 번 실행해도 안전) → 워커 재시작.
- 롤백: `pnpm db:rollback <tag> --yes`(가장 최근 마이그레이션만, `packages/db/drizzle-down/`).

### 3.6 가디언 발동
- 텔레그램 `[ijaro] guardian …`. `redeem_all`(Venus 일시중지·TVL −30%)은 이자 플랜을 멈추고 live에서만 시뮬레이션 통과 후 상환한다. 상환이 실패하면 플랜은 멈춘 채 알림 — 사람이 결정한다.
- 스킬 플랜의 원금은 사용자 지갑에 있어 워커가 절대 상환하지 않는다(`redeemPlanPosition` 소유자 확인, 테스트 "never redeems a skill plan's position from the house wallet").
- 해제는 자동(입력을 다시 읽어 정상이면). 해제 뒤 멈춘 하우스 플랜은 사람이 `plan:status --activate`로 켠다.

## 4. 캡(한도) 바꾸기 — 사람의 명시적 "yes"가 먼저 (CLAUDE.md 규칙 5)

1. 대화나 이슈에 새 값과 이유를 적고 승인받는다.
2. 워커와 웹 양쪽 env를 같은 값으로: `HOUSE_MAX_PER_TX_USD`, `SANDBOX_MAX_PER_PLAN_USD`, `DAILY_SPEND_CAP_USD`, `MIN_BUY_USD`, `MAX_PRINCIPAL_USD`. 설정은 부팅 때 검증된다(최소 ≤ 1회 ≤ 일일).
3. 재시작 → `pnpm smoke` → 첫 사이클 로그 확인.

## 5. 하우스 지갑 충전

- 주소는 지갑을 만든 운영자가 알고 있다(로그·화면·알림에서는 마스킹된다). smoke `house`는 잔고만 보여준다. 키는 Fly 시크릿에만 있다.
- 잔고 상한 $300(SPEC §14). BNB는 수수료용 소량.
- 이자 플랜 원금: `pnpm yield:deposit --plan H-YIELD --usd <금액>`(시뮬레이션 먼저, live는 `y` 입력 필요, `MAX_PRINCIPAL_USD` 이하).
- 원금 되찾기: `pnpm yield:redeem --plan H-YIELD`(미리보기) → `EXECUTION_MODE=live pnpm yield:redeem --plan H-YIELD --live`(`y`). 포지션 전체를 하우스로 되찾고 플랜을 멈춘다(`operator_redeem`). 스킬 플랜은 거부한다(D-19·D-21).
- live 명령은 워커 머신 안에서 실행한다(`fly ssh console -a ijaro-agent`, `cd /app`). 워커는 simulate로 두고 명령 한 줄에만 `EXECUTION_MODE=live`를 붙인다. 순서와 멈춤 조건: `docs/LIVE_TEST.md`.

## 6. 배포

- 워커: `fly deploy -a ijaro-agent`(Dockerfile은 `.env*`가 있으면 빌드 실패). 배포 뒤 로그로 설정 검증 줄 확인.
- 웹: Vercel(`apps/web`, 빌드 `pnpm --filter @ijaro/web build`). env: `DATABASE_URL`, `SESSION_SECRET`(32자 이상), `JUDGE_CODES`, `NEXT_PUBLIC_APP_URL`. 웹에는 하우스 키·API 키를 두지 않는다.
- 배포 뒤 반드시: `pnpm smoke --url https://<웹>`, `pnpm ui:check --url https://<웹>`(375/1440px, KO/EN, CSP 위반 없음).
- 10/9 이후: 핫픽스만.

## 7. 명령 모음

| 명령 | 용도 |
| --- | --- |
| `pnpm smoke [--url] [--strict] [--alert]` | 심사 의존 항목 한 번에 확인 |
| `pnpm ui:check [--url] [--out dir]` | 화면 7개 × KO/EN × 375/1440px, 가로 스크롤·페이지 오류·CSP 위반 |
| `pnpm plan:status [--plan id --activate/--pause]` | 플랜 목록·켜기·끄기 |
| `pnpm plan:set --plan <id> [--contribution] [--per-buy] [--daily] [--cadence] [--window]` | 하우스 플랜 금액·주기를 캡 안에서 바꾼다(켜진 플랜은 `y`) |
| `pnpm live:check [--usd 1]` | 실거래 전 점검(읽기 전용, Web3 API 호출 없음) → GO / NO-GO |
| `pnpm cycle:once --plan <id> [--live]` | 사이클 1회(시뮬레이션 먼저, live는 `y`) |
| `pnpm yield:deposit --plan <id> --usd <n>` | 이자 플랜 원금 예치 |
| `pnpm yield:redeem --plan <id> [--live] \| --record <tx>` | 이자 플랜 포지션 전체 상환(미리보기 먼저, live는 `y`) |
| `pnpm dx:metrics` · `pnpm dx:events` | DX 수치·새 발견 |
| `pnpm receipts:table` | README 영수증 표 |
| `pnpm db:migrate` · `pnpm db:seed` · `pnpm db:rollback <tag> --yes` | DB |
| `pnpm alert:test` | 텔레그램 알림 1회 시험 |
