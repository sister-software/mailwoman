#!/usr/bin/env bash
# v07-calibration-gate.sh — run the v0.7 #31 calibration gate eval.
#
# Given the calibration model's exported ONNX, runs the three gate measurements
# against the held-out TEST split and the assertion harness, so the decision
# tree can be applied:
#
#   harness pass rate improves AND overconfidence drops  -> ship calibration
#   flat                                                 -> pivot to structural
#
# v0.6.0 baselines (captured this shift, for comparison):
#   - harness pass rate:        14.6% (no repair) / 15.2% (+repair)
#   - postcode-only harness:    75.9% / 80.2% (+repair)
#   - per-tag recall on TEST:   locality 36.9%, region 66.6%, street 30.1%,
#                               postcode 74.8%, house_number 77.7%, venue 33.9%
#   - structurally valid:       97.6%
#   - overconfidence-on-wrong:  85.5% of wrong predictions made at >=0.9 conf
#                               (1712/2003 on TEST; plan target after calib ~50%)
#
# Usage:
#   scripts/eval/v07-calibration-gate.sh <calib-model.onnx> [out-dir]
set -euo pipefail

CALIB="${1:?usage: v07-calibration-gate.sh <calib-model.onnx> [out-dir]}"
OUT="${2:-/tmp/v07-gate}"
mkdir -p "$OUT"

TOK=/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model
CARD=neural-weights-en-us/model-card.json
V060=/mnt/playpen/mailwoman-data/models/quantized/model-v060-step-100000-int8.onnx
STRIP="node --experimental-strip-types"

echo "### 1/4 — per-tag recall on held-out TEST (calibration)"
$STRIP scripts/eval-error-analysis.ts --golden data/eval/golden/v0.1.2/test \
  --model "$CALIB" --tokenizer "$TOK" --model-card "$CARD" > "$OUT/calib-test-pertag.md"
grep -A14 "Per-tag breakdown" "$OUT/calib-test-pertag.md" | head -16

echo "### 2/4 — harness pass rate (calibration, no repair)"
$STRIP scripts/harness-v0-neural.ts --tests mailwoman/test \
  --model "$CALIB" --tokenizer "$TOK" --model-card "$CARD" \
  --out-json "$OUT/calib-harness.json" 2>/dev/null | grep -iE "^\| (Neural|v0 )"

echo "### 3/4 — harness pass rate (calibration + postcode repair)"
$STRIP scripts/harness-v0-neural.ts --tests mailwoman/test \
  --model "$CALIB" --tokenizer "$TOK" --model-card "$CARD" --postcode-repair \
  --out-json "$OUT/calib-harness-repair.json" 2>/dev/null | grep -iE "^\| (Neural|v0 )"

echo "### 4/4 — overconfidence: v0.6.0 vs calibration (probe-confidence on TEST)"
$STRIP scripts/probe-confidence.ts \
  --model-a "$V060" --name-a v0.6.0 \
  --model-b "$CALIB" --name-b v0.7.0-calib \
  --tokenizer "$TOK" --model-card "$CARD" \
  --golden data/eval/golden/v0.1.2/test --limit 2000 2>/dev/null | tail -40

echo
echo "Gate artifacts written to $OUT/. Apply the decision tree on the numbers above."
