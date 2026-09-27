# SECURITY — 보안 점검 (M3-05, SPEC §14)

작성: 코딩 에이전트(9/26). 사실과 증거만 적었다. 사람이 검토한다.

## 누가 무엇을 서명하나

- **워커(Fly, fra)만 서명한다.** 하우스 키는 워커 env에만 있다(`HOUSE_WALLET_PRIVATE_KEY`, 웹에는 없음). 서명 전: 정확한 금액의 승인만(무제한 승인 거부), 스왑 calldata 해독·검증(보낸 사람=하우스, value 0, 승인 대상=spender, **호출 대상=승인한 라우터** — 9/27 추가 `SWAP_TARGET_MISMATCH`), Transaction API 시뮬레이션 SUCCESS, 가스 상한, 25초 넘은 견적은 다시 받음(SPEC §5.8, `apps/agent/src/executor/*`). 부팅과 live 명령 시작 때 모든 RPC가 체인 ID 56인지 확인한다(`assertBscChain`).
- **돈 기록은 영수증과 함께 한 번만.** 입금·상환·스왑의 효과는 확정되는 순간 플랜 행을 잠그고(`SELECT … FOR UPDATE`) 영수증을 먼저 넣는 한 트랜잭션으로 반영한다 — 같은 해시는 두 번 반영되지 않고(소문자 한 가지 표기, CHECK), 동시 쓰기도 덮어쓰지 않는다(`packages/db/src/record.ts`, DECISIONS D-23). 결과가 불분명한 브로드캐스트는 "안 보냄"으로 치지 않고 PENDING으로 두며, 추측으로 FAILED를 찍지 않는다(RUNBOOK §3.4).
- **웹은 서명하지 않고 Binance Web3 API도 부르지 않는다.** 워커가 기록한 DB와 공개 BSC RPC만 읽고, 실행은 `jobs`로 넘긴다.
- **스킬 플랜(모드 C)은 사용자 지갑이 서명한다.** 서버는 `baw` 명령(argv)만 주고 calldata·서명·세션을 만들지 않는다. `/report`는 체인에서 확인된 것만 기록한다(채굴·성공·플랜 지갑 발신·Transfer 로그). 9/27 추가: 하우스 아웃박스가 서명한 해시와 하우스 지갑을 쓰는 플랜은 거부, 플랜 생성 전에 채굴된 tx는 거부, 해시는 소문자 한 표기, 스왑 신고는 영수증·사이클·원장·보유량·이자 차감을 한 트랜잭션으로. `/next`의 argv에 들어가는 Venus id는 `^[A-Za-z0-9_-]{1,128}$`만.
- 스킬 플랜의 Venus 원금은 사용자 지갑에 있다: 워커는 정지 잡이나 가디언 `redeem_all`에서 스킬 플랜을 **상환하지 않는다**(`redeemPlanPosition` 소유자 확인). 이 확인 전에는 스킬 플랜의 보고된 vToken 수만큼 하우스 지갑에서 상환하는 경로가 있었다 — 9/26 수정, 테스트 "never redeems a skill plan's position from the house wallet"(수정 전 실패 확인). 워커는 스킬 플랜의 `run`·`preview` 잡도 거부한다.

## 한도(캡)

- 캡은 env에서 `packages/config` 한 곳에서만 읽는다. 다른 소스에 캡 변수 이름이 나오면 테스트가 실패하고(`packages/config/src/index.test.ts`, 9/27부터 apps·packages·scripts·skills·.github 전체), `process.env`를 우회하는 방법(`globalThis.process`, `node:process`의 `env` import 등)은 lint가 막는다. 부팅 때 검증: 최소 매수 ≤ 1회 ≤ 일일, 샌드박스 캡 ≤ 하우스 1회 캡, 평범한 십진수만(지수·16진·부호 거부).
- 지출은 `spend_ledger`에 advisory lock 아래 한 트랜잭션으로 예약한다(동시 사이클이 캡을 함께 넘지 못함 — 잠금을 빼면 실패하는 테스트). 하우스 일일 합계는 하우스·심사위원 플랜만 센다(스킬 플랜은 사용자 지갑 — 9/26 수정, 캡 값 변경 없음).
- 심사위원 코드 1개 = 샌드박스 캡($5) 총액 — 9/27부터 **지출과 이자 플랜 원금을 합해서**(`judgeExposureUsd`), 코드의 다른 플랜에 정산 중인 tx가 있으면 새 입금을 거부. 심사위원 플랜의 1회 지출은 샌드박스 캡과 하우스 1회 캡 중 작은 값. 7일 뒤 자동 종료(원금은 락을 잡고 상환). 스킬 플랜 1회 한도 ≤ 하우스 1회 캡, 일 ≥ 1회.

## 인증·세션·레이트리밋

- 심사위원 코드: SHA-256만 저장, 쿠키 `yieldvest_judge`는 HMAC-SHA256 서명(코드 해시 + 만료), HttpOnly, SameSite=Lax, HTTPS면 Secure, 7일. `SESSION_SECRET` 32자 이상, 없으면 세션 기능이 꺼진다(503). 9/27부터 `JUDGE_CODES`에서 뺀 코드는 쿠키가 남아 있어도 즉시 거부되고(웹 `activeJudgeOf`), 워커도 그 코드의 플랜을 돌리지 않는다(`code_disabled`).
- 스킬 토큰 `yv_…`: 한 번만 보여주고 해시만 저장, 플랜 소유 확인(`ownedPlan`).
- 레이트리밋: 코드 시도 IP당 분 10회, 스킬 플랜 생성 IP당 시간 5개, `/next`·`/report`는 **인증 뒤** 토큰·플랜당 분 30·20회(남이 주인의 몫을 쓰지 못함) + 인증 전 IP당 분 120·60회(인스턴스 메모리, 키가 넘치면 오래 쉰 키부터 지움). 지속 한도(코드당 시간 5플랜, 지갑당 열린 5플랜 — 세는 것과 쓰는 것을 한 advisory lock 아래서, 플랜당 10분 10잡 — 정지는 예외)는 Postgres. IP는 Vercel이 넣는 `x-real-ip`.
- CSRF: 쓰기 요청의 쿠키는 SameSite=Lax라 다른 사이트의 POST에 붙지 않는다. 본문이 있는 요청은 `application/json`만 받는다(415) — 다른 사이트의 폼은 preflight 없이 이 형식을 보낼 수 없다. 본문은 16 KB에서 읽기를 멈춘다(413). 스킬 경로는 Bearer 헤더.

## HTTP 보안 헤더

- `apps/web/proxy.ts`: 요청마다 새 nonce의 CSP — `default-src 'self'`, `script-src 'self' 'nonce-…' 'strict-dynamic'`(인라인 스크립트 금지), `style-src 'self' 'nonce-…'`, `style-src-attr 'unsafe-inline'`(진행 막대의 style 속성만), `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, HTTPS면 `upgrade-insecure-requests`.
- `apps/web/next.config.ts`: HSTS(2년, includeSubDomains, preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`(카메라·마이크·위치·결제 끔), `X-Powered-By` 없음.
- 확인(로컬 `next start`): 응답 헤더에 위 값, 홈 HTML의 `<script>` 7개 모두 nonce 보유, `pnpm ui:check`(Chromium, 7화면 × KO/EN × 375/1440px)에서 콘솔 오류·CSP 위반 0.

## 오류가 새지 않게

- 공개 응답에는 원문 오류를 싣지 않는다(호스트·포트, 키가 든 RPC URL이 섞일 수 있음): 화면은 "불러올 수 없어요 (database unavailable)", API는 503 `{"state":"UNAVAILABLE","reason":"database unavailable"}`, smoke는 `rpc unreachable`/`database unreachable`. 원문은 서버 로그에만. 테스트: 응답 본문에 호스트(`127.0.0.1`)가 없음을 확인.
- 9/27 추가: 실패한 잡(`GET /api/jobs/:id`)은 워커가 호출자용으로 쓴 거절 사유(`PublicError`)만 그대로, 그 밖의 오류는 "the worker could not finish this job"으로 보인다. smoke의 워커 항목은 오류 개수와 출처(settle·guardian·cycle·job)만 보이고 오류가 있으면 degraded. 텔레그램 알림은 URL의 호스트만 남긴다(경로·쿼리의 키 제거).
- 로그·픽스처·알림에서 키와 하우스 주소를 가린다(`maskSensitive`, `houseRedactions`, 알림 `redact`). 16진 값은 대소문자·0x 유무와 상관없이 가린다(9/27). Binance 클라이언트는 리다이렉트를 따라가지 않는다(API 키가 다른 호스트로 가지 않게).

## 시크릿 스캔 (9/26, 전체 git 이력)

- 64자리 16진수: 테스트용 공개 키(Hardhat/Anvil 기본 계정 #0, 널리 알려진 값)뿐.
- `*_KEY=`/`*_SECRET=` 형태: 서명 테스트 벡터의 가짜 값(`vector-api-key`)과 웹 테스트의 세션 시크릿뿐.
- Neon URL: 설정 테스트의 가짜 예시(`npg_AbC123@ep-cool-name-…`)뿐. `yv_` 토큰·텔레그램 토큰·PEM 키: 없음.
- 추적 파일: `.env.example`(값 없는 틀)만. `.gitignore`: `.env*`(예외 `.env.example`), `*.pem`, `*.key`, `.studio/`, `.baw/`, 벤더 문서. 워커 Docker 빌드는 `.env*`가 있으면 실패한다.

## 의존성 감사

- `pnpm audit --prod`: **No known vulnerabilities found.**
- `pnpm audit`(개발 의존성 포함): moderate 1건 — `esbuild ≤ 0.24.2`(GHSA-67mh-4wv8-2f99, esbuild **개발 서버**의 CORS 문제) — 경로 `drizzle-kit > @esbuild-kit/… > esbuild`. 마이그레이션 생성 도구 전용이고 esbuild serve를 쓰지 않는다. 강제 업그레이드는 drizzle-kit을 깨뜨릴 수 있어 두었다 → [HUMAN] 수용 여부 확인.

## 남은 위험 (9/27 전수 감사 뒤)

- **스킬 플랜 지갑의 소유 증명이 없다.** 누구나 아무 지갑 주소로 스킬 플랜을 만들 수 있다. 막아 둔 것: 하우스 지갑·하우스가 보낸 tx, 플랜 생성 전 tx, 같은 해시 두 번. 남은 것: (a) 남의 지갑으로 플랜을 만들어 그 지갑의 **이후** 스왑을 먼저 신고하면 피드에 그 플랜의 매수로 보이고, 진짜 주인의 플랜은 그 해시를 `already_recorded`로 받는다(돈은 움직이지 않음 — 기록만). (b) 한 지갑에 열린 플랜 5개를 먼저 채워 주인이 새 플랜을 못 만들게 할 수 있다. 해결책 후보: 플랜 생성 때 `baw sign-message`(EIP-712) 서명으로 지갑 소유를 증명 — 사용자가 Binance 앱에서 Developer Mode를 켜야 하고 서명 형식이 실측되지 않아(⚠️VERIFY) **사람 결정 대기**(DECISIONS Q-17).
- 워커가 죽은 뒤 `running`으로 남은 사이클은 그 플랜이 다음에 락을 잡을 때 정리된다 — 수동 실행(심사위원 `run`)이 죽으면 그때까지 캡 예약이 남아 코드의 남은 한도가 적게 보인다(다음 실행에서 풀림).
- 10분 안의 스왑 재전송은 새 시뮬레이션·시장 시간 확인 없이 같은 바이트를 보낸다(minReceive 0.5% 보호는 그대로).

## 남은 일

- [HUMAN] 배포된 도메인에서 헤더·CSP 재확인(`pnpm ui:check --url https://…`), HSTS preload 등록 여부 결정.
- [HUMAN] 하우스 지갑 잔고 상한 $300 유지 확인(SPEC §14).
- [HUMAN] Fly·Vercel의 캡 값이 새 형식 검증을 통과하는지 배포 전 확인(RUNBOOK §4).
- [HUMAN] Q-17 스킬 지갑 소유 증명 여부 결정.
