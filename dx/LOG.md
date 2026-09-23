# dx/LOG.md — 개발자 경험 로그 (시간순, 추가만)

형식은 `docs/DX_PROTOCOL.md` §3.1. 에이전트는 사실(기대·실제·증거)만, 사람은 `- 소감:` 줄을 덧붙인다.
시각은 UTC. 태그: `[web3api|baw|skill|bag|chain|defi|rwa|trading|tx|wallet|b402][auth|docs|error|latency|edge|missing]`.

---

## 2026-09-23 — 프로젝트 시작 (기획)
- 대회 공식 페이지의 규칙·채점 기준·리소스 목록을 확보했고, Binance Skills Hub(`binance-agentic-wallet` v1.12.0, `binance-tokenized-securities-info` v1.1)를 읽었다.
- 기획 환경에서는 `web3.binance.com`, `developers.binance.com`, `bnbchain.org`가 네트워크 정책으로 차단되어 공식 문서를 직접 읽지 못했다. 엔드포인트·서명 규약은 선행 빌더 메모에서 가져왔고 전부 ⚠️VERIFY로 표시했다.
- 다음 항목부터는 실제 개발 경험을 기록한다: 포털 로그인 시각 → 키 발급 시각 → 첫 미서명 호출 → 첫 서명 호출.
