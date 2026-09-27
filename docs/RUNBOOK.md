# RUNBOOK — 운영 절차 (M3-06, SPEC §13)

작성: 코딩 에이전트(9/26). 명령은 레포 루트 기준이다. 비밀값은 여기에 쓰지 않는다 — 플랫폼 env에만 있다.

## 0. 구성 한눈에

| 부분 | 어디 | 하는 일 | 비밀 |
| --- | --- | --- | --- |
| 워커 `apps/agent` | Fly.io `yieldvest-agent` (fra, 머신 1대, restart always) | 테이프 10분, 스케줄러 틱 5분(아웃박스 정산·가디언·잡·기한 된 플랜), 웹 잡 3초, 레지스트리 24시간, Venus 확인 6시간. **유일한 서명자**. 아웃박스 정산(체인 대조 → 기다리던 사이클 마무리 → 사이클 밖 tx 반영)은 **모드와 상관없이 매 틱** 돈다(DECISIONS D-23) | Binance Web3 API 키·시크릿, 하우스 키, DB URL, 텔레그램 |
| 웹 `apps/web` | Vercel(fra1) 예정 | 화면·API. 서명하지 않고 Web3 API를 부르지 않는다(워커가 쓴 DB + 공개 BSC RPC만) | DB URL, `SESSION_SECRET`, `JUDGE_CODES` |
| DB | Neon Postgres | 모든 상태(플랜·사이클·원장·아웃박스·잡·테이프·api_calls) | — |
| 모니터 | GitHub Actions `monitor.yml` | 30분마다 `pnpm smoke --alert` (기본 브랜치에서만, `YIELDVEST_APP_URL` 변수 있을 때만) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPS_CHAT_ID` |

실행 모드: `EXECUTION_MODE=simulate`(기본)는 아무것도 서명하지 않는다. `live`는 **active 플랜만** 캡 안에서 서명한다. 하우스 플랜은 `paused(awaiting_funding)`로 시드되고 사람이 켠다.

## 1. 매일 점검 (심사 기간 10/12~10/23, KST 09:00·21:00)

1. `pnpm smoke --url https://<웹>` → 전부 green인지. degraded면 어떤 항목인지 적는다.
2. 워커 로그: `fly logs -a yieldvest-agent --no-tail | tail -100`(`--no-tail` 없이는 끝나지 않는다) — `tick: <시각> <모드> cycles [...]` 줄이 **매 틱(5분)** 찍히는지(조용한 틱도 한 줄), `tape:`가 10분 간격인지, `FAILED`·`errors:`가 없는지. smoke `worker`가 degraded면 마지막 틱에 오류가 있었다는 뜻이다(공개 응답에는 개수와 출처만 — 원문은 이 로그에).
3. `pnpm plan:status` — 하우스 플랜 상태·다음 시각이 예상대로인지.
4. 하우스 잔고(smoke `house`): USDT가 하루 캡($50) × 남은 일수보다 적으면 §5.
5. `/dx`에 새 발견(dx_events)이 있으면 `pnpm dx:events` 출력을 `dx/LOG.md`에 옮긴다.
6. 이상은 `dx/LOG.md`에 UTC 시각과 함께 적는다(CLAUDE.md 판정 기간 규칙). 배포는 핫픽스만, 배포 뒤 `pnpm smoke`.

## 2. 멈추기 (무엇이든 이상할 때 먼저)

- 전체 서명 중지: Fly에서 `EXECUTION_MODE=simulate`로 바꾸고 재시작 — `fly secrets set EXECUTION_MODE=simulate -a yieldvest-agent`(재시작 포함). 이후 워커는 서명하지 않는다.
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
- `fly machine restart <id> -a yieldvest-agent`. 재시작은 안전하다: 테이프 슬롯은 한 번만 기록(`tape_samples_slot_uq`), 사이클은 (plan, due_at) 유일, 아웃박스는 체인과 대조, 이전 워커가 `running`으로 남긴 잡은 부팅 때 실패로 닫는다(다시 돌리지 않는다 — 이미 브로드캐스트했을 수 있고, 그 결과는 대기 사이클 처리가 체인에서 마무리한다; 화면에는 "플랜 기록을 보세요"가 뜬다).
- 확인: 로그 `agent: configuration valid`, `agent: scheduler registered`, 다음 `tick:` 줄. 부팅 때 모든 RPC가 체인 ID 56인지 확인한다: 다른 체인이면 워커가 시작하지 않고, 응답이 없는 RPC는 `agent: … did not answer eth_chainId` 경고만 남긴다.
- 죽은 워커가 `running`으로 남긴 사이클은 그 플랜의 다음 락 보유자가 정리한다: 서명한 게 있으면 체인에서 마무리(대기 사이클), 없으면 FAILED `INTERRUPTED`로 닫고 캡 예약을 풀고 다음 시각으로 넘긴다(DECISIONS D-23).

### 3.4 아웃박스 PENDING이 풀리지 않음
- 증상: 틱이 `outbox_busy`, 새 사이클 서명 없음. 30분이 지나면 텔레그램 `[yieldvest] outbox 0x…: … New signing stays blocked until a human checks it on BscScan`.
- 확인: `select tx_hash, kind, status, broadcast_via, nonce, created_at, error from tx_outbox where status in ('SIGNED','PENDING');`, BscScan에서 해시와 하우스 주소의 해당 nonce 조회.
- 워커가 스스로 하는 일: 채굴되면 CONFIRMED로 바꾸고 효과(보유량·원장·원금)를 영수증과 함께 한 번만 반영한다. 노드가 모르는 바이트는 같은 바이트로 재전송한다 — 단 **10분 넘은 스왑은 재전송하지 않는다**(견적이 낡았다). 브로드캐스트 결과가 불분명하면(`broadcast_via='unknown'`) 나갔을 수 있는 것으로 보고 PENDING으로 둔다. 추측으로 FAILED를 찍지 않는다.
- 사람이 하는 일(알림을 받았을 때만, 원인 확인 후):
  - (a) BscScan에 **우리 해시가 채굴돼 있다**: 아무것도 하지 않는다 — 노드가 따라오면 워커가 확정·반영한다. 계속 안 되면 `BSC_RPC_URL`을 다른 RPC로 바꾼다(§3.2).
  - (b) 그 nonce를 **다른 tx가 썼다**(같은 키가 다른 곳에서 쓰였다는 뜻 — 키 유출 가능성, §2 전체 중지 먼저): `update tx_outbox set status='FAILED', error='nonce used by another transaction (human, <날짜>)' where tx_hash='0x…';` → 다음 틱이 사이클을 FAILED로 닫고 예약을 푼다.
  - (c) **아무 데도 없는 낡은 스왑**(nonce 미사용): 보내지 않기로 하면 `update tx_outbox set status='FAILED', broadcast_via=null, error='dropped; not sent again (human, <날짜>)' where tx_hash='0x…';` — `broadcast_via=null`이어야 그 nonce를 다음 tx가 다시 쓸 수 있다.
  - 어느 경우든 `dx/LOG.md`에 UTC 시각·해시·판단 근거를 적는다(자금 판단 = 사람).

### 3.5 DB 장애·복구
- 웹은 DB가 없어도 죽지 않는다: 화면은 "불러올 수 없어요 (database unavailable)", API는 503 UNAVAILABLE, smoke는 red 503(리허설: `apps/web/test/read.test.ts` "answers 503 UNAVAILABLE, not a 500 page…", 로컬 `next start`를 닫힌 포트 DB로 띄워 7개 화면 200 + 이유 표시 확인).
- 복구: Neon 콘솔에서 시점 복구(branch restore) → `DATABASE_URL` 교체 → `pnpm db:migrate`(advisory lock, 여러 번 실행해도 안전) → 워커 재시작.
- 롤백: `pnpm db:rollback <tag> --yes`(가장 최근 마이그레이션만, `packages/db/drizzle-down/`).

### 3.6 가디언 발동
- 텔레그램 `[yieldvest] guardian …`. `redeem_all`(Venus 일시중지·TVL −30%)은 이자 플랜을 멈추고(포지션이 남은 **정지된** 하우스·심사위원 플랜도 포함, 상태는 그대로) live에서만 시뮬레이션 통과 후 상환한다. 그 플랜의 사이클이 락을 쥐고 있거나 이전 입금·상환이 아직 정산되지 않았으면 이번 틱엔 상환하지 않는다(`…:redeem_locked`/`…:redeem_pending`, 규칙이 계속 발동하는 동안 다음 틱에 다시). 상환이 실패하면 플랜은 멈춘 채 알림 — 사람이 결정한다.
- TVL·USDT 가격을 못 읽은 틱(0·빈 값 포함)은 "정상"이 아니라 "데이터 없음"이다: 그 규칙은 발동도 해제도 하지 않는다.
- 스킬 플랜의 원금은 사용자 지갑에 있어 워커가 절대 상환하지 않는다(`redeemPlanPosition` 소유자 확인, 테스트 "never redeems a skill plan's position from the house wallet").
- 해제는 자동(입력을 다시 읽어 정상이면). 해제 뒤 멈춘 하우스 플랜은 사람이 `plan:status --activate`로 켠다.

## 4. 캡(한도) 바꾸기 — 사람의 명시적 "yes"가 먼저 (CLAUDE.md 규칙 5)

1. 대화나 이슈에 새 값과 이유를 적고 승인받는다.
2. 워커와 웹 양쪽 env를 같은 값으로: `HOUSE_MAX_PER_TX_USD`, `SANDBOX_MAX_PER_PLAN_USD`, `DAILY_SPEND_CAP_USD`, `MIN_BUY_USD`, `MAX_PRINCIPAL_USD`. 설정은 부팅 때 검증된다: 최소 ≤ 1회 ≤ 일일, 샌드박스 캡 ≤ 1회 캡(심사위원 플랜도 하우스 지갑이 서명한다), 각 값은 **평범한 십진수만**(소수 6자리까지, 0 초과 1,000,000 이하, `MIN_BUY_USD` ≥ 0.01). `25.`·`.5`·`+5`·`1e3`·`0x19`는 부팅을 멈춘다 — 9/27 감사 이전에 넣은 Fly·Vercel 값이 이 형식인지 배포 전에 확인한다(`fly secrets list`는 값을 보여 주지 않으니 넣은 사람이 확인). 빈 값으로 둔 캡은 `.env`의 값을 가리지 않는다.
3. 재시작 → `pnpm smoke` → 첫 사이클 로그 확인.

## 5. 하우스 지갑 충전

- 주소는 지갑을 만든 운영자가 알고 있다(로그·화면·알림에서는 마스킹된다). smoke `house`는 잔고만 보여준다. 키는 Fly 시크릿에만 있다. 워커는 주소를 DB `worker_status.house`에 적는다(공개 API로는 나가지 않는다) — 웹이 이 주소로 스킬 플랜을 만들거나 하우스가 보낸 tx를 신고하는 것을 거부하는 데 쓴다.
- 잔고 상한 $300(SPEC §14). BNB는 수수료용 소량.
- 이자 플랜 원금: `pnpm yield:deposit --plan H-YIELD --usd <금액>`(시뮬레이션 먼저, live는 `y` 입력 필요, `MAX_PRINCIPAL_USD` 이하).
- 원금 되찾기: `pnpm yield:redeem --plan H-YIELD`(미리보기) → `EXECUTION_MODE=live pnpm yield:redeem --plan H-YIELD --live`(`y`). 포지션 전체를 하우스로 되찾고 플랜을 멈춘다(`operator_redeem`). 스킬 플랜은 거부한다(D-19·D-21).
- live 명령은 워커 머신 안에서 실행한다(`fly ssh console -a yieldvest-agent`, `cd /app`). 워커는 simulate로 두고 명령 한 줄에만 `EXECUTION_MODE=live`를 붙인다. simulate 워커도 매 틱 아웃박스를 정산하므로, 명령이 기다리다 포기한 tx도 채굴되면 워커가 반영한다(`--record`는 예비 수단). live 명령은 모든 RPC가 체인 56인지 먼저 확인하고, 아웃박스가 정산되고 플랜 락을 잡았을 때만 서명한다. 순서와 멈춤 조건: `docs/LIVE_TEST.md`.

## 6. 배포

- 워커: `fly deploy -a yieldvest-agent`(Dockerfile은 `.env*`가 있으면 빌드 실패). 배포 뒤 로그로 설정 검증 줄 확인.
- 웹: Vercel(`apps/web`, 빌드 `pnpm --filter @yieldvest/web build`). env: `DATABASE_URL`, `SESSION_SECRET`(32자 이상), `JUDGE_CODES`, `NEXT_PUBLIC_APP_URL`. 웹에는 하우스 키·API 키를 두지 않는다.
- 배포 뒤 반드시: `pnpm smoke --url https://<웹>`, `pnpm ui:check --url https://<웹>`(375/1440px, KO/EN, CSP 위반 없음).
- 10/9 이후: 핫픽스만.

## 6.1 이름 변경 이전 (D-24, 한 번만)

레포는 9/27에 Yieldvest로 바뀌었다(Fly 앱 `ijaro-agent` → `yieldvest-agent`). Fly는 앱 이름을 바꿀 수 없으니 새 앱을 만들어 옮긴다. **서명자는 언제나 하나** — 옛 워커를 먼저 멈춘다.

1. 옛 워커 멈추기: `fly scale count 0 -a ijaro-agent` → `fly status -a ijaro-agent`에 실행 중인 머신이 없는지 확인. 아웃박스·사이클은 DB에 있으니 새 워커가 그대로 이어받는다(대기 중인 tx는 새 워커의 첫 틱이 정산).
2. 새 앱: `fly apps create yieldvest-agent`(리전은 `fly.toml`의 `fra` — Web3 API 키는 fra에서만, DECISIONS Q-01).
3. 시크릿 다시 넣기: `fly secrets list -a ijaro-agent`로 **이름만** 확인(값은 볼 수 없다) → 비밀번호 관리자에 있는 값으로 `fly secrets import -a yieldvest-agent < 파일`(파일은 레포 밖, 끝나면 삭제). `EXECUTION_MODE`는 `simulate`로 시작. 캡 값은 §4의 새 형식인지 확인.
4. 배포: `fly deploy -a yieldvest-agent` → `fly logs -a yieldvest-agent --no-tail | tail -50`에서 `agent: configuration valid`, RPC 체인 확인 경고 없음, `tick:` 줄.
5. `pnpm smoke --url https://<웹>` → `worker` green. 하루 정상 동작을 본 뒤 `fly apps destroy ijaro-agent`.
6. GitHub: 저장소 변수 `IJARO_APP_URL`을 `YIELDVEST_APP_URL`로 새로 만든다(모니터는 새 이름만 읽는다). 로컬 개발 셸의 `IJARO_TEST_DATABASE_URL`도 `YIELDVEST_TEST_DATABASE_URL`로.
7. 웹(Vercel)은 env 이름이 그대로다. 쿠키 이름이 바뀌어 기존 심사위원 세션은 다시 코드를 넣어야 하고, `ijr_` 스킬 토큰은 더 이상 받지 않는다(새 토큰은 `yv_…`) — 스킬 사용자는 `YIELDVEST_URL`과 `~/.config/yieldvest`를 쓴다.

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
