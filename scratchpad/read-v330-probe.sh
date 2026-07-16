#!/usr/bin/env bash
# Read the v3.3.0-no-fragment 2k probe against board 3 (the NO digit board). Run AFTER step-002000.
#
# Pre-registered (config header + baselines.json profile digit-board-no-v310, registered against
# SHIPPED v310 before this run). This script produces the numbers; it decides nothing.
#
#   MOVE  : bare-street-hn 0.693 rises materially. The falsifier — flat = hypothesis wrong, no 8k.
#   GUARD : bare-pc 1.000 holds (no flipped default); street-led/city-first/pc-first do not regress.
set -euo pipefail

STEP="${1:-002000}"
OUT_DIR="/data/output-v330-no-fragment-probe-s42"
TOKENIZER="/data/models/tokenizer/v0.9.0-multisplice/tokenizer.model"
CACHE="scratchpad/v330-cache"
PKG="$CACHE/node_modules/@mailwoman/neural-weights-en-us"
BASE="scratchpad/v264-cache/node_modules/@mailwoman/neural-weights-en-us"

echo "### 1. export step-$STEP -> ONNX, quantize to int8 (both on Modal)"
modal run corpus-python/modal/train_remote.py::export_onnx \
	--output-dir="$OUT_DIR" --step="$STEP" --tokenizer-path="$TOKENIZER"
modal run corpus-python/modal/train_remote.py::quantize_onnx \
	--fp32-path="$OUT_DIR/model.onnx" --int8-path="$OUT_DIR/model-int8.onnx"

echo
echo "### 2. package-shaped cache (siblings from the shipped v264 package — unchanged by this run)"
mkdir -p "$PKG"
cp "$BASE"/tokenizer.model "$BASE"/model-card.json "$BASE"/calibration.json \
	"$BASE"/anchor-lexicon-v1.json "$BASE"/country-surface-lexicon-v1.json "$BASE"/postcode-us.bin "$PKG/"
modal volume get mailwoman-training "${OUT_DIR#/data/}/model-int8.onnx" "$PKG/model.onnx" --force

echo
echo "### 3. sanity — differs from v310, and is int8"
a=$(md5sum scratchpad/v310-cache/node_modules/@mailwoman/neural-weights-en-us/model.onnx 2>/dev/null | cut -d' ' -f1 || echo none)
b=$(md5sum "$PKG/model.onnx" | cut -d' ' -f1)
echo "  v310 md5: $a"
echo "  v330 md5: $b"
[ "$a" = "$b" ] && { echo "  ✗ IDENTICAL — export did not pick up the new checkpoint. STOP."; exit 1; }
echo "  ✓ differs"

echo
echo "### 4. BOARD 3 — the NO digit board (the read). Compare each cell to the v310 baseline."
node scratchpad/run-digit-board-v330.run.ts 2>&1 | sed -n '/class /,/OVERALL/p'

echo
echo "### 5. GUARD — board 2 (FR fragment) + board 1 (parity) must hold"
node mailwoman/out/cli.js eval fragment-board --weights-cache "$CACHE" 2>&1 | sed -n '/class /,/OVERALL/p'
node mailwoman/out/cli.js eval parity --weights-cache "$CACHE" 2>&1 | tail -5
