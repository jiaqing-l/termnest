#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
npm ci --no-audit --no-fund
npm run prepare:desktop
npm ci --prefix desktop --no-audit --no-fund
cd desktop
# Skip Finder cosmetic automation, as in the GitHub runner.
export CI=true
export CARGO_BUILD_JOBS=2
npm run build -- --bundles dmg --ci -- --locked
case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
dmgs=(target/release/bundle/dmg/Termnest_*.dmg)
test "${#dmgs[@]}" -eq 1 && test -f "${dmgs[0]}"
mkdir -p "$ROOT/packaging/out"
cp "${dmgs[0]}" "$ROOT/packaging/out/Termnest-$ARCH.dmg"
node "$ROOT/packaging/check-payload.js" resources "$ROOT/packaging/out/Termnest-$ARCH.dmg"
