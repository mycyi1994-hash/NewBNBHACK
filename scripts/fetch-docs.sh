#!/usr/bin/env bash
# Fetch the official documentation the organizers told us to feed to the agent.
# Output goes to docs/vendor/ (gitignored, except ENDPOINTS.md). Run from anywhere.
#
# The docs host sits behind an AWS WAF JavaScript challenge. From some networks a plain curl
# gets `HTTP 202`, `x-amzn-waf-action: challenge` and an EMPTY body — and `curl -f` treats that
# as success (see dx/LOG.md, 2026-09-23). Every download is therefore validated, and on failure
# we fall back to scripts/fetch-docs-browser.mjs, which loads the file in headless Chromium so
# the challenge script can run the way it does in a normal browser.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/docs/vendor"
DOCS_BASE="https://web3.binance.com/en/dev-docs"
SKILLS_HUB="https://github.com/binance/binance-skills-hub"
mkdir -p "$VENDOR"

# A valid download is non-empty Markdown (starts with '#'), not an HTML or challenge page.
is_markdown() { [ -s "$1" ] && [ "$(head -c 1 "$1")" = "#" ]; }

fetch_doc() {
  local name=$1
  local url="$DOCS_BASE/$name" out="$VENDOR/$name" tmp="$VENDOR/.$name.part"
  local status
  status=$(curl -sS -L -o "$tmp" -w '%{http_code}' "$url" || echo "000")
  if [ "$status" = "200" ] && is_markdown "$tmp"; then
    mv "$tmp" "$out"
    echo "curl    $name: HTTP 200"
    return
  fi
  echo "curl    $name: HTTP $status, $(wc -c <"$tmp" 2>/dev/null || echo 0) bytes -> headless browser fallback"
  rm -f "$tmp"
  node "$ROOT/scripts/fetch-docs-browser.mjs" "$url" "$tmp"
  if ! is_markdown "$tmp"; then
    echo "FAILED: $name is empty or not Markdown after browser fallback" >&2
    rm -f "$tmp"
    exit 1
  fi
  mv "$tmp" "$out"
}

echo "== Binance Web3 API docs (llms.txt / llms-full.txt)"
fetch_doc llms.txt
fetch_doc llms-full.txt
(cd "$VENDOR" && wc -l llms.txt llms-full.txt)

echo "== Binance Skills Hub (official Agentic Wallet skill + tokenized securities skill)"
if [ -d "$VENDOR/binance-skills-hub/.git" ]; then
  git -C "$VENDOR/binance-skills-hub" pull -q --ff-only
else
  git clone -q --depth 1 "$SKILLS_HUB" "$VENDOR/binance-skills-hub"
fi
echo "skills-hub commit: $(git -C "$VENDOR/binance-skills-hub" rev-parse --short HEAD)"
ls "$VENDOR/binance-skills-hub/skills"

cat <<'EOF'

Next:
  1. Read llms-full.txt sections for: RWA Data, General market data, Trading API, Transaction API,
     Wallet API, Address portfolio, DeFi data, DeFi transaction building, b402 payments, Authentication.
  2. Keep docs/vendor/ENDPOINTS.md (committed) in sync and close the ⚠️VERIFY items in docs/DECISIONS.md.
  3. Reference implementation for signing/paths: packages/binance/node_modules/@binance-web3/wallet
     (devDependency of @ijaro/binance) and its dependency @binance-web3/common.
EOF
