#!/usr/bin/env bash
# Fetch the official documentation the organizers told us to feed to the agent.
# Output goes to docs/vendor/ (gitignored). Run from the repo root.
set -euo pipefail

mkdir -p docs/vendor
cd docs/vendor

echo "== Binance Web3 API docs (llms.txt / llms-full.txt)"
curl -fsSL -o llms.txt https://web3.binance.com/en/dev-docs/llms.txt
curl -fsSL -o llms-full.txt https://web3.binance.com/en/dev-docs/llms-full.txt
wc -l llms.txt llms-full.txt

echo "== Binance Skills Hub (official Agentic Wallet skill + tokenized securities skill)"
if [ -d binance-skills-hub/.git ]; then
  git -C binance-skills-hub pull -q
else
  git clone -q --depth 1 https://github.com/binance/binance-skills-hub binance-skills-hub
fi
ls binance-skills-hub/skills/binance-web3

cat <<'EOF'

Next:
  1. Read llms-full.txt sections for: RWA Data, General market data, Trading API, Transaction API,
     Wallet API, Address portfolio, DeFi data, DeFi transaction building, b402 payments, Authentication.
  2. Write the confirmed paths/params into docs/vendor/ENDPOINTS.md (committed) and close the ⚠️VERIFY
     items in docs/DECISIONS.md.
  3. Reference implementation for signing/paths: node_modules/@binance-web3/wallet (install as devDependency).
EOF
