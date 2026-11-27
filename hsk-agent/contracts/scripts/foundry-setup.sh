#!/bin/sh
# Fetch forge-std (the Foundry test library) at a fixed tag into lib/forge-std, for `forge test`.
# Foundry itself: https://getfoundry.sh (foundryup), or a release binary from github.com/foundry-rs/foundry/releases.
set -e
cd "$(dirname "$0")/.."
if [ -f lib/forge-std/src/Test.sol ]; then echo "lib/forge-std is there"; exit 0; fi
mkdir -p lib
git clone --depth 1 --branch v1.9.4 https://github.com/foundry-rs/forge-std.git lib/forge-std
echo "forge-std v1.9.4 in lib/forge-std"
