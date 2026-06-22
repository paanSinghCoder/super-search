#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/supersearch"
ZIP="$ROOT/dist/supersearch.zip"

node "$ROOT/scripts/build-extension.mjs"

rm -f "$ZIP"
(cd "$OUT" && zip -r "$ZIP" . -x "*.DS_Store")

echo "Zip:   $ZIP"
