#!/usr/bin/env bash
# external-arenas.sh — run the three UNBIASED capability arenas through harness-v0-neural.
#
# Our own 376-assertion suite is a Pelias/addressit port (v0's lineage), so it
# can't reveal where neural earns its keep. These three arenas come from outside
# that lineage and together map the v0-vs-neural capability surface:
#   1. libpostal      — statistical parser's hand-curated adversarial cases (clean, canonical)
#   2. perturbation   — golden v0.1.2 with rule-defeating transforms (noisy, degraded)
#   3. postal-standards — postal-authority example addresses, edge formats by class
#                         (military APO/FPO, PO-box variety, secondary-unit, intl)
#
# All three are scored with --symmetric-match (v0 scored on the same loose subset
# matcher as neural — fair to remapped/dropped-tag cases) and --postcode-repair.
#
# Usage (default shipped weights):
#   scripts/eval/external-arenas.sh
# Against a specific model (e.g. a fresh v0.7.2 export):
#   MODEL=/path/model.int8.onnx TOKENIZER=/path/tokenizer.model \
#     MODELCARD=/path/model-card.json scripts/eval/external-arenas.sh
#
# Emits per-arena three-bucket tables (neural-only / both / v0-only / both-fail)
# and, for the postal arena, a breakdown by edge_class. Run `yarn compile` first
# — the harness resolves @mailwoman/neural to its compiled out/ tree.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT_DIR="${OUT_DIR:-/tmp/external-arenas}"
mkdir -p "$OUT_DIR"
EMPTY_TESTS="$OUT_DIR/empty-tests"
mkdir -p "$EMPTY_TESTS"

# Model args: pass through if MODEL set, else harness uses loadFromWeights() default.
MODEL_ARGS=()
if [[ -n "${MODEL:-}" ]]; then
  MODEL_ARGS=(--model "$MODEL" --tokenizer "$TOKENIZER" --model-card "$MODELCARD")
  # Gaz-trained models (v4.2.0+): feed the ship config — zero-filled clues depress country
  # recall and fake an affix crash. Opt in via GAZETTEER=/path/lexicon.json [ANCHOR=/path/lookup.json].
  if [[ -n "${GAZETTEER:-}" ]]; then
    MODEL_ARGS+=(--gazetteer-lexicon "$GAZETTEER")
  fi
  if [[ -n "${ANCHOR:-}" ]]; then
    MODEL_ARGS+=(--anchor-lookup "$ANCHOR")
  fi
  # Conventions mask (#511 Tier A): CONVENTIONS=auto for v4.3.0+ ship config.
  if [[ -n "${CONVENTIONS:-}" ]]; then
    MODEL_ARGS+=(--conventions "$CONVENTIONS")
  fi
  echo "Model: $MODEL"
else
  echo "Model: (default shipped weights)"
fi

# 1. (re)generate the perturbation arena from golden v0.1.2.
echo "== regenerating perturbation arena =="
node --experimental-strip-types scripts/eval/perturb-golden.ts \
  --golden data/eval/golden/v0.1.2 --out "$OUT_DIR/perturb/perturbed.jsonl" --per-file 60

# Stage each arena in its own dir (harness loads ALL .jsonl in a --falsehoods dir).
mkdir -p "$OUT_DIR/libpostal" "$OUT_DIR/postal"
cp data/eval/external/libpostal-cases.jsonl "$OUT_DIR/libpostal/"
cp data/eval/external/postal-cases.jsonl "$OUT_DIR/postal/"

run_arena() {
  local name="$1" dir="$2"
  echo "== arena: $name =="
  node --experimental-strip-types scripts/harness-v0-neural.ts \
    --tests "$EMPTY_TESTS" --falsehoods "$dir" \
    "${MODEL_ARGS[@]}" \
    --postcode-repair --symmetric-match \
    --out-json "$OUT_DIR/$name.results.json" 2>"$OUT_DIR/$name.stderr" \
    | tail -40
}

run_arena libpostal "$OUT_DIR/libpostal"
run_arena perturb   "$OUT_DIR/perturb"
run_arena postal    "$OUT_DIR/postal"

echo
echo "== three-bucket summary + postal edge-class breakdown =="
python3 scripts/eval/summarize-arenas.py "$OUT_DIR" data/eval/external/postal-cases.jsonl
