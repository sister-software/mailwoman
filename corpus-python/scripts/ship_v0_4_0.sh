#!/usr/bin/env bash
# Post-training: eval → ONNX export → int8 quantize → package as v0.4.0.
#
# Same shape as ship_v0_3_0.sh, retargeted at v0.4.0 (issue #116):
#   - Default CONFIG points at the v0.4.0 yaml (per-token CRF norm + class-weighted CE
#     + source-weight rebalance).
#   - GOLDEN_DIR stays at v0.1.2 — same eval anchor as v0.3.0 so the macro-F1 deltas
#     are apples-to-apples.
#   - PACKAGE_VERSION + CORPUS_VERSION: package bumps to 0.4.0; corpus stays at 0.3.0
#     (v0.4.0 reuses the v0.3.0 shards — only source weights change).
#   - Output paths use `model-v0_4_0-${STEP}-` instead of `model-stage2-` so the
#     v0.3.0 + v0.4.0 ONNX files don't collide in /data/models/{onnx,quantized}/.
#   - NOTES describes the v0.4.0 levers and the expected coarse-F1 recovery.
#
# Usage:
#   CHECKPOINT=/data/models/checkpoints/v0_4_0/step-005000 ./ship_v0_4_0.sh
#
# Run from corpus-python/.
#
# Output:
#   /data/models/onnx/model-v0_4_0-${STEP}-fp32.onnx
#   /data/models/quantized/model-v0_4_0-${STEP}-int8.onnx
#   packages/neural-weights-{en-us,fr-fr}/{model.onnx,tokenizer.model,model-card.json,...}
#   docs/articles/evals/v0_4_0-${STEP}-eval.md

set -euo pipefail

: "${CHECKPOINT:?set CHECKPOINT to the trained-model checkpoint directory}"
CONFIG="${CONFIG:-src/mailwoman_train/configs/v0_4_0.yaml}"
GOLDEN_DIR="${GOLDEN_DIR:-../data/eval/golden/v0.1.2}"
PACKAGE_VERSION="${PACKAGE_VERSION:-0.4.0}"
# Corpus stays at 0.3.0 — v0.4.0 reuses the shards (only source weights changed).
CORPUS_VERSION="${CORPUS_VERSION:-0.3.0}"
TOKENIZER_VERSION="${TOKENIZER_VERSION:-0.1.0}"
PACKAGES_ROOT="${PACKAGES_ROOT:-..}"

STEP_NAME=$(basename "$CHECKPOINT")
TRAIN_SECONDS="${TRAIN_SECONDS:-0}"
HARDWARE="${HARDWARE:-AMD Radeon 780M (gfx1103) bf16 ~14.6 GiB GTT}"

# v0.4.0 prefix differentiates from stage2 (v0.3.0) outputs in /data/models/.
ONNX_FP32="/data/models/onnx/model-v0_4_0-${STEP_NAME}-fp32.onnx"
ONNX_INT8="/data/models/quantized/model-v0_4_0-${STEP_NAME}-int8.onnx"

NOTES_DEFAULT="v0.4.0 — issue #116. Same encoder geometry as v0.3.0 (8.87M params, \
6L/256H/4-heads, 21 BIO labels, linear-chain CRF). Training-side changes only: \
(1) per-token CRF NLL normalization (sum NLL / total real tokens — self-balances \
against per-token CE, eliminates the crf_loss_weight hand-tuning v0.3.0 went \
through 1.0 → 0.1 → 0.05); (2) class-weighted CE biased toward coarse labels \
(2.0 on country/region/cedex, 1.5 on locality/postcode/etc, 0.5 on \
venue/street/house_number, 1.0 on O) — recovers the v0.3.0 21-label dilution; \
(3) source-weight rebalance — usgov-nad dropped 2.0 → 1.0 (its 411/674 shards = \
61% of corpus shard count already; v0.3.0's 2.0 weight pushed sampled mix to \
~75% NAD), wof-admin + wof-postalcode bumped 1.0 → 2.0. Reuses corpus-v0.3.0 \
(no rebuild). lr back up to 5e-4 (v0.2.0 baseline; v0.3.0's 1.5e-4 was only safe \
because crf_loss_weight=0.05 masked the dual-loss instability the per-token norm \
fixes). See evals/scores-by-version.json for the v0.3.0 → v0.4.0 deltas."
NOTES="${NOTES:-$NOTES_DEFAULT}"

mkdir -p /data/models/onnx /data/models/quantized

echo "== Step 1/4: eval against golden set =="
python -m mailwoman_train eval --config "$CONFIG" --checkpoint "$CHECKPOINT" --golden-dir "$GOLDEN_DIR"

EVAL_MD_DST="../docs/articles/evals/v0_4_0-${STEP_NAME}-eval.md"
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
echo "v0.4.0 shipping artifacts ready under $PACKAGES_ROOT/neural-weights-{en-us,fr-fr}"
