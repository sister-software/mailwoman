#!/usr/bin/env bash
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# One-command checkpoint read for the #511 v1.1.0 relabel run: export the given step on Modal,
# download, and score BOTH affix evals (32-row legacy + NAD-native v2) with ship-config channels.
# The 20k read gates stability (pre-registered floors on #511: v2 prefix/suffix F1 >= 85, P >= 95);
# the 40k read feeds the full v4.2.0-ship gate battery (promotion-gate.sh) on top.
#
# Usage: scripts/eval/read-relabel-checkpoint.sh 020000   (zero-padded step)
set -euo pipefail
STEP="${1:?usage: read-relabel-checkpoint.sh <zero-padded-step, e.g. 020000>}"
OUT_DIR="/data/output-v110-relabel-s42"
LOCAL="/tmp/v110-relabel-${STEP}.onnx"

echo "== export step-${STEP} on Modal =="
modal run scripts/modal/train_remote.py::export_onnx --output-dir="$OUT_DIR" --step="$STEP" 2>&1 | tail -2
modal volume get mailwoman-training "${OUT_DIR#/data/}/model.onnx" "$LOCAL" --force 2>&1 | tail -1

for EVAL in data/eval/external/street-affix-real.jsonl data/eval/external/street-affix-real-v2.jsonl; do
	echo ""
	echo "== score-affix · $(basename "$EVAL") =="
	node --experimental-strip-types scripts/eval/score-affix.ts \
		--model "$LOCAL" --file "$EVAL" \
		--gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json \
		--suppress-gaz-near-postcode 2>/dev/null | sed -n 1,9p
done
echo ""
echo "model: $LOCAL (keep for the fp32-to-fp32 gate at 40k)"
