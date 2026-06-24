#!/usr/bin/env bash
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# Both-order order-robustness eval harness (S6). Runs a model through the resolver on German addresses
# in BOTH renderings — native German order (the realistic layout) and US/international order (the layout
# our OA de-sample ships) — with the postcode anchor fed and zeroed, plus US + FR for the no-regression
# gate. The German "collapse" was substantially an eval-order artifact (docs/articles/evals/
# 2026-06-06-anchor-pilot.md); this makes native-vs-international a first-class, repeatable measurement
# instead of a one-off. Self-emits every figure (each run writes its own .md), then prints a 2x2 + US/FR
# summary. NOTE: anchor on/off only differs for an anchor-trained (4-input) model; for a plain model both
# columns are identical (the anchor inputs are ignored / absent).
#
# Usage:
#   scripts/eval/de-order-eval.sh \
#     --model /tmp/v092-eval/model.onnx --card /tmp/v092-eval/model-card.json \
#     --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model \
#     --anchor-lookup /mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json \
#     --out /tmp/v092-eval
set -euo pipefail

MODEL="" CARD="" TOK="/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
LOOKUP="/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json" OUT="/tmp/order-eval"
while [ $# -gt 0 ]; do case "$1" in
  --model) MODEL="$2"; shift 2;; --card) CARD="$2"; shift 2;; --tokenizer) TOK="$2"; shift 2;;
  --anchor-lookup) LOOKUP="$2"; shift 2;; --out) OUT="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 1;; esac; done
[ -n "$MODEL" ] && [ -n "$CARD" ] || { echo "need --model and --card" >&2; exit 1; }

mkdir -p "$OUT"
EMPTY="$OUT/empty-anchor.json"; echo '{}' > "$EMPTY"   # zeroed anchor = c=0 identity = "anchor off"
DE_NATIVE="data/eval/external/openaddresses-de-sample-native-order.jsonl"
DE_INTL="data/eval/external/openaddresses-de-sample.jsonl"

# run <eval-jsonl> <anchor-lookup> <default-country> <out-name>
run() {
  node --experimental-strip-types scripts/eval/oa-resolver-eval.ts \
    --eval "$1" --model "$MODEL" --model-card "$CARD" --tokenizer "$TOK" \
    --model-anchor-lookup "$2" --default-country "$3" \
    > "$OUT/$4.md" 2> "$OUT/$4.log" || true
} # || true: oa-resolver-eval exits non-zero on its own internal regression signal even when it wrote
  # a valid report; this is a MEASUREMENT harness (loc() reads the .md), so under `set -e` we must not
  # let that exit code abort the script before the 2x2 summary prints (it false-failed de.native_locality).
# Pull the neural locality-match % out of a result .md (the "| **neural** | XX.X% |" row).
loc() { grep -E '\*\*neural\*\*' "$OUT/$1.md" | grep -oE '[0-9]+\.[0-9]+%' | head -1; }

echo "== DE native, anchor ON =="  ; run "$DE_NATIVE" "$LOOKUP" DE de-native-on
echo "== DE native, anchor OFF ==" ; run "$DE_NATIVE" "$EMPTY"  DE de-native-off
echo "== DE intl,   anchor ON =="  ; run "$DE_INTL"   "$LOOKUP" DE de-intl-on
echo "== DE intl,   anchor OFF ==" ; run "$DE_INTL"   "$EMPTY"  DE de-intl-off
echo "== US (anchor ON) =="        ; run "data/eval/external/openaddresses-us-sample.jsonl" "$LOOKUP" US us-on
echo "== FR (anchor ON) =="        ; run "data/eval/external/openaddresses-fr-sample.jsonl" "$LOOKUP" FR fr-on

echo ""
echo "### Order-robustness 2x2 — DE locality-match (model: $MODEL)"
echo "|            | anchor OFF | anchor ON |"
echo "| ---------- | ---------: | --------: |"
echo "| US order   | $(loc de-intl-off)   | $(loc de-intl-on) |"
echo "| native DE  | $(loc de-native-off) | $(loc de-native-on) |"
echo ""
echo "no-regression: US $(loc us-on) · FR $(loc fr-on)"
