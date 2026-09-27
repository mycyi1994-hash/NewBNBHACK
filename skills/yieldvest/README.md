# skills/yieldvest — Yieldvest Wallet Skill

`SKILL.md` + `references/` in the Binance Skills Hub format. The assistant runs Yieldvest plans in the
user's own Binance Agentic Wallet (`baw`): Yieldvest's server decides (`GET /api/plans/{id}/next`), the
wallet signs after the user confirms, and each transaction is reported back and checked on-chain.

## Install (Claude Code)

Requires the `binance-agentic-wallet` skill and `baw` (`npm i -g @binance/agentic-wallet`), plus
`curl` and `jq`.

```bash
git clone --depth 1 https://github.com/mycyi1994-hash/NewBNBHACK yieldvest-src \
  && mkdir -p ~/.claude/skills && cp -r yieldvest-src/skills/yieldvest ~/.claude/skills/
export YIELDVEST_URL=<the site address from the project README>
```

Then say "start Yieldvest" (or "Yieldvest 시작해줘"). The API contract is at `$YIELDVEST_URL/api/openapi`.
