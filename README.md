# 이자로 (Ijaro) — Interest buys the stock. Principal stays.

> BNB Hack: Tokenized Stocks Edition 출품 프로젝트. **상태: M0 부트스트랩(G0) 완료 — 워크스페이스·설정 검증·Web3 API 클라이언트(오프라인)·공식 문서 대조. 다음은 G1(API 키 필요).**
> 빌드 2026-09-23 → 내부 제출 10-09 → 마감 10-11 12:00 UTC → 심사 10-12~23.

원금은 USDT 이자 통장(Venus)에 그대로 두고, **이자(또는 정한 적립금)로만** 미국 주식 토큰(bStocks / Ondo, BSC 메인넷)을
**미국 정규장에만** 자동 매수하는 에이전트. 안전 모드(적립만)가 기본값이고, 모든 매수는 Transaction API로 미리 돌려본 뒤
영수증과 이유 한 줄을 남긴다. 심사위원은 코드 하나로 3분 안에 완주한다.

## 심사위원께
제출 시 이 섹션이 `docs/DEMO.md` §2의 구조로 채워진다: 라이브 링크 · 영상 · 3분 체험 · 실기록 표 · 모듈 매트릭스 · DX 리포트.

## 문서 지도
| 문서 | 용도 | 먼저 읽을 사람 |
| --- | --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | 코딩 에이전트 운영 규칙 | Opus 5.5 |
| [`docs/JUDGING.md`](docs/JUDGING.md) | 공식 채점 기준(원문)과 기능 매핑, 자가채점 | 전원 |
| [`docs/PLAN.md`](docs/PLAN.md) | 마스터 기획서: 목표, 사용자, 범위, 흐름, 일정, 컷라인, 3인 검토 회의록 | 전원 |
| [`docs/SPEC.md`](docs/SPEC.md) | 기술 명세: 모듈, 데이터 모델, 에이전트 루프, 가디언, 에러 분류, 보안 | 엔지니어 |
| [`docs/TASKS.md`](docs/TASKS.md) | 티켓 백로그(M0~M4), 수용 기준 | 엔지니어 |
| [`docs/GOALS.md`](docs/GOALS.md) | `/goal`에 붙여넣는 지시서 10개(G0~G9), 순서와 선행 조건 | 운영자·Opus 5.5 |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | 잠긴 결정, 1일차에 닫을 질문 | 전원 |
| [`docs/DX_PROTOCOL.md`](docs/DX_PROTOCOL.md) | 개발자 경험 리포트(25%) 증거 체계 | 전원 |
| [`docs/UX_COPY.md`](docs/UX_COPY.md) | 화면 문구 KR/EN, 위험 고지, 금지어 | 제품·엔지니어 |
| [`docs/DEMO.md`](docs/DEMO.md) | 4분 영상 스크립트, README 심사 경로 | 제품 |
| [`dx/LOG.md`](dx/LOG.md) | 개발자 경험 로그(시간순) | 전원 |

## 시작하기 (Opus 5.5)
1. 레포 루트에서 Claude Code를 auto 모드로 연다.
2. `docs/GOALS.md`의 **G0** 블록을 `/goal ` 뒤에 붙여넣는다. 골이 끝나면 선행 조건을 채우고 G1, G2… 순서로.
3. 골 없이 수동으로 할 때는 `CLAUDE.md`를 읽고 `docs/TASKS.md`의 M0-01부터.

## 라이선스
제출 전 확정(MIT 권장).
