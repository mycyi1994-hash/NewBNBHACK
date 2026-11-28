# Demo video script (3 minutes)

Record at 1440×900 with the app in Korean (or English). Log in with a wallet whose vault holds a few USDT. Each
scene says what is on screen and what is said. Say only what the screen shows; no promises of returns.
The story in one line: **an AI decides, code limits it, the vault on HSK Chain enforces it, and all of it is public.**
The four-box pitch is in [`PITCH.md`](PITCH.md).

| Time | On screen | Narration |
| --- | --- | --- |
| 0:00–0:15 | Trade screen, BTC chart, Moa on the right | "Moa is an AI trading agent for people who have never traded. You give it a little money; it trades from your own vault on HSK Chain, inside limits you set." |
| 0:15–0:40 | Agent market → Moa AI · BTC card: the share now, "AI의 이유" | "Every four hours an AI model reads the market in numbers and decides how much of my budget to hold. It gives its reason in plain words." |
| 0:40–1:00 | Press 판단 기록: the decision list, "AI 제안 40%" next to the applied share, press 해시 확인 | "The model only proposes. Code rounds it, lets it move at most 25 points at a time, and holds if the answer is late or wrong. Every decision is recorded with a hash anyone can check." |
| 1:00–1:20 | 맡기기 → the hire sheet: a budget, 알아서 하기, the three checks | "I give it a small budget and let it run on its own. It can never spend more than this budget, and only I can withdraw." |
| 1:20–1:45 | My agents: the agent, its last decision and reason in the runner panel; then the vault on the HSK Chain explorer (owner, agent key, limits). If the agent has traded: its order → the receipt → the trade on the explorer | "The vault is a contract on HSK Chain mainnet. The agent's key can trade listed coins inside my per-trade and daily limits. It cannot withdraw." Say "this order went from my vault to HSKSwap" only when showing a real trade. |
| 1:45–2:05 | Trade tab → 에이전트: "지난 3년 동안 그냥 보유를 확실히 이긴 에이전트는 없었어요", the default basket card with "그냥 보유" under it | "Moa also has rule-based agents, each shown as money against simply holding. After real costs none clearly beat holding, and the app says so instead of showing a winner." |
| 2:05–2:20 | Ask Moa "BTC 1달러 사줘" → the proposal card → Confirm | "The chat can explain and propose, never trade by itself: an order runs only from this Confirm button." |
| 2:20–2:35 | Trade tab → 스프레드: the pool vs the exchange, net after costs | "On a young chain costs decide the result, so every number includes the pool fee, the gap to the exchange and price impact." |
| 2:35–2:50 | DEX tab → 유동성 공급 전략 → 조금씩 모으기 → the blocks on the chart | "On HSKSwap, Moa also places liquidity in blocks: small positions under the price that buy as it falls and earn the fee." |
| 2:50–3:00 | The vault on the HSK explorer; the README's mainnet table | "The vault, the factory and the trades are on HSK Chain mainnet; the contracts are open and unaudited. Moa: an AI you can read, limit and stop." |

## Shots to have ready

- Moa AI with at least a day of recorded decisions (the log fills by itself, one decision per coin every 4 hours).
- A hired agent. With a fill, My agents shows a real PnL and the trade scene uses it; without one, show the
  decision log and the vault on the explorer and do not claim a trade.
- The explorer pages of the vault and of one trade (from `docs/MAINNET_CHECKLIST.md`).
