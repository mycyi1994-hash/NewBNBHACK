# LIVE_TEST — $1 실거래 시험 (DECISIONS D-21)

작성: 코딩 에이전트(9/27). 사람이 검토한다. 사람의 결정(9/27): 실거래는 $1 규모부터, 최소 매수 $0.25, 운영자 상환 `pnpm yield:redeem` 승인.

**목적.** 실제 돈이 움직이는 세 경로를 $1씩 한 번 확인한다: Venus 예치, 안전 모드 매수, Venus 상환. 이자로 사는 swap(GOALS G4 조건 2)은 원금을 늘린 뒤(REPLAN R1) 한다. 원금 $1의 이자는 하루 $0.0001이다.

## 0. 원칙

- **서명은 사람이 터미널에서 `y`를 칠 때만 한다.** live 명령은 대화형 터미널이 아니면 거부한다(`scripts/confirm.ts`). Claude(PC든 클라우드든)는 준비·확인·기록만 한다.
- **live 명령은 Fly 워커 머신 안에서** 실행한다: `fly ssh console -a ijaro-agent` → `cd /app`.
  - API 키를 워커와 같은 리전(fra)·IP에서 쓴다. 한국 PC에서 쓰면 다중 리전 동시 접속(40303) 위험이 있다(DECISIONS Q-01).
  - 워커 이미지에 스크립트와 tsx가 들어 있다(Dockerfile).
- **워커 자체는 `EXECUTION_MODE=simulate` 그대로 둔다**(fly.toml). live 명령 한 줄에만 `EXECUTION_MODE=live`를 붙인다. 워커는 일정대로 서명하지 않고, 서명자는 그 명령 하나뿐이다.
- 캡은 그대로다: 하우스 1회 $25, 일 $50, 최소 매수 $0.25(D-21), 원금 상한 $1,000. 이 시험의 총 지출은 $2 + 가스(수 센트)다.
- 실패한 지출은 자동으로 다시 하지 않는다. 원인을 적고 사람이 정한다.

## 1. 준비 (사람)

1. PR을 병합하고 워커를 배포한다.
   - `fly deploy -a ijaro-agent`
   - `fly logs -a ijaro-agent`에 `agent: configuration valid`, 그리고 `tick:` 줄이 보이면 된다.
   - 웹 배포는 선택이다(`/plans/H-SAFE` 화면 확인용).
2. Fly 시크릿 이름을 확인한다: `fly secrets list -a ijaro-agent`.
   - `MIN_BUY_USD`가 있으면 지우거나 `0.25`로 둔다. 코드 기본값이 이제 0.25다.
   - `EXECUTION_MODE`가 시크릿으로 `live`면 지운다(fly.toml의 simulate가 적용된다).
3. 하우스 지갑(BSC)을 충전한다: **USDT 3~5, BNB 0.005.**
   - 최소는 USDT 2(매수 $1 + 예치 $1)와 BNB 0.001이다. 잔고 상한은 $300(SPEC §14).
   - 주소는 지갑을 만든 운영자가 안다(로그·화면에서는 가려진다).
4. 매수 단계(5–6)는 **미국 정규장에만** 한다. 9/28(월) 22:30 KST 개장 → **22:32 이후**, 05:00 KST 마감 전. 예치·상환은 아무 때나 된다.

## 2. 절차 (`fly ssh console -a ijaro-agent` 안, `cd /app`)

| # | 명령 | 기대 결과 | 멈춤 |
| --- | --- | --- | --- |
| 0 | `pnpm live:check` | 충전 전에는 `house`만 ✗(H-SAFE가 $5면 `H-SAFE`도 ✗) | `config`·`outbox`·`guardian`·`registry`·`web3api`·`rpc chain` ✗ |
| 1 | `pnpm plan:set --plan H-SAFE --contribution 1 --per-buy 1 --daily 1` | `changed H-SAFE (safe, paused): $5 daily … → $1 daily, per buy ≤ $1, per day ≤ $1 …` | `refused` |
| 2 | (충전 후) `pnpm live:check` | `GO` | `NO-GO` |
| 3 | `pnpm yield:deposit --plan H-YIELD --usd 1` | 시뮬레이션 JSON. 승인 시뮬 SUCCESS. 예치 시뮬 FAILED는 예상된 결과다(시뮬레이션에는 정확 승인이 아직 체인에 없다). | 빌드 오류, 승인 FAILED |
| 4 | `EXECUTION_MODE=live pnpm yield:deposit --plan H-YIELD --usd 1 --live` → `y` | `approve`·`deposit` BscScan 링크, `deposited 1 USDT → … vTokens` | `not deposited …`. `pending: <tx>`가 나오면 채굴 뒤 `pnpm yield:deposit --plan H-YIELD --record <tx>` |
| 5 | (정규장) `pnpm cycle:once --plan H-SAFE` | 시뮬레이션: NVDA bStocks $1 견적, 승인 시뮬 SUCCESS | DEFERRED·SKIPPED(사유를 읽는다), FAILED |
| 6 | `EXECUTION_MODE=live pnpm cycle:once --plan H-SAFE --live` → `y` | BOUGHT, 승인(정확히 $1)·swap 링크, 사유 `why.bought.regular` | FAILED, `review` |
| 7 | `pnpm yield:redeem --plan H-YIELD` | 미리보기: `amountUsd` ≈ 1, `redeem.status` SUCCESS | `refused`, 시뮬 FAILED |
| 8 | `EXECUTION_MODE=live pnpm yield:redeem --plan H-YIELD --live` → `y` | `redeemed: https://bscscan.com/tx/…`, `H-YIELD is paused (operator_redeem)`, 원금 0 | `not redeemed`. `pending: <tx>`가 나오면 채굴 뒤 `pnpm yield:redeem --plan H-YIELD --record <tx>` |
| 9 | `pnpm receipts:table`, `pnpm plan:status`, `pnpm live:check` | 영수증 5건(approve·deposit·approve·swap·redeem), `outbox settled` | 예상 밖 영수증·잔고 |

**끝나면** H-SAFE는 $1로 멈춰 있고(paused), H-YIELD는 원금 0으로 멈춰 있다(`operator_redeem`).

다음 단계는 사람이 정한다:
- H-SAFE를 D-10의 일 $5로 되돌린다: `pnpm plan:set --plan H-SAFE --contribution 5 --per-buy 5 --daily 5`.
- H-YIELD 원금을 정한다(R1, 9/30까지): `pnpm yield:deposit --plan H-YIELD --usd <n>`.
- 워커를 live로 두고 두 플랜을 켠다(G5): `plan:status --activate`.

## 3. 멈춤 조건 (하나라도 → 멈추고, 같은 지출을 다시 하지 않는다)

- `FAILED`인데 `fundsMoved: gas_only`이거나, 사이클이 `review`에 들어갔다.
- 응답에 지역·컴플라이언스 코드(40301~40304)가 보인다.
- 하우스 잔고가 단계당 $1 + 가스보다 많이 줄었다.
- 3분 넘게 채굴되지 않은 tx가 있다. 새 서명은 막힌다(`outbox`). 워커가 틱마다(simulate 모드에서도) 체인과 대조하고, 채굴되면 효과(원금·vToken·보유량·원장)까지 한 번만 반영한다(DECISIONS D-23). `live:check`의 `outbox`가 settled가 되면 `plan:status`로 반영을 확인하고, 반영이 안 됐을 때만 `--record`한다. 30분이 지나도 안 풀리면 텔레그램 알림이 오고 RUNBOOK §3.4대로 사람이 판단한다.

멈추면: `pnpm live:check` 출력, 명령 출력, UTC 시각, tx 해시를 `dx/LOG.md`(DX_PROTOCOL 형식)에 적고 사람이 결정한다.

## 4. 기록

- 단계마다 UTC 시각과 tx 해시를 남긴다.
- 놀란 점(문서와 다른 응답, 느린 확정, 이상한 오류)은 같은 날 `dx/LOG.md`에 적는다.
- 끝나면 `docs/TASKS.md`에 증거를 붙인다: M1-03(매수 영수증), M1-05(예치·상환 영수증).

## 5. `/goal` 지시서 (PC Claude용, G4a)

선행(사람): §1의 1–3 완료, 사람이 터미널 앞에 있음. Claude는 `--live` 명령을 실행하지 않는다(TTY가 없어 거부된다). 사람에게 명령을 알려 주고, 사람이 붙여 준 출력을 확인한다.

```
이자로의 $1 실거래 시험을 끝낸다. docs/LIVE_TEST.md와 DECISIONS D-21을 읽는다. 사람이 입회 중이고, 모든 실제 지출은 사람이 Fly 워커 머신(fly ssh console -a ijaro-agent, cd /app)에서 `EXECUTION_MODE=live pnpm … --live`를 실행하고 y를 입력할 때만 일어난다. 너는 읽기 전용 확인만 직접 실행한다: `fly ssh console -a ijaro-agent -C "sh -c 'cd /app && pnpm live:check'"`, 시뮬레이션 명령(--live 없음), `plan:set`(H-SAFE가 paused일 때만), receipts:table, plan:status. 완료 조건: 1) 첫 live 단계 전 live:check가 GO였다(출력 인용). 2) H-YIELD $1 예치: deposit 영수증 tx 해시와 approve 금액이 정확히 1 USDT(1000000000000000000)였음을 인용. 3) H-SAFE $1 매수가 정규장에 BOUGHT: swap 영수증 해시, approve 금액 = 1 USDT, 사유 why.bought.regular 인용. 4) H-YIELD 상환: redeem 영수증 해시, 플랜 paused(operator_redeem), 원금 0 인용. 5) 끝난 뒤 live:check의 outbox가 settled이고, 겪은 오류·지연·문서 불일치를 dx/LOG.md에 적었고, TASKS M1-03·M1-05에 증거를 붙여 커밋했다. 제약: 이 골 전체 지출 $2 + 가스 이하, 캡 변경 금지, 새 지출 경로 금지, 한국 PC에서 Binance Web3 API 호출 금지(Q-01), 실패한 지출 자동 재시도 금지 — 원인을 기록하고 사람에게 묻는다. 매 턴 끝에 GOAL STATUS 블록으로 조건 1~5를 PASS/FAIL과 증거(tx 해시·출력 인용)로 보고. 15턴 안에 못 끝내면 남은 항목과 이유를 적고 멈춘다.
```
