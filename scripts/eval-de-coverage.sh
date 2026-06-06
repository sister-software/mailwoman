#!/usr/bin/env bash
# German coverage eval (DE-4/DE-5) — measures whether a model learned German order, and whether US/FR
# regressed (the interference tripwire). Run against the v0.7.2 baseline AND the v0.8.0-german model
# for a before/after. Usage:
#   scripts/eval-de-coverage.sh <model.onnx> <tokenizer.model> <model-card.json>
# Defaults to the v0.7.2 artifacts in /tmp/v072-eval.
set -euo pipefail
MODEL="${1:-/tmp/v072-eval/model.onnx}"
TOK="${2:-/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model}"
CARD="${3:-/tmp/v072-eval/model-card.json}"
WOF=/mnt/playpen/mailwoman-data/wof/admin-global-priority.db
N="node --experimental-strip-types"

echo "##### Model: $MODEL"
echo ""
echo "===== DE-4a: German parser F1 (held-out OA German golden) ====="
$N scripts/eval/per-locale-f1.ts --golden-dir data/eval/external --files openaddresses-de-golden.jsonl \
  --model "$MODEL" --tokenizer "$TOK" --model-card "$CARD" 2>/dev/null | grep -A12 "Per-tag F1"

echo ""
echo "===== DE-4b: US/FR interference tripwire (must stay within ~1pp of baseline) ====="
$N scripts/eval/per-locale-f1.ts --golden-dir data/eval/golden/v0.1.2/dev --files us.jsonl,fr.jsonl \
  --model "$MODEL" --tokenizer "$TOK" --model-card "$CARD" 2>/dev/null | grep -E "^\| (us|fr) "

echo ""
echo "===== DE-5: German resolver eval (--default-country DE) ====="
$N scripts/eval/oa-resolver-eval.ts --eval data/eval/external/openaddresses-de-sample.jsonl --limit 3000 \
  --default-country DE --model "$MODEL" --tokenizer "$TOK" --model-card "$CARD" --wof "$WOF" 2>/dev/null \
  | grep -A6 "Head-to-head"
