#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/supersearch"
ZIP="$ROOT/dist/supersearch.zip"

rm -rf "$OUT"
mkdir -p "$OUT/icons"

cp "$ROOT/manifest.json" \
   "$ROOT/background.js" \
   "$ROOT/content.js" \
   "$ROOT/content.css" \
   "$ROOT/options.html" \
   "$ROOT/options.js" \
   "$OUT/"

cp "$ROOT/icons/"*.png "$OUT/icons/"

rm -f "$ZIP"
(cd "$OUT" && zip -r "$ZIP" . -x "*.DS_Store")

echo "Built: $OUT"
echo "Zip:   $ZIP"
