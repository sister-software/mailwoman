#!/usr/bin/env bash
#
# Full v0.7.2 eval — the intersection-retrain release gate.
#
# v0.7.2 = v0.6.0 base + synth-intersection @ 0.2 in BARE format (no ", City, ST"
# tail) + "@" connector, to fix the "learned intersections but only in the trained
# format" finding from v0.7.1. Goal: harness ≥25% (PROMOTE) AND intersections
# 4/65 → most-of-65, with no per-tag regression >2pp vs v0.6.0.
#
# Steps: export 100K → harness (primary + intersection breakdown) → three external
# arenas (capability map + postal third arena) → unit-repair delta on postal →
# per-tag gate vs v0.6.0 → verdict.
#
# Run on the eval/v072-integration branch (has external-arenas.sh + --unit-repair),
# after `yarn compile`. Tokenizer is v0.6.0-a0 (consistent with v0.6.0 → F1 valid).
set -uo pipefail
cd "$(dirname "$0")/.."

STEP=100000
STEP_PADDED=$(printf "%06d" "$STEP")
OUT_DIR=/data/output-v072-intersection
W=/tmp/v072-eval
TOK=/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model
FST=/mnt/playpen/mailwoman-data/wof/fst-per-locale/fst-en-us.bin
BASELINE_JSON=/tmp/eval-v060-true-baseline.json
mkdir -p "$W"

echo "=========== [1/6] export 100K → ONNX (Modal) ==========="
modal run scripts/modal/train_remote.py::export_onnx \
  --output-dir="$OUT_DIR" --step="$STEP_PADDED" \
  --tokenizer-path=/data/models/tokenizer/v0.6.0-a0/tokenizer.model 2>&1 | tail -4

echo "=========== [2/6] download ONNX + model-card ==========="
modal volume get mailwoman-training output-v072-intersection/model.onnx "$W/model.onnx" --force 2>&1 | tail -1
cp neural-weights-en-us/model-card.json "$W/model-card.json"
ls -la "$W/model.onnx"

echo "=========== [3/6] harness (PRIMARY) + intersection breakdown ==========="
node --experimental-strip-types scripts/harness-v0-neural.ts \
  --tests mailwoman/test --falsehoods data/eval/falsehoods \
  --model "$W/model.onnx" --tokenizer "$TOK" --model-card "$W/model-card.json" \
  --admin-fst "$FST" --postcode-repair \
  --out-json "$W/harness.json" > "$W/harness.md" 2>"$W/harness.stderr"
echo "--- overall (with postcode-repair) ---"
grep -E "^\| (Neural|v0|Both|Neural-only|Neural tree)" "$W/harness.md" | head -8
echo "--- intersection.test.ts per-file ---"
grep -iE "intersection" "$W/harness.md" | head -5

echo "=========== [4/6] three external arenas (capability map + postal) ==========="
MODEL="$W/model.onnx" TOKENIZER="$TOK" MODELCARD="$W/model-card.json" \
  OUT_DIR=/tmp/external-arenas-v072 \
  scripts/eval/external-arenas.sh 2>&1 | tail -25

echo "=========== [5/6] unit-repair delta on postal arena ==========="
node --experimental-strip-types scripts/harness-v0-neural.ts \
  --tests /tmp/external-arenas-v072/empty-tests --falsehoods /tmp/external-arenas-v072/postal \
  --model "$W/model.onnx" --tokenizer "$TOK" --model-card "$W/model-card.json" \
  --postcode-repair --unit-repair --symmetric-match \
  --out-json "$W/postal-unitrepair.json" > "$W/postal-unitrepair.md" 2>/dev/null
python3 - "$W" <<'PY'
import json, sys
W = sys.argv[1]
base = json.load(open(f"/tmp/external-arenas-v072/postal.results.json"))
ur   = json.load(open(f"{W}/postal-unitrepair.json"))
def npass(r): return sum(1 for x in r if x["neural_pass"])
print(f"postal neural pass: {npass(base)}/{len(base)} (no unit-repair) → {npass(ur)}/{len(ur)} (+unit-repair)")
# secondary-unit class delta
ec = {json.loads(l)["input"]: json.loads(l).get("edge_class") for l in open("data/eval/external/postal-cases.jsonl")}
def su(r): return sum(1 for x in r if ec.get(x["input"])=="secondary-unit" and x["neural_pass"])
nsu = sum(1 for x in base if ec.get(x["input"])=="secondary-unit")
print(f"  secondary-unit: {su(base)}/{nsu} → {su(ur)}/{nsu}")
PY

echo "=========== [6/6] per-tag gate vs v0.6.0 ==========="
node --experimental-strip-types scripts/eval-morphology-fst.ts \
  --model "$W/model.onnx" --tokenizer "$TOK" --model-card "$W/model-card.json" \
  --admin-fst "$FST" --golden data/eval/golden/v0.1.2 --stage3-fold \
  --name v072-step-100000 --out-json "$W/eval-morphology.json" > "$W/eval-morphology.md" 2>&1
if [ -f "$BASELINE_JSON" ]; then
  node --experimental-strip-types scripts/eval-gate.ts \
    --baseline "$BASELINE_JSON" --candidate "$W/eval-morphology.json" \
    --out-md "$W/gate-report.md" 2>&1 | tail -15
else
  echo "(no v0.6.0 baseline JSON — per-tag gate skipped; see $W/eval-morphology.md)"
  tail -25 "$W/eval-morphology.md"
fi

echo "=========== DONE — artifacts in $W ==========="
