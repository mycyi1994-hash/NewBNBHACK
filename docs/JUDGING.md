# JUDGING.md — 채점 기준과 우리의 정조준

작성: 박지우 (해커톤 전략·DX 수석). 검토: 강민서, 이도현.
이 문서는 모든 기능 결정의 상위 문서다. 기능이 아래 표의 어느 행에 점수를 내는지 적지 못하면 만들지 않는다.

## 1. 공식 채점 기준 (원문 그대로)

> Scores are pooled after each judge has worked through every project on their own.

| Criterion | Weight | What we look at |
| --- | --- | --- |
| Technical implementation | 30% | Does it run, and how deep does the integration go? Modules used, error handling, how it holds up. |
| Creativity & originality | 25% | Were the APIs used in ways nobody expected? Does this already exist five times over? |
| Developer Experience Report | 25% | Specific, actionable, honest, no fluff. Includes the AI stack section. |
| Product quality & UX | 20% | Is it usable by the people it is for? Would it bring non-crypto-native users on-chain? |

특별상 (본상과 중복 수상 가능, 별도 신청 없음):
- **Best Use of Agentic Wallet / Wallet Skills** — $2,000 — "deepest, most credible use of the AI execution layer". 조직위 표현: Agentic Wallet은 "Optional, **heavily weighted in scoring**".
- **Best Use of BNB Agent Studio** — $2,000 — "agent identity, autonomous runtime, and self-funding via x402".

본상: 1위 $6,000 · 2위 $4,000 · 3위 $3,000 · 4위 $2,000 · 5위 $1,000.

트랙 규칙 (원문 요지):
- bStocks, Ondo, xStocks 중 **하나 이상이 제출물의 중심**이어야 한다.
- 교차자산(주식 레그 + 크립토/스테이블코인 레그) 허용. **현물만**, 무기한 선물 금지.
- **BSC 메인넷만.** 빌드 중에는 Transaction API로 드라이런, 데모는 소액 실거래.
- 심사 기간(10/12~10/23) 내내 레포·데모·배포 링크가 접근 가능해야 한다.
- 제한 지역: 미국, 캐나다, 네덜란드, 이란, 쿠바, 북한, 크림, 도네츠크, 루한스크, **영국, 일본**. (한국은 목록에 없음.)

## 2. 심사위원의 15분 (우리가 가정하는 심사 행동)

| 분 | 행동 | 우리가 준비하는 것 |
| --- | --- | --- |
| 0–1 | README 첫 화면 | 한 문장 정의, 라이브 링크, 영상, Judge Mode 안내, 모듈 매트릭스 |
| 1–5 | 영상(≤4분) | `docs/DEMO.md` 스크립트 그대로 |
| 5–8 | 배포 링크에서 직접 완주 | Judge Mode: 코드 입력 → 플랜 → 시뮬레이션 → 실행 → 영수증, 3분 |
| 8–10 | 코드 훑기 | `packages/binance` 에러 매핑, `packages/core` 테스트, 하드코딩·목업 없음 |
| 10–13 | DX 리포트 | 타임스탬프·URL·에러코드·지연 수치·요청 목록 |
| 13–15 | 점수 입력 | 아래 루브릭에서 우리가 9~10점 칸에 있게 |

## 3. 기능 → 기준 매핑 (이 표에 없는 기능은 만들지 않는다)

| 기능 | 기술 30 | 창의 25 | DX 25 | UX 20 | AW 특별상 | Studio 특별상 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| 하우스 에이전트가 메인넷에서 실제로 매수·영수증 | ● | | ● | | | ● |
| 이자 모드: 예치 → 이자 → 상환 → 매수 (DeFi API + Trading API) | ● | ● | ● | | | |
| 안전 모드(적립) 기본값 + 위험 고지 | | | | ● | | |
| 정규장 창구 매수 + 장외 보류 사유 표시 | ● | ● | ● | ● | | |
| 기업행동 코드 처리 (실적발표 제한, 배당·분할 일시정지) | ● | ● | ● | | | |
| 토큰 수가 아닌 주식 수 표시 (multiplier 반영) | | ● | | ● | | |
| 가디언(프로토콜 일시중지·TVL·이용률·디페그·가격 괴리) | ● | ● | | ● | | |
| Judge Mode 3분 완주 | ● | | | ● | | |
| Transaction API 시뮬레이션을 사람 말로 보여주는 확인 화면 | ● | | | ● | | |
| Wallet Skill (사용자의 AI 비서가 baw로 실행) | ● | | ● | | ● | |
| Skill용 결정 API (`/next`): 서버는 결정만, 서명은 사용자 쪽 | ● | | | | ● | |
| Agent Studio 신원(ERC-8004) + 런타임/MCP 등록 | ● | | ● | | | ● |
| b402: 유료 플랜 리포트 엔드포인트 + 공식 Stock Analyze Agent x402 호출 | ● | ● | ● | | | ● |
| /dx 페이지: 엔드포인트별 p50/p95, 에러코드, 장외 테이프 | | | ● | | | |
| 에러 분류표와 LIVE/STALE/UNAVAILABLE 상태 | ● | | ● | ● | | |
| `/api/judge/smoke` 한 번 호출로 전 구성요소 점검 | ● | | | | | |
| KR/EN, 모바일, 크립토 용어 치환 | | | | ● | | |

## 4. 자가 채점 루브릭 (매주 일요일 갱신: 9/27, 10/4, 10/8 최종)

점수 앵커. 심사위원이 되어 우리 제출물을 채점한다. 7점 미만 항목은 다음 주 최우선.

**기술 30%**
- 10: 메인넷 영수증 다수, 모듈 7개 이상이 제품 필요에 의해 사용, 알려진 함정(장외 RFQ 거부·견적 만료·주문ID≠체결·승인·펜딩) 처리 코드 존재, 심사위원이 클릭해도 안 깨짐, `/smoke` 녹색.
- 7: 실거래 있으나 모듈 4~5개, 에러 처리 일부.
- 4: 시뮬레이션·데모 모드 위주.

**창의성 25%**
- 10: 아이디어 목록에 없음, 모듈 조합이 예상 밖이면서 제품이 그 조합을 필요로 함, 토큰화 주식 고유 문제(장외·기업행동·배수)를 다룸.
- 7: 목록 아이디어에 뚜렷한 변주.
- 4: 목록 그대로.

**DX 25%**
- 10: 온보딩 시간 측정치, 페이지 URL과 위치가 적힌 문서 오류, 에러코드별 재현, p50/p95 지연, AI 스택(baw·Skills·bag) 실사용 소감, 발행사별 유동성·슬리피지·장외 행동 수치, 우선순위 매긴 요청 목록. 사람이 쓴 문장.
- 7: 구체적이나 수치 부족.
- 4: 일반론.

**UX 20%**
- 10: 누구를 위한지 3초 안에 보임, 크립토 용어 없음, Binance 지갑으로 시작, 폰에서 됨, 위험이 숨겨지지 않음, 3분 완주.
- 7: 깔끔하나 용어 노출.
- 4: 대시보드.

| 날짜 | 기술 | 창의 | DX | UX | 총점(가중) | 최우선 항목 |
| --- | --- | --- | --- | --- | --- | --- |
| 9/27 | | | | | | |
| 10/4 | | | | | | |
| 10/8 | | | | | | |

## 5. 감점 요인 (하나라도 있으면 그 주 최우선 제거)

- 배포가 죽어 있음 / 첫 화면에 에러
- 목업 데이터가 라이브처럼 보임
- "원금 보장", "안전한 수익" 류 문구
- 메타마스크 요구, 첫 화면에 hex 주소
- 무제한 approve
- DX 리포트에 AI 문체·숫자 없음
- 아이디어 목록 항목과 구분이 안 됨
- 지갑 세션·개인키를 서버가 보관

## 6. 제출물 체크리스트 (공식 "What to Submit")

- [ ] 작동하는 프로젝트: Binance Web3 API 모듈 1개 이상 (우리는 7개 이상) + Agentic Wallet/Wallet Skills
- [ ] 공개 레포 (라이선스 포함)
- [ ] 데모 영상 ≤ 4분 (강력 권장)
- [ ] 배포 링크 또는 심사위원이 따라 할 수 있는 지침
- [ ] Developer Experience Report (공식 템플릿 폼 제출) — 7항목: Onboarding / Documentation issues / API pitfalls / AI stack feedback / Tokenized-stock specifics / Redesign suggestions / Requested capabilities
- [ ] 참가 등록 완료 (무료 API·레이트리밋 상향)
- [ ] 심사 기간 내내 라이브 유지 계획 (`docs/PLAN.md` §8 운영 런북)
