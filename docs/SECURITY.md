# SECURITY — 보안 점검 (M3-05, SPEC §14)

작성: 코딩 에이전트(9/26). 사실과 증거만 적었다. 사람이 검토한다.

## 누가 무엇을 서명하나

- **워커(Fly, fra)만 서명한다.** 하우스 키는 워커 env에만 있다(`HOUSE_WALLET_PRIVATE_KEY`, 웹에는 없음). 서명 전: 정확한 금액의 승인만(무제한 승인 거부), 스왑 calldata 해독·검증(보낸 사람=하우스, value 0, 승인 대상=spender), Transaction API 시뮬레이션 SUCCESS, 가스 상한, 25초 넘은 견적은 다시 받음(SPEC §5.8, `apps/agent/src/executor/*`).
- **웹은 서명하지 않고 Binance Web3 API도 부르지 않는다.** 워커가 기록한 DB와 공개 BSC RPC만 읽고, 실행은 `jobs`로 넘긴다.
- **스킬 플랜(모드 C)은 사용자 지갑이 서명한다.** 서버는 `baw` 명령(argv)만 주고 calldata·서명·세션을 만들지 않는다. `/report`는 체인에서 확인된 것만 기록한다(채굴·성공·플랜 지갑 발신·Transfer 로그).
- 스킬 플랜의 Venus 원금은 사용자 지갑에 있다: 워커는 정지 잡이나 가디언 `redeem_all`에서 스킬 플랜을 **상환하지 않는다**(`redeemPlanPosition` 소유자 확인). 이 확인 전에는 스킬 플랜의 보고된 vToken 수만큼 하우스 지갑에서 상환하는 경로가 있었다 — 9/26 수정, 테스트 "never redeems a skill plan's position from the house wallet"(수정 전 실패 확인). 워커는 스킬 플랜의 `run`·`preview` 잡도 거부한다.

## 한도(캡)

- 캡은 env에서 `packages/config` 한 곳에서만 읽는다. 다른 소스에 캡 변수 이름이 나오면 테스트가 실패한다(`packages/config/src/index.test.ts`). 부팅 때 검증: 최소 매수 ≤ 1회 ≤ 일일.
- 지출은 `spend_ledger`에 advisory lock 아래 한 트랜잭션으로 예약한다(동시 사이클이 캡을 함께 넘지 못함 — 잠금을 빼면 실패하는 테스트). 하우스 일일 합계는 하우스·심사위원 플랜만 센다(스킬 플랜은 사용자 지갑 — 9/26 수정, 캡 값 변경 없음).
- 심사위원 코드 1개 = 샌드박스 캡($5) 총액, 7일 뒤 자동 종료. 스킬 플랜 1회 한도 ≤ 하우스 1회 캡, 일 ≥ 1회.

## 인증·세션·레이트리밋

- 심사위원 코드: SHA-256만 저장, 쿠키 `ijaro_judge`는 HMAC-SHA256 서명(코드 해시 + 만료), HttpOnly, SameSite=Lax, HTTPS면 Secure, 7일. `SESSION_SECRET` 32자 이상, 없으면 세션 기능이 꺼진다(503).
- 스킬 토큰 `ijr_…`: 한 번만 보여주고 해시만 저장, 플랜 소유 확인(`ownedPlan`).
- 레이트리밋: 코드 시도 IP당 분 10회, 스킬 플랜 생성 IP당 시간 5개, `/next` 플랜당 분 30회, `/report` 분 20회(인스턴스 메모리) + 지속 한도(코드당 시간 5플랜, 지갑당 열린 5플랜, 플랜당 10분 10잡)는 Postgres.
- CSRF: 쓰기 요청의 쿠키는 SameSite=Lax라 다른 사이트의 POST에 붙지 않는다. 스킬 경로는 Bearer 헤더.

## HTTP 보안 헤더

- `apps/web/proxy.ts`: 요청마다 새 nonce의 CSP — `default-src 'self'`, `script-src 'self' 'nonce-…' 'strict-dynamic'`(인라인 스크립트 금지), `style-src 'self' 'nonce-…'`, `style-src-attr 'unsafe-inline'`(진행 막대의 style 속성만), `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, HTTPS면 `upgrade-insecure-requests`.
- `apps/web/next.config.ts`: HSTS(2년, includeSubDomains, preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`(카메라·마이크·위치·결제 끔), `X-Powered-By` 없음.
- 확인(로컬 `next start`): 응답 헤더에 위 값, 홈 HTML의 `<script>` 7개 모두 nonce 보유, `pnpm ui:check`(Chromium, 7화면 × KO/EN × 375/1440px)에서 콘솔 오류·CSP 위반 0.

## 오류가 새지 않게

- 공개 응답에는 원문 오류를 싣지 않는다(호스트·포트, 키가 든 RPC URL이 섞일 수 있음): 화면은 "불러올 수 없어요 (database unavailable)", API는 503 `{"state":"UNAVAILABLE","reason":"database unavailable"}`, smoke는 `rpc unreachable`/`database unreachable`. 원문은 서버 로그에만. 테스트: 응답 본문에 호스트(`127.0.0.1`)가 없음을 확인.
- 로그·픽스처·알림에서 키와 하우스 주소를 가린다(`maskSensitive`, `houseRedactions`, 알림 `redact`).

## 시크릿 스캔 (9/26, 전체 git 이력)

- 64자리 16진수: 테스트용 공개 키(Hardhat/Anvil 기본 계정 #0, 널리 알려진 값)뿐.
- `*_KEY=`/`*_SECRET=` 형태: 서명 테스트 벡터의 가짜 값(`vector-api-key`)과 웹 테스트의 세션 시크릿뿐.
- Neon URL: 설정 테스트의 가짜 예시(`npg_AbC123@ep-cool-name-…`)뿐. `ijr_` 토큰·텔레그램 토큰·PEM 키: 없음.
- 추적 파일: `.env.example`(값 없는 틀)만. `.gitignore`: `.env*`(예외 `.env.example`), `*.pem`, `*.key`, `.studio/`, `.baw/`, 벤더 문서. 워커 Docker 빌드는 `.env*`가 있으면 실패한다.

## 의존성 감사

- `pnpm audit --prod`: **No known vulnerabilities found.**
- `pnpm audit`(개발 의존성 포함): moderate 1건 — `esbuild ≤ 0.24.2`(GHSA-67mh-4wv8-2f99, esbuild **개발 서버**의 CORS 문제) — 경로 `drizzle-kit > @esbuild-kit/… > esbuild`. 마이그레이션 생성 도구 전용이고 esbuild serve를 쓰지 않는다. 강제 업그레이드는 drizzle-kit을 깨뜨릴 수 있어 두었다 → [HUMAN] 수용 여부 확인.

## 남은 일

- [HUMAN] 배포된 도메인에서 헤더·CSP 재확인(`pnpm ui:check --url https://…`), HSTS preload 등록 여부 결정.
- [HUMAN] 하우스 지갑 잔고 상한 $300 유지 확인(SPEC §14).
