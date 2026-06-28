#!/usr/bin/env bash
# Re-gate runbook for v1.5.0-fr-order (the fr.house_number recovery retrain).
# Generated 2026-06-13 ~04:15 CEST — the retrain is still running; this is the turnkey
# script to run when step 40000 completes.
#
# Usage:
#   bash build-logs/v150-regate-runbook.sh
#
# Steps:
#   1. Export step-40000 checkpoint to ONNX on Modal
#   2. Download ONNX + model card + tokenizer to local
#   3. Run promotion-gate.ts against v0.5.0-bridge.json
#   4. Apply MAILWOMAN_DUMP_MISS_TAG=house_number lens for the FR diagnostic
set -euo pipefail

OUTPUT_DIR="/data/output-v150-fr-order-s42"
CHECKPOINT_STEP="40000"
GATE="scripts/eval/gates/v0.5.0-bridge.json"
LOCAL_DIR="./output-v150-fr-order-s42"
TOKENIZER="/data/models/tokenizer/v0.6.0-a0/tokenizer.model"
TOKENIZER_LOCAL="/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
GAZ="/data/gazetteer/anchor-lexicon-v1.json"
GAZ_LOCAL="data/gazetteer/anchor-lexicon-v1.json"
LK="/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
CARD="neural-weights-en-us/model-card.json"

echo "=== v1.5.0-fr-order re-gate runbook ==="
echo ""

# Step 1: Confirm the checkpoint exists on the volume
echo "--- Step 1: Confirm checkpoint exists ---"
modal volume ls mailwoman-training "${OUTPUT_DIR}/checkpoints/step-${CHECKPOINT_STEP}" 2>&1
echo ""

# Step 2: Export ONNX from the checkpoint
echo "--- Step 2: Export ONNX ---"
modal run scripts/modal/train_remote.py::export_onnx \
  --output-dir="${OUTPUT_DIR}" \
  --step="${CHECKPOINT_STEP}" \
  --tokenizer-path="${TOKENIZER}"
echo ""

# Step 3: Download artifacts locally
echo "--- Step 3: Download artifacts ---"
mkdir -p "${LOCAL_DIR}/checkpoints/step-${CHECKPOINT_STEP}"
modal volume get mailwoman-training "${OUTPUT_DIR}/model.onnx" "${LOCAL_DIR}/"
modal volume get mailwoman-training "${OUTPUT_DIR}/checkpoints/step-${CHECKPOINT_STEP}/config.json" "${LOCAL_DIR}/checkpoints/step-${CHECKPOINT_STEP}/"
echo "ONNX: $(ls -lh ${LOCAL_DIR}/model.onnx)"
echo ""

# Step 4: Run the promotion gate (bridge OFF — the acceptance contract)
echo "--- Step 4: Promotion gate (bridge OFF) ---"
node --experimental-strip-types scripts/eval/promotion-gate.ts \
  --model "${LOCAL_DIR}/model.onnx" \
  --gate "${GATE}" \
  --tokenizer "${TOKENIZER_LOCAL}" \
  --card "${CARD}" \
  --gazetteer-lexicon "${GAZ_LOCAL}" \
  --out-dir "/tmp/gate-v150-fr-order"
echo ""

# Step 5: FR house_number diagnostic — dump misses to confirm reversed-order is fixed
echo "--- Step 5: FR house_number miss diagnostic ---"
MAILWOMAN_DUMP_MISS_TAG=house_number \
  node --experimental-strip-types scripts/eval/per-locale-f1.ts \
    --golden-dir data/eval/golden/v0.1.2 \
    --files fr.jsonl \
    --model "${LOCAL_DIR}/model.onnx" \
    --tokenizer "${TOKENIZER_LOCAL}" \
    --model-card "${CARD}" \
    --gazetteer-lexicon "${GAZ_LOCAL}" \
    --suppress-gaz-near-postcode \
    --conventions auto
echo ""

echo "=== Re-gate complete ==="
echo "Verdict: /tmp/gate-v150-fr-order/verdict.json"
echo "Per-tag table: /tmp/gate-v150-fr-order/per-locale-f1.md"
