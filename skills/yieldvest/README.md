# skills/yieldvest — Yieldvest Wallet Skill

`SKILL.md` + `references/` in the Binance Skills Hub format. The assistant runs Yieldvest plans in the
user's own Binance Agentic Wallet (`baw`): Yieldvest's server decides (`GET /api/plans/{id}/next`), the
wallet signs after the user confirms, and each transaction is reported back and checked on-chain.

## Install (Claude Code)

Requires the `binance-agentic-wallet` skill and `baw` (`npm i -g @binance/agentic-wallet`), plus
`curl` and `jq`.

```bash
npx skills add mycyi1994-hash/NewBNBHACK --skill yieldvest -g -a claude-code -y
export YIELDVEST_URL=<the site address from the project README>
```

That is the `skills` CLI the Binance Skills Hub installs with; it copies this folder to
`~/.claude/skills/yieldvest`. Without Node:
`git clone --depth 1 https://github.com/mycyi1994-hash/NewBNBHACK yieldvest-src && mkdir -p ~/.claude/skills && cp -r yieldvest-src/skills/yieldvest ~/.claude/skills/`.

Then say "start Yieldvest". The API contract is at `$YIELDVEST_URL/api/openapi`.
