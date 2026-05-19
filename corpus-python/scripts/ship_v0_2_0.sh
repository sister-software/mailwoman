#!/usr/bin/env bash
# Post-training: eval → ONNX export → int8 quantize → package as v0.2.0.
#
# Usage:
#   CHECKPOINT=/data/models/checkpoints/stage1-coarse/step-050000 ./ship_v0_2_0.sh
#
# Run from packages/corpus-python/.
#
# Output:
#   /data/models/onnx/model-stage1-coarse-fp32.onnx
#   /data/models/quantized/model-stage1-coarse-int8.onnx
#   packages/neural-weights-{en-us,fr-fr}/{model.onnx,tokenizer.model,model-card.json,package.json,README.md}
#   docs/stage1-coarse-step-XXXXX-eval.md (per acceptance criterion in issue #43)

set -euo pipefail

: "${CHECKPOINT:?set CHECKPOINT to the trained-model checkpoint directory}"
CONFIG="${CONFIG:-src/mailwoman_train/configs/stage1-coarse.yaml}"
GOLDEN_DIR="${GOLDEN_DIR:-../../data/eval/golden/v0.1.0}"
PACKAGE_VERSION="${PACKAGE_VERSION:-0.2.0}"
CORPUS_VERSION="${CORPUS_VERSION:-0.2.0}"
TOKENIZER_VERSION="${TOKENIZER_VERSION:-0.1.0}"
PACKAGES_ROOT="${PACKAGES_ROOT:-../../packages}"

STEP_NAME=$(basename "$CHECKPOINT")
TRAIN_SECONDS="${TRAIN_SECONDS:-0}"
HARDWARE="${HARDWARE:-AMD Radeon 780M (gfx1103) bf16 ~14.6 GiB GTT}"

ONNX_FP32="/data/models/onnx/model-stage1-coarse-${STEP_NAME}-fp32.onnx"
ONNX_INT8="/data/models/quantized/model-stage1-coarse-${STEP_NAME}-int8.onnx"

NOTES_DEFAULT="Stage 1 coarse v0.2.0 — same architecture as v0.1.0 (8.87M params, 6L/256H/4-heads), \
trained on the expanded corpus-v0.2.0 (262.7M aligned rows, 6 train sources) with the \
loader rewrite from issue #43 (source-weighted multinomial sampler + relaxed coarse \
filter). The v0.1.0 positional-heuristic overfit was driven by a strict country-tag \
gate that dropped ~94% of v0.2.0 before any source weighting; with the gate relaxed and \
the loader interleaving sources at the row level, the model now sees a fixed mix of \
ban/tiger/nppes/state-tx/wof-admin/wof-postalcode per batch instead of mono-source blocks. \
See evals/scores-by-version.json for the v0.1.0 → v0.2.0 deltas."
NOTES="${NOTES:-$NOTES_DEFAULT}"

mkdir -p /data/models/onnx /data/models/quantized

echo "== Step 1/4: eval against golden set =="
python -m mailwoman_train eval --config "$CONFIG" --checkpoint "$CHECKPOINT" --golden-dir "$GOLDEN_DIR"

EVAL_MD_DST="../../docs/stage1-coarse-${STEP_NAME}-eval.md"
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
echo "v0.2.0 shipping artifacts ready under $PACKAGES_ROOT/neural-weights-{en-us,fr-fr}"
