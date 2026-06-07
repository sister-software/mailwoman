#!/usr/bin/env bash
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# PIP-containment 2×2 for German (#327/#386, the honest-metric companion to de-order-eval.sh). The
# name-match DE metric is misleading: it fails when WOF's canonical name drops OA's regional suffix
# ("Plauen Vogtl" -> "Plauen") even though the resolve is geographically correct. This harness re-scores
# the SAME native/international × anchor-on/off cells by PIP-containment (gold OA point inside the resolved
# WOF polygon — non-gameable), via oa-resolver-eval --out-resolved + pip-containment.py. The v0.9.4 finding:
# intl name 43.7% but PIP 56.1%; Saxony name 51.1% but PIP 75.9% (+24.8pp artifact). Use this, not name-match.
#
# Usage:
#   scripts/eval/de-pip-eval.sh --model /tmp/v094-eval/model.onnx --card neural-weights-en-us/model-card.json \
#     [--tokenizer ...] [--anchor-lookup ...] [--out /tmp/de-pip]
set -euo pipefail

MODEL="" CARD="" TOK="/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
LOOKUP="/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json" OUT="/tmp/de-pip"
while [ $# -gt 0 ]; do case "$1" in
  --model) MODEL="$2"; shift 2;; --card) CARD="$2"; shift 2;; --tokenizer) TOK="$2"; shift 2;;
  --anchor-lookup) LOOKUP="$2"; shift 2;; --out) OUT="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 1;; esac; done
[ -n "$MODEL" ] && [ -n "$CARD" ] || { echo "need --model and --card" >&2; exit 1; }

mkdir -p "$OUT"
EMPTY="$OUT/empty-anchor.json"; echo '{}' > "$EMPTY"
DE_NATIVE="data/eval/external/openaddresses-de-sample-native-order.jsonl"
DE_INTL="data/eval/external/openaddresses-de-sample.jsonl"

# dump <eval-jsonl> <anchor-lookup> <out-name>
dump() {
  node --experimental-strip-types scripts/eval/oa-resolver-eval.ts \
    --eval "$1" --model "$MODEL" --model-card "$CARD" --tokenizer "$TOK" \
    --model-anchor-lookup "$2" --default-country DE \
    --out-resolved "$OUT/$3.json" > "$OUT/$3.eval.md" 2> "$OUT/$3.log"
}
# pip <out-name> -> prints the OVERALL PIP line
pip() { python3 scripts/eval/pip-containment.py "$OUT/$1.json" 2>/dev/null | grep OVERALL; }

echo "== dumping resolved (native on/off, intl on/off) =="
dump "$DE_NATIVE" "$LOOKUP" native-on
dump "$DE_NATIVE" "$EMPTY"  native-off
dump "$DE_INTL"   "$LOOKUP" intl-on
dump "$DE_INTL"   "$EMPTY"  intl-off

echo ""
echo "### DE PIP-containment 2×2 (model: $MODEL)"
echo "native anchor-ON : $(pip native-on)"
echo "native anchor-OFF: $(pip native-off)"
echo "intl   anchor-ON : $(pip intl-on)"
echo "intl   anchor-OFF: $(pip intl-off)"
echo ""
echo "(per-state name-vs-PIP breakdown: python3 scripts/eval/pip-containment.py $OUT/intl-on.json)"
