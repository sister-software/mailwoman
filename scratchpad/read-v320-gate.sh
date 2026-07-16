#!/usr/bin/env bash
# Read the v3.2.0-fragment-span gate (#1143) — THE DECIDING RUN for the span head.
# Run AFTER training reaches step-008000.
#
# Every clause below is pre-registered in the config header (v3.2.0-fragment-span.yaml) and was
# written before any number existed. This script produces the readings; it decides nothing.
#
#   1. PARIS KILL SHOT : seg@1 must beat v310's token@1 = 56/63 (0.889). The bar the flag FAILED by
#                        12.7pp. A shard-trained span head that cannot beat a shard-trained PLAIN
#                        decode on the target class has no case at any weight.
#   2. HALLUCINATION   : the 54 street-free parity rows must fall from v301-span's 0.352 toward
#                        v264's 0.222 (T1a's falsifier). Direction is the read — the rate was never
#                        established at n=54 (McNemar p=0.12).
#   3. WITHIN-MODEL    : seg@1 must beat THIS model's own token@1 by more than v301's honest +0.38pp.
#   4. GUARD           : the fragment board's 7 cells vs V310, not v264.
#   5. GUARD           : v6.0.0-shipped-baseline. v310's tightest margin is arena.perturb 79 vs
#                        floor 78 — a span head could push it under, and now the floor catches it.
#
# IF 1 FAILS: the span head is DONE. Close it. Do NOT tune span_loss_weight and re-run — that is the
# treadmill the arc's own guard forbids.
#
# Usage:  bash scratchpad/read-v320-gate.sh [STEP]     (default 008000, ZERO-PADDED)
set -euo pipefail

STEP="${1:-008000}"   # zero-padded: export builds `checkpoints/step-{step}` by interpolation
OUT_DIR="/data/output-v320-fragment-span-s42"
TOKENIZER="/data/models/tokenizer/v0.9.0-multisplice/tokenizer.model"
CACHE="scratchpad/v320-cache"
PKG="$CACHE/node_modules/@mailwoman/neural-weights-en-us"
BASE="scratchpad/v264-cache/node_modules/@mailwoman/neural-weights-en-us"

echo "### 1. export -> quantize (both on Modal)"
# int8, because every baseline is int8. An fp32 candidate vs int8 baselines attributes the
# QUANTIZATION delta to the model — the gate spec caps that at 1.5pp, larger than cells we read here.
# export_onnx AUTO-DETECTS the span head (has_spans = use_span_scorer), so span_scores ship.
modal run corpus-python/modal/train_remote.py::export_onnx \
	--output-dir="$OUT_DIR" --step="$STEP" --tokenizer-path="$TOKENIZER"
modal run corpus-python/modal/train_remote.py::quantize_onnx \
	--fp32-path="$OUT_DIR/model.onnx" --int8-path="$OUT_DIR/model-int8.onnx"

echo
echo "### 2. package-shaped cache + the semi-crf sidecar"
# THE SIDECAR IS NOT OPTIONAL AND NOTHING IN THE PIPELINE MAKES IT. The JS decode needs the
# transition table + the segment_types axis; without it decodeSegmentationsKBest returns nothing and
# the read looks like a failed gate rather than a missing file.
mkdir -p "$PKG"
cp "$BASE"/tokenizer.model "$BASE"/model-card.json "$BASE"/calibration.json \
	"$BASE"/anchor-lexicon-v1.json "$BASE"/country-surface-lexicon-v1.json "$BASE"/postcode-us.bin "$PKG/"
modal volume get mailwoman-training "${OUT_DIR#/data/}/model-int8.onnx" "$PKG/model.onnx" --force
rm -rf /tmp/v320-ckpt
modal volume get mailwoman-training "${OUT_DIR#/data/}/checkpoints/step-$STEP" /tmp/v320-ckpt --force
CK=/tmp/v320-ckpt; [ -d "$CK/step-$STEP" ] && CK="$CK/step-$STEP"
corpus-python/.venv/bin/python scratchpad/make-semi-crf-sidecar.py \
	--checkpoint "$CK" --out "$PKG/semi-crf-transitions.json"

echo
echo "### 3. sanity — differs from v264 AND same precision class"
a=$(md5sum "$BASE/model.onnx" | cut -d' ' -f1); b=$(md5sum "$PKG/model.onnx" | cut -d' ' -f1)
[ "$a" = "$b" ] && { echo "  ✗ IDENTICAL to v264 — wrong checkpoint. STOP."; exit 1; }
echo "  ✓ differs ($b)"
python3 - "$PKG/model.onnx" "$BASE/model.onnx" <<'PYCHECK'
import sys, onnx
q = lambda p: any("Quant" in n.op_type or n.op_type == "MatMulInteger" for n in onnx.load(p, load_external_data=False).graph.node)
c, b = q(sys.argv[1]), q(sys.argv[2])
print(f"  candidate int8: {c}   baseline int8: {b}")
if c != b:
    print("  ✗ PRECISION MISMATCH — the shard's effect would be confounded with quantization. STOP.")
    sys.exit(1)
print("  ✓ same precision class as the baselines")
PYCHECK

echo
echo "### 4. CLAUSE 1 — THE KILL SHOT: Paris seg@1 vs v310's token@1 = 56/63 (0.889)"
node scratchpad/paris-3way.mjs

echo
echo "### 5. CLAUSE 2 + 3 — hallucination, and the within-model margin"
node scratchpad/halluc-v310.mjs

echo
echo "### 6. CLAUSE 4 — the fragment board (compare vs V310, not v264)"
node mailwoman/out/cli.js eval fragment-board --weights-cache "$CACHE" 2>&1 | sed -n '1,14p'

echo
echo "### 7. CLAUSE 5 — the v6 gate"
node mailwoman/out/cli.js eval gate --weights-cache "$CACHE" --gate v6.0.0-shipped-baseline --out-dir /tmp/gate6-v320 2>&1 | grep -E "promotion gate|^  ✗|arena.perturb" | head -8
