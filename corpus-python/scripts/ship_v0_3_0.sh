#!/usr/bin/env bash
# Post-training: eval → ONNX export → int8 quantize → package as v0.3.0.
#
# Same shape as ship_v0_2_0.sh, retargeted at v0.3.0:
#   - Default CONFIG points at the Stage 2 yaml (CRF + label smoothing + venue/street/
#     house_number labels).
#   - Default GOLDEN_DIR moves from v0.1.0 to v0.1.2 (matches what the v0.2.0 eval
#     report was actually run against; v0.1.0 is frozen for historical comparison).
#   - PACKAGE_VERSION + CORPUS_VERSION bumped to 0.3.0.
#   - NOTES updated to describe the CRF / Stage-2 / NAD additions.
#
# Usage:
#   CHECKPOINT=/data/models/checkpoints/stage2/step-050000 ./ship_v0_3_0.sh
#
# Run from corpus-python/.
#
# Output:
#   /data/models/onnx/model-stage2-${STEP}-fp32.onnx
#   /data/models/quantized/model-stage2-${STEP}-int8.onnx
#   packages/neural-weights-{en-us,fr-fr}/{model.onnx,tokenizer.model,model-card.json,...}
#   docs/articles/evals/stage2-step-XXXXX-eval.md

set -euo pipefail

: "${CHECKPOINT:?set CHECKPOINT to the trained-model checkpoint directory}"
CONFIG="${CONFIG:-src/mailwoman_train/configs/stage2.yaml}"
GOLDEN_DIR="${GOLDEN_DIR:-../../data/eval/golden/v0.1.2}"
PACKAGE_VERSION="${PACKAGE_VERSION:-0.3.0}"
CORPUS_VERSION="${CORPUS_VERSION:-0.3.0}"
TOKENIZER_VERSION="${TOKENIZER_VERSION:-0.1.0}"
PACKAGES_ROOT="${PACKAGES_ROOT:-../../packages}"

STEP_NAME=$(basename "$CHECKPOINT")
TRAIN_SECONDS="${TRAIN_SECONDS:-0}"
HARDWARE="${HARDWARE:-AMD Radeon 780M (gfx1103) bf16 ~14.6 GiB GTT}"

ONNX_FP32="/data/models/onnx/model-stage2-${STEP_NAME}-fp32.onnx"
ONNX_INT8="/data/models/quantized/model-stage2-${STEP_NAME}-int8.onnx"

NOTES_DEFAULT="Stage 2 v0.3.0 — same encoder geometry as v0.2.0 (8.87M params, 6L/256H/4-heads) \
plus a linear-chain CRF decoder (+~500 params with a frozen BIO transition mask), label \
smoothing 0.1 on the per-token CE leg, and a 21-label classifier head (was 15) that adds \
venue / street / house_number BIO classes. Trained on corpus-v0.3.0 which adds the US DOT \
NAD source (~97M structured 911-grade address points). The CRF transition mask makes \
orphan-I sequences (e.g. \"Saint Petersburg → Petersburg\" clipping visible on the v0.2.0 \
demo) structurally impossible. See evals/scores-by-version.json for the v0.2.0 → v0.3.0 \
deltas + the per-component F1 on the new fine labels."
NOTES="${NOTES:-$NOTES_DEFAULT}"

mkdir -p /data/models/onnx /data/models/quantized

echo "== Step 1/4: eval against golden set =="
python -m mailwoman_train eval --config "$CONFIG" --checkpoint "$CHECKPOINT" --golden-dir "$GOLDEN_DIR"

EVAL_MD_DST="../../docs/articles/evals/stage2-${STEP_NAME}-eval.md"
mkdir -p "$(dirname "$EVAL_MD_DST")"
cp "$CHECKPOINT/eval-report.md" "$EVAL_MD_DST"
echo "wrote $EVAL_MD_DST"

echo "== Step 2/4: ONNX export =="
python -m mailwoman_train export --config "$CONFIG" --checkpoint "$CHECKPOINT" --output "$ONNX_FP32"

echo "== Step 3/4: int8 quantize =="
python -m mailwoman_train quantize --input "$ONNX_FP32" --output "$ONNX_INT8"

echo "== Step 4/4: package weights =="
python -m mailwoman_train package \
    --config "$CONFIG" \
    --checkpoint "$CHECKPOINT" \
    --int8-model "$ONNX_INT8" \
    --packages-root "$PACKAGES_ROOT" \
    --locales "en-us,fr-fr" \
    --corpus-version "$CORPUS_VERSION" \
    --tokenizer-version "$TOKENIZER_VERSION" \
    --package-version "$PACKAGE_VERSION" \
    --steps "$(jq -r '.step' "$CHECKPOINT/training_state.json")" \
    --hardware "$HARDWARE" \
    --training-duration-seconds "$TRAIN_SECONDS" \
    --notes "$NOTES" \
    --golden-dir "$GOLDEN_DIR"

echo
echo "v0.3.0 shipping artifacts ready under $PACKAGES_ROOT/neural-weights-{en-us,fr-fr}"
