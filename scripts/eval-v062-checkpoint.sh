#!/usr/bin/env bash
#
# End-to-end eval for a v0.6.2 training checkpoint.
#
# Pulls a step-N checkpoint from the Modal volume, exports to ONNX, quantizes to int8,
# runs the per-tag eval against the golden set + v0-vs-neural harness, applies the 2D
# eval gate vs v0.6.0 baseline, and emits a verdict.
#
# Usage:
#   ./scripts/eval-v062-checkpoint.sh <STEP>
#   # e.g. ./scripts/eval-v062-checkpoint.sh 20000   (the early-eval gate)
#   #      ./scripts/eval-v062-checkpoint.sh 100000  (the final eval)
#
# Output:
#   /tmp/v062-eval-step-<N>/  containing all intermediate + final artifacts:
#     model.onnx                — exported model (fp32)
#     model-int8.onnx           — quantized model
#     eval-morphology.json      — per-tag eval JSON (gate input)
#     eval-morphology.md        — human-readable per-tag table
#     harness.json              — v0-vs-neural per-assertion results
#     harness.md                — per-locale pass-rate report
#     gate-report.md            — 2D eval-gate verdict
#     verdict.txt               — final PROMOTE / EXPERIMENTAL / HOLD label
#
# Prerequisites:
#   - Modal app for v0.6.2 has reached the requested step (checkpoint must exist on volume)
#   - /tmp/eval-v060-true-baseline.json must exist (v0.6.0 gate baseline)
#   - The Modal export_onnx function in scripts/modal/train_remote.py can be invoked with
#     env overrides for OUTPUT_DIR + STEP

set -euo pipefail

STEP="${1:?missing step number — usage: $0 <STEP> [OUTPUT_DIR_TAG]}"
# Optional second arg: training output dir tag (defaults to 'v062').
# E.g. './scripts/eval-v062-checkpoint.sh 20000 v063' evaluates the v0.6.3 step-20K
# checkpoint at /data/output-v063/checkpoints/step-020000.
TAG="${2:-v062}"
# Training writes checkpoint dirs zero-padded to 6 digits (step-020000, step-100000, ...).
STEP_PADDED=$(printf "%06d" "$STEP")
WORK_DIR="/tmp/${TAG}-eval-step-${STEP}"
BASELINE_JSON="/tmp/eval-v060-true-baseline.json"

if [ ! -f "$BASELINE_JSON" ]; then
  echo "ERROR: v0.6.0 baseline JSON not found at $BASELINE_JSON" >&2
  echo "  Generate it via:" >&2
  echo "  node --experimental-strip-types scripts/eval-morphology-fst.ts \\" >&2
  echo "    --model /mnt/playpen/.../model-v060-step-100000-int8.onnx \\" >&2
  echo "    --tokenizer /mnt/playpen/.../v0.6.0-a0/tokenizer.model \\" >&2
  echo "    --model-card neural-weights-en-us/model-card.json \\" >&2
  echo "    --admin-fst /mnt/playpen/.../fst-en-us.bin --no-morphology \\" >&2
  echo "    --golden data/eval/golden/v0.1.2 --name v0.6.0-default-baseline \\" >&2
  echo "    --out-json $BASELINE_JSON" >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
echo "=== v0.6.2 step ${STEP} eval — work dir $WORK_DIR ==="

# --- 1. Export ONNX on Modal ----------------------------------------------------------------
# Modal volume has the checkpoint at /data/output-v062/checkpoints/step-${STEP}/.
# train_remote.py's export_onnx function reads MAILWOMAN_EXPORT_* env vars to know which
# checkpoint to grab. We use modal run --env to pass them through.
echo "[1/6] Exporting ONNX on Modal (output-${TAG}/checkpoints/step-${STEP_PADDED})..."
modal run scripts/modal/train_remote.py::export_onnx \
  --output-dir=/data/output-${TAG} \
  --step="${STEP_PADDED}" \
  --tokenizer-path=/data/models/tokenizer/v0.6.0-a0/tokenizer.model 2>&1 | tail -5

# --- 2. Pull the exported ONNX + model-card to local ----------------------------------------
echo "[2/6] Downloading ONNX + model-card from Modal volume..."
modal volume get mailwoman-training output-${TAG}/model.onnx "$WORK_DIR/model.onnx" --force 2>&1 | tail -1
# Modal export_onnx doesn't ship a model card; reuse v0.6.0's (Stage 3 labels are identical).
cp neural-weights-en-us/model-card.json "$WORK_DIR/model-card.json"

# --- 3. int8 quantize ---------------------------------------------------------------------
# Optional for the 20K eval (slower fp32 path is fine for diagnostic). Required before the
# 100K release artifact. Skip for now — the eval scripts use fp32 ONNX directly.
echo "[3/6] (skipping int8 quantize — fp32 ONNX is sufficient for eval gate)"

# --- 4. Per-tag eval against golden set ---------------------------------------------------
echo "[4/6] Per-tag eval against golden set..."
node --experimental-strip-types scripts/eval-morphology-fst.ts \
  --model "$WORK_DIR/model.onnx" \
  --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model \
  --model-card "$WORK_DIR/model-card.json" \
  --admin-fst /mnt/playpen/mailwoman-data/wof/fst-per-locale/fst-en-us.bin \
  --golden data/eval/golden/v0.1.2 \
  --stage3-fold \
  --name "${TAG}-step-${STEP}" \
  --out-json "$WORK_DIR/eval-morphology.json" \
  > "$WORK_DIR/eval-morphology.md" 2>&1
tail -20 "$WORK_DIR/eval-morphology.md"

# --- 5. v0-vs-neural harness --------------------------------------------------------------
echo "[5/6] v0-vs-neural harness (376 assertions + 22 falsehoods)..."
node --experimental-strip-types scripts/harness-v0-neural.ts \
  --tests mailwoman/test \
  --falsehoods data/eval/falsehoods \
  --model "$WORK_DIR/model.onnx" \
  --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model \
  --model-card "$WORK_DIR/model-card.json" \
  --admin-fst /mnt/playpen/mailwoman-data/wof/fst-per-locale/fst-en-us.bin \
  --out-json "$WORK_DIR/harness.json" \
  > "$WORK_DIR/harness.md" 2>&1
HARNESS_NEURAL_PCT=$(grep -E "^\| Neural \|" "$WORK_DIR/harness.md" | head -1 | awk -F'|' '{print $4}' | sed 's/[^0-9.]//g')
echo "  Neural harness pass rate: ${HARNESS_NEURAL_PCT}%"

# --- 6. 2D eval gate vs v0.6.0 baseline ---------------------------------------------------
echo "[6/6] 2D eval gate..."
set +e
node --experimental-strip-types scripts/eval-gate.ts \
  --baseline "$BASELINE_JSON" \
  --candidate "$WORK_DIR/eval-morphology.json" \
  --out-md "$WORK_DIR/gate-report.md" \
  > "$WORK_DIR/gate.stdout" 2> "$WORK_DIR/gate.stderr"
GATE_EXIT=$?
set -e
cat "$WORK_DIR/gate.stderr"

# --- Verdict --------------------------------------------------------------------------------
HARNESS_INT=$(echo "$HARNESS_NEURAL_PCT" | awk '{printf "%.0f", $1}')
if [ "$GATE_EXIT" -ne 0 ]; then
  VERDICT="HOLD (gate failed)"
elif [ "$HARNESS_INT" -le 14 ]; then
  VERDICT="HOLD (sidegrade: harness ${HARNESS_NEURAL_PCT}% ≤ v0.6.0's 14.4%)"
elif [ "$HARNESS_INT" -lt 25 ]; then
  VERDICT="EXPERIMENTAL (harness ${HARNESS_NEURAL_PCT}% in 15-24% band)"
else
  VERDICT="PROMOTE (harness ${HARNESS_NEURAL_PCT}% ≥ 25%)"
fi

echo "$VERDICT" | tee "$WORK_DIR/verdict.txt"
echo ""
echo "=== Artifacts in $WORK_DIR ==="
ls -la "$WORK_DIR/"
