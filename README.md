# Yieldvest — Interest becomes ownership.

**프론트 디자인 / Frontend design:** 승인된 BNB 스타일 UI와 Yieldvest 로고(원본: [frontend-preview](frontend-preview/README.md), 인수인계: [FRONTEND_HANDOFF.md](FRONTEND_HANDOFF.md))를 실제 웹 `apps/web`에 옮겼습니다(DECISIONS D-25). 탭 4개 — 한눈에(Overview) · 이자(Earn) · 투자(Invest = 심사위원 체험) · 내역(Activity) — 가 모두 서버·체인의 실제 값만 보여 줍니다. `frontend-preview/`는 예시 데이터로 도는 디자인 원본으로 남습니다.

> **EN, one line:** an agent that keeps your principal in a USDT savings pool (Venus on BNB Smart Chain) and buys tokenized US stocks (bStocks / Ondo) with the interest — or a fixed amount in safe mode — **only during the US regular session**, under hard caps, with an on-chain receipt and a one-sentence reason for every action.

BNB Hack: Tokenized Stocks Edition 출품작. 빌드 9/23 → 내부 제출 10/9 → 마감 10/11 12:00 UTC.

**Live:** 배포 후 기입 · **Video:** M4-02 · **DX report:** M4-01 · **Judge Mode:** 제출 폼의 심사위원 코드

## 60초 요약

원금은 USDT 이자 통장(Venus)에 그대로 두고, **이자(또는 정한 적립금)로만** 미국 주식 조각을 **미국 정규장에만** 삽니다. 안전 모드(적립만)가 기본값입니다. 결정은 모델이 아니라 결정 규칙(`packages/core` `decideCycle`, 커버리지 100%)이 하고, 모든 매수는 Binance Web3 **Transaction API로 미리 돌려본 뒤에만** 서명합니다. 매 사이클은 영수증(BscScan)과 이유 한 줄(`why.*`)을 남기고, 못 사는 이유(장 마감·가격 괴리·한도·지킴이)도 그대로 보여 줍니다.

## 3분 체험 (Judge Mode, `/invest` — 예전 주소 `/judge`도 여기로 연결)

**체험하기(Try it)** 또는 투자(Invest) 탭 → 코드 → 종목(NVDA 등) → 적립만 · $5 · 정규장 → **미리 돌려보기**(워커가 블록체인에서 시뮬레이션) → **지금 사기** → 영수증 또는 "예약됨"(장이 닫혀 있으면 다음 개장 +2분에 자동 매수) → **플랜 멈추기**.
코드 1개 = 최대 $5, 돈은 Yieldvest의 하우스 지갑에서 나갑니다. 플랜은 7일 뒤 자동 종료.

## Yieldvest가 직접 돌린 기록

`pnpm receipts:table`이 DB에서 이 표를 만듭니다(시각 · 플랜 · 행동 · 결과/사유 · 영수증). **현재 영수증 0개** — 하우스 지갑 충전과 live 전환은 사람의 돈 결정(REPLAN R1–R4)을 기다립니다. 받는 대로 여기에 붙입니다.

## 모듈 매트릭스 (PLAN §6.1 + 코드 기준 상태)

| 모듈 | Yieldvest에서 쓰는 곳 | 상태 |
| --- | --- | --- |
| RWA Data API | 토큰 목록(주소·배수·상태 코드·다음 개장), RWA 가격 — 레지스트리·테이프·결정 | 사용 중(프랑크푸르트 워커, 테이프 10분) |
| 공개 bapi RWA Dynamic V2 (Web3 API 밖) | 미국 주가(`stockInfo.price`, 장외 null) — 괴리 계산·테이프. 키 없는 공개 엔드포인트, 문서는 Skills Hub `binance-tokenized-securities-info`뿐 | 사용 중(`apps/agent/src/stock-price.ts`) |
| Market API | USDT 가격(디페그 지킴이) | 코드 완료 |
| Trading API | 견적(가격영향·경로), 정확 금액 승인 calldata, 스왑 calldata | 견적 사용 중(테이프), 서명 경로는 live 대기 |
| Transaction API | 모든 서명 전 시뮬레이션, 가스 한도 추정, 브로드캐스트(RPC 대체 경로) | 코드 완료, live 대기. 상태 조회(transaction-detail)는 쓰지 않음: 영수증은 BSC RPC로 확인 |
| DeFi API | Venus USDT 투자·APY(`apyDisplay`), TVL·보안 점수(지킴이·위험 고지), 예치·상환 calldata | 코드 완료 |
| Wallet API | — (하우스 잔고는 BSC RPC로 읽음) | 미사용 |
| Agentic Wallet / Wallet Skills | `skills/yieldvest`: 서버는 `/next`로 `baw` 명령만, 서명은 사용자 기기, `/report`는 체인 확인 | 코드·문서 완료, 실제 실행 데모는 사람(M2-09) |
| b402 Payments | — | 미구현(M3-01, 컷 후보) |
| BNB Agent Studio | — | 미구현(M2-10) |
| BSC | viem 읽기·쓰기, 영수증 Transfer 로그로 수량 확정, Venus vToken | 사용 중 |

## 내 AI 비서로 쓰기 (Agentic Wallet, 모드 C)

```bash
git clone --depth 1 https://github.com/mycyi1994-hash/NewBNBHACK yieldvest-src \
  && mkdir -p ~/.claude/skills && cp -r yieldvest-src/skills/yieldvest ~/.claude/skills/
export YIELDVEST_URL=<사이트 주소>
```

그다음 "Yieldvest 시작해줘". 필요: `binance-agentic-wallet` 스킬과 `baw`. 서버는 결정만 하고(키·세션을 저장하지 않음), 모든 거래는 사용자 확인 뒤 사용자 지갑이 서명합니다. API 계약: `/api/openapi`(OpenAPI 3.1).

## 구조

```
apps/web        Next.js: 화면(한눈에·이자·투자(체험)·내역·플랜·비서·데이터·위험)과 API. 서명하지 않고 Web3 API도 부르지 않음
apps/agent      워커(유일한 서명자): 테이프 10분, 틱 5분(아웃박스·대기 사이클·지킴이·잡·기한 된 플랜), 웹 잡 3초
packages/core   결정 규칙 decideCycle, 지킴이 규칙, 금액·주 수 계산, NYSE 달력 — 순수 함수, 커버리지 100%
packages/binance  Web3 API 클라이언트: HMAC 서명, 레이트리밋, 오류 분류표(SPEC §11), 호출 계측(api_calls)
packages/chain  viem: ERC-20·Venus·영수증 로그
packages/db     Drizzle 스키마·마이그레이션(되돌리기 포함)·지출 원장(advisory lock)·아웃박스·잡
skills/yieldvest    Wallet Skill (SKILL.md + references)
```

## 안전 장치 (요약 — 자세히는 [`docs/SECURITY.md`](docs/SECURITY.md))

- 하드 캡은 env 한 곳에서 읽고 코드가 강제: 1회 $25 · 하루 $50(하우스), 심사위원 코드당 $5. 지출은 원장에 잠금 아래 예약.
- 정확 금액 승인만, 서명 전 calldata 해독·검증(스왑은 승인한 라우터만 호출), **시뮬레이션 SUCCESS 없이는 서명 없음**, 3분 안에 영수증이 없으면 아웃박스 PENDING으로 새 서명 차단. 체인에서 확정된 효과는 영수증과 한 트랜잭션으로 정확히 한 번 기록 — 결과가 불분명하면 추측하지 않고 사람에게 묻는다([DECISIONS D-23](docs/DECISIONS.md)).
- 지킴이: Venus 일시정지·TVL 24시간 −30%·이용률 95%·USDT 0.99 30분 → 매수 중단/전액 상환(live에서 시뮬레이션 통과 시에만).
- 모든 데이터 블록은 실시간 / n분 전 / 불러올 수 없음(이유) 중 하나. 없는 숫자를 만들지 않습니다.
- CSP(요청마다 nonce), HSTS, 화면 375px 가로 스크롤 없음·KO/EN(`pnpm ui:check`).

## 위험

[`/risk`](apps/web/app/risk/page.tsx) — Yieldvest는 은행이 아닙니다. 원금을 잃을 수 있습니다(Venus 해킹, USDT 디페그). 이자율은 매일 바뀌고 주가는 오르내립니다. 안전 모드(적립만)가 기본값입니다.

## 실행

```bash
pnpm i
cp .env.example .env          # EXECUTION_MODE=simulate(기본)는 아무것도 서명하지 않음. 웹은 키 없이 뜨고,
                              # 워커의 테이프·결정에는 Binance Web3 API 키가 필요(Q-01: 한 리전에서만 사용)
pnpm db:migrate && pnpm db:seed   # DATABASE_URL 필요(Postgres)
pnpm dev                      # 웹 + 워커. 데이터가 없으면 화면은 "불러올 수 없어요(이유)"로 정직하게 뜹니다
pnpm typecheck && pnpm lint && pnpm test   # 테스트 DB: YIELDVEST_TEST_DATABASE_URL
pnpm smoke --url http://localhost:3000     # /api/judge/smoke
```

운영 절차는 [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## 문서 지도

| 문서 | 용도 |
| --- | --- |
| [`docs/JUDGING.md`](docs/JUDGING.md) | 공식 채점 기준(원문)과 기능 매핑 |
| [`docs/PLAN.md`](docs/PLAN.md) | 기획: 목표·사용자·범위·흐름·일정·컷라인 |
| [`docs/SPEC.md`](docs/SPEC.md) | 기술 명세: 모듈·데이터 모델·에이전트 루프·지킴이·오류 분류 |
| [`docs/TASKS.md`](docs/TASKS.md) | 티켓과 증거 |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | 잠긴 결정·열린 질문 |
| [`docs/DX_PROTOCOL.md`](docs/DX_PROTOCOL.md) · [`dx/LOG.md`](dx/LOG.md) | 개발자 경험 증거 |
| [`docs/UX_COPY.md`](docs/UX_COPY.md) | 화면 문구 KR/EN(§7은 사람 확정 전 초안) |
| [`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | 보안 점검·운영 |
| [`CLAUDE.md`](CLAUDE.md) · [`docs/GOALS.md`](docs/GOALS.md) | 코딩 에이전트 운영 규칙·골 |

## 라이선스

제출 전 확정(MIT 권장).
