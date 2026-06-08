#!/usr/bin/env bash
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# Honest-eval harness (#371 leakage-free geographic split + #373 PIP-containment).
#
# The yardstick the rest of the roadmap is graded on. Random OA evaluation flatters us:
# the model trains on a corpus that COVERS the same streets OA tests, and the legacy
# locality NAME-match metric is blind to picking the right name in the WRONG place. This
# harness measures only the LEAKAGE-FREE slice (OA rows in corpus-held-out geography the
# model never trained on) and reports the NON-GAMEABLE coordinate truth: region-match,
# coordinate error (p50/p90), and PIP-containment (gold OA point inside the resolved WOF
# polygon) — the last reported WITH a polygon-coverage denominator, since WOF point-geometry
# localities can never PIP-contain and would otherwise count as silent failures.
#
# Per DeepSeek (2026-06-08): lead the scorecard with region-match + coord p50/p90 (100%
# checkable, transparent to polygon coverage); treat locality-PIP as a coverage-adjusted
# secondary. See docs/articles/evals/2026-06-08-honest-eval.md.
#
# Held-out slices (corpus SPLIT_MANIFEST defaultHoldouts): US = VT/WY/ND, FR = Corse/
# Lozère/Creuse. Only US/VT clears the 1000-row trust floor in the current samples (FR
# held-out départements = 16 rows; DE has no manifest holdout). Abort/de-risk per the plan:
# a held-out slice below 1000 rows is reported as UNTRUSTED, not scored.
#
# Usage:
#   scripts/eval/honest-eval.sh \
#     [--model neural-weights-en-us/model.onnx] [--card neural-weights-en-us/model-card.json] \
#     [--tokenizer ...] \
#     [--wof <admin.db>,<postcode.db>]   # DB under test (default: canonical)
#     [--label fixed]                    # a tag for the report
#     [--out docs/articles/evals/2026-06-08-honest-eval.md]
#     [--tmp /tmp/honest]
set -euo pipefail

MODEL="neural-weights-en-us/model.onnx"
CARD="neural-weights-en-us/model-card.json"
TOK="neural-weights-en-us/tokenizer.model"
WOF_DEFAULT="/mnt/playpen/mailwoman-data/wof/admin-global-priority.db,/mnt/playpen/mailwoman-data/wof/postcode-locality-intl.db"
WOF="$WOF_DEFAULT"
LABEL="run"
OUT=""
TMP="/tmp/honest"
while [ $# -gt 0 ]; do case "$1" in
  --model) MODEL="$2"; shift 2;; --card) CARD="$2"; shift 2;; --tokenizer) TOK="$2"; shift 2;;
  --wof) WOF="$2"; shift 2;; --label) LABEL="$2"; shift 2;; --out) OUT="$2"; shift 2;;
  --tmp) TMP="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 1;; esac; done

mkdir -p "$TMP"
US_SAMPLE="data/eval/external/openaddresses-us-sample.jsonl"
US_HELD_REGIONS="VT WY ND"   # corpus defaultHoldouts() for US
TRUST_FLOOR=1000

# --- build the US held-out slice (leakage-free: never in training) ---
US_SLICE="$TMP/us-heldout.jsonl"
: > "$US_SLICE"
for st in $US_HELD_REGIONS; do
  jq -c --arg st "$st" 'select((.state|ascii_upcase) == $st)' "$US_SAMPLE" >> "$US_SLICE" || true
done
US_N=$(wc -l < "$US_SLICE" | tr -d ' ')
echo "US held-out slice (${US_HELD_REGIONS// /\/}): $US_N rows" >&2

# run_locale <name> <slice.jsonl> <default-country> <out-tag>
# echoes a TSV: name n regionMatch localityMatch coordP50 coordP90 pipAll pipPoly polyCov
run_locale() {
  local name="$1" slice="$2" cc="$3" tag="$4"
  local n; n=$(wc -l < "$slice" | tr -d ' ')
  if [ "$n" -lt "$TRUST_FLOOR" ]; then
    echo -e "${name}\t${n}\tUNTRUSTED\t-\t-\t-\t-\t-\t-"
    return
  fi
  node --experimental-strip-types scripts/eval/oa-resolver-eval.ts \
    --eval "$slice" --model "$MODEL" --model-card "$CARD" --tokenizer "$TOK" \
    --wof "$WOF" --default-country "$cc" \
    --out-resolved "$TMP/$tag.json" > "$TMP/$tag.eval.md" 2> "$TMP/$tag.log"
  # neural row: | **neural** | loc% | reg% | resolved% | p50 | p90 | p99 |
  local row; row=$(grep -E "^\| \*\*neural\*\* \|" "$TMP/$tag.eval.md" | head -1)
  local loc reg p50 p90
  loc=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$3); print $3}')
  reg=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$4); print $4}')
  p50=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$6); print $6}')
  p90=$(echo "$row" | awk -F'|' '{gsub(/ /,"",$7); print $7}')
  python3 scripts/eval/pip-containment.py "$TMP/$tag.json" --label "$name" --json "$TMP/$tag.pip.json" > "$TMP/$tag.pip.txt" 2>/dev/null || true
  local pipAll pipPoly polyCov
  pipAll=$(jq -r '(.pip_all*100|.*10|round/10) // "-"' "$TMP/$tag.pip.json" 2>/dev/null)
  pipPoly=$(jq -r '(.pip_poly*100|.*10|round/10) // "-"' "$TMP/$tag.pip.json" 2>/dev/null)
  polyCov=$(jq -r '(.poly_coverage*100|.*10|round/10) // "-"' "$TMP/$tag.pip.json" 2>/dev/null)
  echo -e "${name}\t${n}\t${reg}\t${loc}\t${p50}\t${p90}\t${pipAll}%\t${pipPoly}%\t${polyCov}%"
}

echo "== honest eval (label=$LABEL, wof=$WOF) ==" >&2
US_ROW=$(run_locale "US/VT held-out" "$US_SLICE" "US" "honest-us-$LABEL")

# --- emit the per-locale table ---
emit() {
  echo "### Honest-eval scorecard — label: \`$LABEL\`"
  echo ""
  echo "WOF: \`$WOF\`"
  echo ""
  echo "| locale (held-out) | n | region-match | locality-name-match | coord p50 km | coord p90 km | locality-PIP (all) | locality-PIP (coverage-adj) | polygon-coverage |"
  echo "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  echo "$US_ROW" | awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s | %s | %s | %s |\n",$1,$2,$3,$4,$5,$6,$7,$8,$9}'
  echo "| FR/Corse·Lozère·Creuse | 16 | UNTRUSTED (< $TRUST_FLOOR-row floor) | — | — | — | — | — | — |"
  echo "| DE | — | no manifest holdout (needs a DE-holdout retrain) | — | — | — | — | — | — |"
  echo ""
  echo "_Headline metrics (per DeepSeek): region-match + coord p50/p90. locality-PIP is reported with a polygon-coverage denominator because WOF point-geometry localities can't PIP-contain._"
}

if [ -n "$OUT" ]; then emit > "$OUT"; echo "wrote → $OUT" >&2; else emit; fi
