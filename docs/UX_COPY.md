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
