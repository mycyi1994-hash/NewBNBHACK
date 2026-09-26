# UX_COPY.md — 화면 문구 (KR / EN)

작성: 강민서. 규칙: 모든 UI 문자열은 이 문서의 키를 쓴다. 새 문구가 필요하면 여기에 먼저 추가한다. `pnpm lint:copy`가 §6 금지어를 검사한다.

## 1. 원칙
1. 크립토를 모르는 사람이 읽는다. 용어는 §2 치환표대로.
2. 한 화면에 결정 하나. 버튼은 동사로.
3. 숫자는 정직하게, 작아도 그대로.
4. 실패와 대기는 이유와 다음 시각을 함께.
5. 위험은 숨기지 않되 겁주지 않는다.

## 2. 용어 치환표
| 쓰지 않는 말 | 쓰는 말 (KR) | EN |
| --- | --- | --- |
| 토큰 (수량) | 주식 조각 / 주 | shares |
| 스왑 | 매수 / 매도 | buy / sell |
| 가스 | 네트워크 수수료 | network fee |
| 컨트랙트 / 주소 | (숨김, '자세히'에서만) | (hidden) |
| 슬리피지 | 가격 변동 허용폭 | price tolerance |
| 어프루브 | 사용 허용 | allow |
| 예치 / 렌딩 | 이자 통장에 넣기 | put in the interest account |
| 리딤 | 이자 통장에서 꺼내기 | take out |
| tx / 트랜잭션 | 처리 내역 / 영수증 | receipt |
| 온체인 | (필요 시) 블록체인에 기록됨 | recorded on-chain |
| 참조가 | 기준 주가(플랫폼 제공) | reference price (platform) |

## 3. 화면별 문구

### 3.1 홈 (Watch)
- `home.title`: 이자로 주식을 삽니다 / Interest buys the stock.
- `home.sub`: 원금은 그대로 두고, 이자로만 미국 주식을 조금씩 모아요. / Your principal stays put. Only the interest buys US stocks.
- `home.status.live`: 실시간 / Live · `home.status.stale`: {min}분 전 데이터 / {min} min old · `home.status.unavailable`: 지금은 불러올 수 없어요 ({reason}) / Unavailable ({reason})
- `home.market.regular`: 미국 정규장 진행 중 · {close} 마감 / US regular session · closes {close}
- `home.market.closed`: 미국 장 마감 · 다음 개장 {open} / US market closed · opens {open}
- `home.cta.judge`: 심사위원 코드로 체험하기 / Try it with a judge code
- `home.cta.skill`: 내 AI 비서로 시작하기 / Start with my AI assistant
- `home.house.card.title`: 이자로가 직접 돌리는 플랜 / A plan Ijaro runs itself
- `home.house.principal`: 이자 통장 원금 / Principal in the interest account
- `home.house.interest`: 지금까지 쌓인 이자 / Interest earned so far
- `home.house.shares`: 모은 주식 / Shares collected
- `home.house.next`: 다음 매수 / Next buy

### 3.2 Judge Mode
- `judge.code.title`: 심사위원 코드를 입력해 주세요 / Enter your judge code
- `judge.code.hint`: 코드 하나로 최대 ${cap}까지 체험할 수 있어요. 돈은 이자로의 지갑에서 나가요. / One code covers up to ${cap}. Funds come from Ijaro's own wallet.
- `judge.pick.title`: 어떤 주식을 모을까요? / Which stock should we collect?
- `judge.pick.sector`: 또는 분야로 고르기 / Or pick a sector
- `judge.pick.issuer.auto`: 발행사는 자동으로 골라요 ({issuer}) / Issuer chosen automatically ({issuer})
- `judge.mode.safe`: 적립만 (기본) / Contribution only (default)
- `judge.mode.safe.desc`: 정한 금액으로만 사요. 이자 통장은 쓰지 않아요. / Buys only with the amount you set. No interest account.
- `judge.mode.yield`: 이자로 사기 / Buy with interest
- `judge.mode.yield.desc`: 원금을 이자 통장에 넣고, 이자가 생기면 그걸로 사요. / Puts principal in the interest account and buys with the interest it earns.
- `judge.amount.label`: 이번에 살 금액 / Amount for this buy
- `judge.window.regular`: 미국 정규장에만 사기 (권장) / Buy only during US regular hours (recommended)
- `judge.window.anytime`: 장 마감 중에도 사기 (가격이 기준과 다를 수 있어요) / Buy even when the market is closed (price may differ from reference)
- `judge.preview.title`: 이렇게 진행돼요 / Here is what will happen
- `judge.preview.line`: {usd}달러로 {ticker} 약 {shares}주를 받아요. 네트워크 수수료 약 ${fee}. 기준 주가 대비 {gap}%. / You pay ${usd} and receive about {shares} shares of {ticker}. Network fee about ${fee}. {gap}% vs reference.
- `judge.preview.simulated`: 블록체인에서 미리 돌려봤어요 · 성공 / Dry-run on-chain · success
- `judge.preview.failed`: 미리 돌려봤더니 실패했어요: {reason}. 돈은 나가지 않았어요. / The dry-run failed: {reason}. No funds moved.
- `judge.run.cta`: 지금 사기 / Buy now
- `judge.run.progress.{approve|swap|confirm}`: 사용 허용 중… / 매수 중… / 기록 확인 중… — Allowing… / Buying… / Confirming…
- `judge.done.title`: 샀어요 / Done
- `judge.done.line`: {ticker} {shares}주 (${usd}) · 영수증 보기 / {ticker} {shares} shares (${usd}) · View receipt
- `judge.stop.cta`: 플랜 멈추기 / Stop this plan
- `judge.stop.yield.note`: 이자 통장에 있던 원금을 전부 꺼내요. 주식은 그대로 남아요. / Takes all principal out of the interest account. Your shares stay.

### 3.3 플랜 상세
- `plan.limits`: 한도: 1회 ${perBuy} · 하루 ${daily} · 오늘 사용 ${used} / Limits: ${perBuy} per buy · ${daily} per day · ${used} used today
- `plan.guardian.title`: 지킴이 / Guardian
- `plan.guardian.ok`: 이상 없음 · 마지막 점검 {time} / All clear · last check {time}
- `plan.timeline.title`: 기록 / History

### 3.4 스킬 안내
- `skill.title`: 내 AI 비서에게 맡기기 / Hand it to your AI assistant
- `skill.step1`: Binance 앱에서 Agentic Wallet을 만들어요. / Create an Agentic Wallet in the Binance app.
- `skill.step2`: 비서에 이 한 줄을 설치해요. / Install this one line into your assistant.
- `skill.step3`: "이자로 시작해줘"라고 말해요. 비서가 매번 확인을 받고 실행해요. / Say "Start Ijaro". Your assistant asks before every action.
- `skill.note`: 이자로 서버는 결정만 해요. 지갑 서명은 항상 내 기기에서. / Ijaro's server only decides. Signing always happens on your device.

## 4. 사유 한 줄 (whyKey)
| 키 | KR | EN |
| --- | --- | --- |
| `why.bought.regular` | 정규장에 {ticker} {shares}주(${usd})를 샀어요. 기준 주가 대비 {gap}%. | Bought {shares} shares of {ticker} (${usd}) during regular hours. {gap}% vs reference. |
| `why.bought.anytime` | 장 마감 중에 {ticker} {shares}주(${usd})를 샀어요. 기준 주가 대비 {gap}%. | Bought {shares} shares of {ticker} (${usd}) while the market was closed. {gap}% vs reference. |
| `why.bought.interest` | 쌓인 이자 ${interest}로 {ticker} {shares}주를 샀어요. 원금은 그대로예요. | Used ${interest} of interest to buy {shares} shares of {ticker}. Principal untouched. |
| `why.deferred.market_closed` | 미국 장이 닫혀 있어요. {open}에 다시 시도해요. | US market is closed. Retrying at {open}. |
| `why.deferred.price_gap` | 지금 가격이 기준 주가보다 {gap}% 높아요. 2% 안으로 오면 살게요. | Price is {gap}% above reference. Will buy once within 2%. |
| `why.deferred.quote_impact` | 이 금액은 시장에 부담이 커요(가격영향 {impact}%). 금액을 줄여 다시 볼게요. | This size moves the price too much ({impact}% impact). Retrying smaller. |
| `why.skipped.below_min` | 이자가 ${acc} 쌓였어요. ${min}이 되면 살게요. | Interest is at ${acc}. Will buy at ${min}. |
| `why.skipped.corporate_action.earnings` | {ticker}가 실적 발표로 거래가 제한됐어요. 풀리면 다시 시도해요. | {ticker} is restricted for earnings. Retrying when lifted. |
| `why.skipped.corporate_action.cash_dividend` | {ticker}가 배당 처리 중이라 잠시 멈췄어요. | {ticker} is paused for a dividend. |
| `why.skipped.corporate_action.stock_split` | {ticker}가 액면분할 처리 중이라 잠시 멈췄어요. 주식 수 표시가 바뀔 수 있어요. | {ticker} is paused for a stock split. Share counts may change. |
| `why.skipped.daily_cap` | 오늘 한도(${daily})를 다 썼어요. 내일 다시요. | Daily limit (${daily}) reached. Tomorrow. |
| `why.skipped.guardian` | 지킴이가 멈췄어요: {rule}. 원금은 지갑으로 옮겼어요. | Guardian stopped the plan: {rule}. Principal moved back to the wallet. |
| `why.skipped.no_liquidity` | 지금은 {ticker}를 살 수 있는 물량이 없어요. | No liquidity for {ticker} right now. |
| `why.failed.simulation` | 미리 돌려봤더니 실패했어요({code}). 돈은 나가지 않았어요. | Dry-run failed ({code}). No funds moved. |
| `why.failed.onchain` | 처리에 실패했어요({code}). 네트워크 수수료만 나갔어요. | The transaction failed ({code}). Only the network fee was spent. |

## 5. 위험 고지 (전문, 이자 모드 켤 때 + `/risk`)
**KR**
> 이자로는 은행이 아니에요. 이자 통장은 BSC의 대출 서비스(Venus)예요. 이자는 거기서 돈을 빌린 사람들이 내요.
> 1. 원금을 잃을 수 있어요. Venus가 해킹되거나 USDT 가치가 흔들리면 돌려받지 못할 수 있어요.
> 2. 이자율은 매일 바뀌어요. 지금은 연 {apy}%예요(플랫폼 보안 점수 {score}).
> 3. 주식 조각의 가격은 오르내려요.
> 4. 언제든 꺼낼 수 있지만, 서비스가 멈추면 늦어질 수 있어요.
> 5. 이자로의 지킴이는 이상 징후를 보면 원금을 지갑으로 옮기지만, 모든 사고를 막지는 못해요.
> 이 내용을 이해했고, 잃어도 되는 돈만 넣을게요. [동의하고 켜기]

**EN**
> Ijaro is not a bank. The interest account is a lending service on BSC (Venus). The interest is paid by people who borrow there.
> 1. You can lose principal. If Venus is exploited or USDT loses its peg, you may not get it back.
> 2. The rate changes daily. Today it is {apy}% APY (platform security score {score}).
> 3. Share prices go up and down.
> 4. You can withdraw any time, but if the service pauses it may take longer.
> 5. Ijaro's guardian moves principal back to your wallet on warning signs, but cannot prevent every incident.
> I understand this and will only use money I can afford to lose. [Agree and turn on]

## 6. 금지어 (`pnpm lint:copy`)
원금 보장 · 안전한 수익 · 확정 이자 · 무위험 · 보장 · guaranteed · risk-free · safe yield · principal protected · 수익률 예상 · 추천 종목 (AI 추천 기능은 "공식 분석 리포트 참고"로 표기)

## 7. 에이전트 초안 — 사람 확정 전 (DESIGN_BRIEF §10)
> 작성: 코딩 에이전트(9/26). **사람이 검토·수정해 확정할 때까지 초안이다.** 한국어는 DESIGN_BRIEF의 [신규 문구]를 그대로 옮겼고, 영어와 브리프에 없던 화면 부품 문구(버튼·오류·표 머리)는 에이전트가 썼다. 형식은 §3과 같다(`키`: KR / EN). `pnpm copy:gen`이 이 문서에서 `apps/web/lib/i18n/copy.ts`를 만든다. 고칠 때는 이 문서를 고치고 다시 생성한다.

### 7.1 공통
- `nav.home`: 홈 / Home
- `nav.judge`: 체험하기 / Try it
- `nav.skill`: 내 AI 비서로 / With my AI assistant
- `nav.dx`: 기록·데이터 / Data
- `nav.risk`: 위험 고지 / Risks
- `lang.label`: 언어 / Language
- `footer.risk`: 이자로는 은행이 아니에요. 원금을 잃을 수 있어요. / Ijaro is not a bank. You can lose principal.
- `footer.apis`: Binance Web3 API · BNB Chain 사용 / Built on the Binance Web3 API · BNB Chain
- `footer.simulate`: 모든 매수는 실행 전에 블록체인에서 미리 돌려봐요. / Every buy is dry-run on-chain before it runs.
- `footer.github`: 소스 코드 (GitHub) / Source code (GitHub)
- `common.confirm`: 확인 / Continue
- `common.cancel`: 취소 / Cancel
- `common.back`: 뒤로 / Back
- `common.retry`: 다시 시도 / Try again
- `common.details`: 자세히 / Details
- `common.loading`: 불러오는 중… / Loading…
- `common.view_all`: 전체 보기 / View all
- `common.updated`: 마지막 갱신 {time} / Updated {time}
- `common.none`: 없음 / None
- `common.notfound`: 찾는 페이지가 없어요 / This page doesn't exist
- `receipt.view`: 영수증 보기 ↗ / View receipt ↗
- `outcome.BOUGHT`: 샀어요 / Bought
- `outcome.DEFERRED`: 기다려요 / Waiting
- `outcome.SKIPPED`: 건너뛰었어요 / Skipped
- `outcome.FAILED`: 실패 / Failed
- `outcome.interest_only`: 이자로만 / Interest only
- `outcome.simulated`: 미리 돌려본 기록 / Dry run
- `outcome.running`: 진행 중 / In progress
- `outcome.deposit`: 이자 통장에 넣었어요 / Put in the interest account
- `outcome.redeem`: 이자 통장에서 꺼냈어요 / Taken out of the interest account
- `why.data.stale`: 데이터가 오래돼 기다려요. {time}에 다시 봐요. / The data is old, so we wait. Checking again at {time}.
- `why.data.unavailable`: 데이터를 불러올 수 없어 기다려요. / The data is unavailable, so we wait.

### 7.2 홈
- `home.house.next.progress`: 다음 매수까지 ${left} 남음 / ${left} to the next buy
- `home.house.next.min`: 이자가 ${min}가 되면 / When interest reaches ${min}
- `home.house.receipts`: 영수증 {n}개 / {n} receipts
- `home.house.link`: 기록 보기 → / View history →
- `home.house.today`: 오늘 한도 ${daily} 중 ${used} 사용 / ${used} of ${daily} used today
- `home.feed.title`: 최근 기록 / Recent activity
- `home.feed.empty`: 아직 기록이 없어요. / Nothing recorded yet.
- `home.insight.title`: 장이 닫혀 있을 때 사면 얼마나 비쌀까? / How much more does it cost when the market is closed?
- `home.insight.summary`: 지난 7일, 장 마감 중 가격은 실제 주가와 평균 {offhours}% 차이가 났어요 (정규장 {regular}%). / Over the last 7 days, off-hours prices differed from the real stock price by {offhours}% on average ({regular}% in regular hours).
- `home.insight.source`: 프랑크푸르트 서버에서 10분마다 기록 / Recorded every 10 minutes from our Frankfurt server
- `home.insight.more`: 기록·데이터에서 자세히 → / More in Data →
- `home.stocks.title`: 모을 수 있는 주식 / Stocks you can collect
- `home.stocks.price`: 1주 가격 / Price per share
- `home.stocks.where`: 살 수 있는 곳 / Where to buy
- `home.stocks.min`: 최소 주문 ${min} / Minimum order ${min}
- `home.stocks.only_ondo`: Ondo에서만 살 수 있어요 · 최소 주문 ${min} / Only on Ondo · minimum order ${min}
- `home.stocks.multiplier`: 주식 조각 1개는 실제 주식 약 {m}주예요(배당이 반영돼 조금씩 바뀌어요). / Each piece is about {m} real shares (it changes slightly with dividends).
- `home.trust.title`: 믿을 수 있는 이유 / Why you can check us
- `home.trust.simulate`: 모든 매수는 먼저 블록체인에서 미리 돌려봐요 / Every buy is dry-run on-chain first
- `home.trust.caps`: 한도: 1회 ${perTx} · 하루 ${daily} / Limits: ${perTx} per buy · ${daily} per day
- `home.trust.keys`: 서버는 여러분의 지갑 열쇠를 보관하지 않아요 / Our server never holds your wallet keys
- `home.counter.asof`: 블록체인에서 {time}에 읽음 / Read on-chain at {time}
- `home.counter.apy`: 이자 통장(Venus) 연 {apy}% · 보안 점수 {score} / Interest account (Venus) {apy}% APY · security score {score}

### 7.3 플랜
- `plan.name.safe`: {ticker} · {cadence} ${usd} · {window} / {ticker} · ${usd} {cadence} · {window}
- `plan.name.yield`: {ticker} · 이자로만 · {cadence} · {window} / {ticker} · interest only · {cadence} · {window}
- `plan.cadence.daily`: 매일 / daily
- `plan.cadence.weekly`: 주 1회 / weekly
- `plan.window.regular_session`: 정규장에만 / regular hours only
- `plan.window.anytime`: 언제든 / any time
- `plan.status.active`: 진행 중 / Running
- `plan.status.paused`: 일시정지 / Paused
- `plan.status.stopped`: 멈춤 / Stopped
- `plan.owner.house`: 이자로가 직접 / Run by Ijaro
- `plan.owner.judge`: 심사위원 체험 / Judge trial
- `plan.owner.skill`: 내 AI 비서 / My AI assistant
- `plan.paused.awaiting_funding`: 자금이 들어오면 시작해요 / Starts once funded
- `plan.paused.awaiting_run`: 첫 실행을 기다려요 / Waiting for its first run
- `plan.paused.awaiting_deposit`: 이자 통장에 넣은 기록을 기다려요 / Waiting for its deposit to be reported
- `plan.paused.report_over_limit`: 한도를 넘은 매수가 보고돼 멈췄어요 / Paused: a reported buy went over its limits
- `plan.paused.guardian`: 지킴이가 멈췄어요 / Paused by the guardian
- `plan.paused.expired`: 7일이 지나 끝났어요 / Ended after 7 days
- `plan.paused.other`: 멈춘 이유: {reason} / Paused: {reason}
- `plan.next.none`: 예정 없음 / Not scheduled
- `plan.summary.average`: 평균 매수가 ${avg} / Average price ${avg}
- `plan.holdings.title`: 보유 주식 / Shares held
- `plan.holdings.line`: {ticker} {shares}주 · 평균 ${avg} / {ticker} {shares} shares · avg ${avg}
- `plan.holdings.multiplier`: 주식 조각 1개 = {m}주 / 1 piece = {m} shares
- `plan.guardian.metrics`: 감시 항목 / What it watches
- `plan.guardian.utilization`: 이자 통장 이용률 {value}% (기준 95%) / Interest account utilization {value}% (limit 95%)
- `plan.guardian.usdt`: USDT 가격 ${value} (기준 $0.99) / USDT price ${value} (floor $0.99)
- `plan.guardian.tvl`: 이자 통장 전체 규모 ${value} (하루 −30%면 멈춤) / Interest account size ${value} (stops on a −30% day)
- `plan.guardian.impact`: 가격영향 기준 1% / Price impact limit 1%
- `plan.guardian.open`: 지금 멈춰 있어요: {rule} / Holding now: {rule}
- `plan.guardian.nodata`: 아직 점검 기록이 없어요 / No checks recorded yet
- `guardian.rule.usdt_depeg`: USDT 가격 이탈 / USDT off its peg
- `guardian.rule.tvl_drop`: 이자 통장 규모 급감 / Sharp drop in the interest account
- `guardian.rule.protocol_paused`: Venus 일시정지 / Venus paused
- `guardian.rule.utilization_high`: 이용률 95% 초과 / Utilization above 95%
- `guardian.rule.multiplier_changed`: 주식 수 배수 변경 / Share multiplier changed
- `plan.timeline.all`: 전체 / All
- `plan.stop.confirm`: 이 플랜을 멈출까요? / Stop this plan?
- `plan.stop.queued`: 멈추는 중… / Stopping…
- `plan.stop.done`: 멈췄어요 / Stopped

### 7.4 체험하기
- `judge.step.code`: 코드 / Code
- `judge.step.pick`: 종목 / Stock
- `judge.step.mode`: 방식·금액 / How & how much
- `judge.step.preview`: 미리보기 / Preview
- `judge.step.run`: 실행 / Run
- `judge.step.done`: 영수증 / Receipt
- `judge.code.error.bad`: 코드가 맞지 않아요 / That code doesn't match
- `judge.code.error.exhausted`: 이 코드는 한도를 다 썼어요 / This code has used its limit
- `judge.code.remaining`: 남은 체험 한도 ${remaining} / ${remaining} left on this code
- `judge.pick.venue_min`: Ondo에서만 살 수 있고 최소 주문이 ${min}이라, 체험 한도(${cap})로는 살 수 없어요 / Only on Ondo with a ${min} minimum, above this code's ${cap} limit
- `judge.window.regular.closed`: 다음 개장 {open}에 자동으로 사요 / Buys automatically at the next open, {open}
- `judge.window.anytime.closed`: 지금 바로 사요 · 한도 절반(${half}) / Buys right away · half the limit (${half})
- `judge.amount.custom`: 직접 입력 / Custom
- `judge.yield.amount`: 이자 통장에 넣을 금액 / Amount to put in the interest account
- `judge.yield.note`: 이자는 쌓이는 대로 기록돼요. 이자로 사는 장면은 이자로가 직접 돌리는 플랜에서 볼 수 있어요. / Interest is recorded as it accrues. Buys made with interest show on Ijaro's own plan.
- `judge.risk.check`: 이해했어요 / I understand
- `judge.preview.cta`: 미리 돌려보기 / Dry-run it
- `judge.preview.waiting`: 서버가 블록체인에서 미리 돌려보는 중… / Our server is dry-running it on-chain…
- `judge.preview.deposit`: 이자 통장에 ${usd}를 넣어요. / Puts ${usd} in the interest account.
- `judge.details.issuer`: 발행사 / Issuer
- `judge.details.pieces`: 받을 주식 조각 / Pieces to receive
- `judge.details.min`: 최소 수령 / Minimum received
- `judge.details.contract`: 컨트랙트 주소 / Contract address
- `judge.run.waiting`: 서버가 처리 중이에요… / Our server is on it…
- `judge.done.plan_note`: 이 플랜은 7일 동안 자동으로 돌아요. 나중에 다시 와서 기록을 보세요. / This plan keeps running for 7 days. Come back to see its history.
- `judge.done.deferred_note`: 사면 플랜 기록에 남아요. / When it buys, it shows in the plan history.
- `judge.done.deposited`: 이자 통장에 ${usd}를 넣었어요. / Put ${usd} in the interest account.
- `judge.done.simulated`: 지금 서버는 시뮬레이션 모드라 실제로 사지 않았어요. 미리 돌려본 결과만 기록했어요. / The server is in simulation mode, so nothing was bought. Only the dry-run was recorded.
- `judge.done.confirming`: 블록체인 기록을 기다리는 중이에요. 확인되면 플랜 기록에 남아요. / Waiting for the blockchain record. It shows in the plan history once confirmed.
- `judge.summary.title`: 요약 / Summary
- `judge.summary.window`: 사는 시간 / When
- `judge.plan.link`: 플랜 기록 보기 → / View plan history →
- `judge.error.generic`: 문제가 생겼어요: {reason} / Something went wrong: {reason}
- `judge.error.rate_limited`: 요청이 많아요. 잠시 후 다시 시도해 주세요. / Too many requests. Try again shortly.
- `judge.error.unavailable`: 지금은 체험을 준비하지 못했어요 ({reason}) / The trial isn't available right now ({reason})
- `judge.job.failed`: 처리하지 못했어요: {reason} / Couldn't finish: {reason}

### 7.5 위험 고지·스킬·데이터
- `risk.page.default`: 기본값은 적립만(안전 모드)이에요 · 이자 통장을 쓰지 않아요 / The default is contribution only (safe mode) · no interest account
- `skill.install.label`: 설치 명령 / Install command
- `skill.example.title`: 대화 예시 / Example conversation
- `skill.example.me`: 나 / Me
- `skill.example.assistant`: 비서 / Assistant
- `skill.example.1`: 이자로 시작해줘. 매주 $5씩 NVDA 모아줘. / Start Ijaro. Collect $5 of NVDA every week.
- `skill.example.2`: 시작하기 전에 위험 고지를 읽어 드릴게요. 원금을 잃을 수 있어요. 동의하시나요? / Before we start, here are the risks. You can lose principal. Do you agree?
- `skill.example.3`: 지금 NVDA를 $5어치 사요. 미리 돌려봤더니 성공이에요. 진행할까요? / I'll buy $5 of NVDA now. The dry-run succeeded. Go ahead?
- `skill.example.4`: 응 / Yes
- `skill.example.5`: 샀어요. 영수증을 남겼어요. / Done. The receipt is recorded.
- `skill.rules.title`: 비서가 지키는 규칙 / Rules the assistant follows
- `skill.rules.1`: 상태를 바꾸기 전에는 항상 미리보기와 확인을 거쳐요. / It always previews and asks before changing anything.
- `skill.rules.2`: 서버가 준 주소는 공식 목록과 대조해요. / It checks every address the server gives against the official list.
- `skill.rules.3`: 로그인이 만료되기 2시간 전에 알려요. / It warns two hours before the wallet login expires.
- `skill.rules.4`: 주문 번호는 체결이 아니라서 확인까지 기다려요. / An order number is not a trade; it waits for confirmation.
- `skill.rules.5`: 오류 문구는 고치지 않고 그대로 전해요. / It passes error messages on as they are.
- `skill.api`: 개발자용 API 문서 (OpenAPI) / API reference for developers (OpenAPI)
- `dx.title`: 기록·데이터 / Data
- `dx.sub`: 이자로가 Binance Web3 API를 실제로 호출하며 잰 숫자예요. / Numbers we measured from our real calls to the Binance Web3 API.
- `dx.summary.calls`: API 호출 / API calls
- `dx.summary.error_rate`: 오류율 / Error rate
- `dx.summary.p95`: p95 지연 / p95 latency
- `dx.summary.tape`: 테이프 견적 / Tape quotes
- `dx.endpoints.title`: 엔드포인트별 / By endpoint
- `dx.regions.title`: 지역별 지연 / Latency by region
- `dx.col.module`: 모듈 / Module
- `dx.col.endpoint`: 엔드포인트 / Endpoint
- `dx.col.calls`: 호출 / Calls
- `dx.col.errors`: 오류 / Errors
- `dx.col.codes`: 결과 코드 / Result codes
- `dx.col.region`: 지역 / Region
- `dx.col.issuer`: 발행사 / Issuer
- `dx.col.quotes`: 견적 / Quotes
- `dx.col.quote_errors`: 견적 오류 / Quote errors
- `dx.col.impact`: 평균 가격영향 / Avg price impact
- `dx.col.gap`: 평균 가격 차이 / Avg price gap
- `dx.col.size`: 주문 크기 / Order size
- `dx.col.session`: 시간대 / Session
- `dx.tape.gap.title`: 시간대별 가격 차이 (주식 조각 가격 ÷ 배수 대 미국 주가) / Price gap by session (token price ÷ multiplier vs the US price)
- `dx.tape.impact.title`: 주문 크기별 가격영향 / Price impact by order size
- `dx.tape.issuers.title`: 발행사 비교 / Issuers compared
- `dx.findings.title`: 발견 목록 / Findings
- `dx.findings.empty`: 아직 새로 발견한 코드가 없어요. / No undocumented codes seen yet.
- `dx.method`: 측정 방법: {method} / Method: {method}
- `dx.window`: 최근 {days}일 / Last {days} days
- `dx.session.regular`: 정규장 / Regular
- `dx.session.pre`: 장 전 / Pre-market
- `dx.session.post`: 장 후 / After hours
- `dx.session.overnight`: 야간 / Overnight
- `dx.session.weekend`: 주말 / Weekend
- `dx.session.holiday`: 휴장일 / Holiday
