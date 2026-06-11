#!/usr/bin/env bash
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# Promotion gate runner (#479) — ONE command that runs the standard eval battery against a
# candidate model, checks every number against a gate-spec CONTRACT, and emits a single
# machine-readable verdict. Exists so promotion gates are ENFORCED, not night-shift
# discipline, and so "why did this model ship?" has a one-file answer.
#
# Usage:
#   scripts/eval/promotion-gate.sh \
#     --model <fp32.onnx> [--int8 <int8.onnx>] \
#     --gate scripts/eval/gates/<spec>.json \
#     [--tokenizer <tokenizer.model>] [--card <model-card.json>] \
#     [--gazetteer-lexicon <lexicon.json>] [--out-dir /tmp/gate-<label>]
#
# Behavior:
#   - Runs: per-locale-f1 (US/FR, tokenizer-enforced), score-affix (+ unit-real),
#     score-country-homograph, de-order-eval, demo-preset-compare. When --int8 is given,
#     re-runs the per-tag battery on the int8 artifact and enforces the fp32↔int8 delta cap.
#   - Collects headline numbers into <out-dir>/verdict.json with per-floor PASS/FAIL.
#   - Exit 0 = every floor met; exit 1 = any miss (CI-able, agent-guardrail-able).
#
# Lore encoded (the traps that bit before — see CONTRIBUTING_MODEL_WORK.mdx):
#   - Tokenizer comparability: the tokenizer path must contain the card's tokenizer_version;
#     refuses to grade otherwise (F1 across tokenizers is meaningless).
#   - Gaz-fed flags: when the gate spec sets requires_gazetteer_lexicon, every scorer gets
#     --gazetteer-lexicon + --suppress-gaz-near-postcode (zero-filled clues fake an affix
#     crash and depress country recall).
#   - Recompile-before-eval: warns when core/ sources are newer than core/out.
#   - foldToComponents: affix floors are graded from score-affix (unfolded), never from
#     per-locale-f1 (whose fold reports 0 even on a perfect split).
set -euo pipefail

MODEL="" INT8="" GATE="" OUT_DIR=""
TOK="/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
CARD="neural-weights-en-us/model-card.json"
GAZ="data/gazetteer/anchor-lexicon-v1.json"
LK="/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"

while [[ $# -gt 0 ]]; do case "$1" in
	--model) MODEL="$2"; shift 2;; --int8) INT8="$2"; shift 2;;
	--gate) GATE="$2"; shift 2;; --tokenizer) TOK="$2"; shift 2;;
	--card) CARD="$2"; shift 2;; --gazetteer-lexicon) GAZ="$2"; shift 2;;
	--out-dir) OUT_DIR="$2"; shift 2;;
	*) echo "unknown arg: $1" >&2; exit 2;;
esac; done

[[ -n "$MODEL" && -n "$GATE" ]] || { echo "✗ --model and --gate required" >&2; exit 2; }
LABEL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$GATE','utf8')).label)")
OUT_DIR="${OUT_DIR:-/tmp/gate-$LABEL-$(date -u +%H%M)}"
mkdir -p "$OUT_DIR"

# --- lore guard: tokenizer comparability -----------------------------------
CARD_TOK=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CARD','utf8')).training.tokenizer_version)")
[[ "$TOK" == *"$CARD_TOK"* ]] || { echo "✗ tokenizer path '$TOK' does not contain card tokenizer_version '$CARD_TOK' — F1 would be incomparable" >&2; exit 2; }

# --- lore guard: recompile-before-eval --------------------------------------
if [[ -d core/out ]] && [[ -n "$(find core -maxdepth 2 -name '*.ts' -newer core/out -print -quit 2>/dev/null)" ]]; then
	echo "⚠ core/ sources newer than core/out — run 'yarn compile' or the harness grades stale code" >&2
fi

GAZ_ARGS=()
if [[ "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$GATE','utf8')).requires_gazetteer_lexicon === true)")" == "true" ]]; then
	GAZ_ARGS=(--gazetteer-lexicon "$GAZ" --suppress-gaz-near-postcode)
fi
# Conventions channel (#511 Tier A): when the gate spec declares requires_conventions, every scorer
# parses with the address-system conventions mask in the declared mode ("auto" = locale-head
# detection). Same contract discipline as the gaz flags — the spec IS the ship config.
CONV_MODE="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$GATE','utf8')).requires_conventions ?? '')")"
if [[ -n "$CONV_MODE" ]]; then
	GAZ_ARGS+=(--conventions "$CONV_MODE")
fi
# Span-bridge channel (v4.4.0 corrective): spec-declared like the conventions mask.
BRIDGE_MODE=""
if [[ "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$GATE','utf8')).requires_bridge === true)")" == "true" ]]; then
	GAZ_ARGS+=(--bridge-gaps)
	BRIDGE_MODE="1"
fi

run_battery() { # $1 = model path, $2 = tag (fp32|int8)
	local m="$1" tag="$2"
	echo "== battery [$tag] $m =="
	node --experimental-strip-types scripts/eval/per-locale-f1.ts --model "$m" --tokenizer "$TOK" \
		--model-card "$CARD" --model-anchor-lookup "$LK" "${GAZ_ARGS[@]}" > "$OUT_DIR/$tag-per-locale.md"
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" "${GAZ_ARGS[@]}" > "$OUT_DIR/$tag-affix.md"
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" \
		--file data/eval/external/unit-real-designators.jsonl "${GAZ_ARGS[@]}" > "$OUT_DIR/$tag-unit.md"
	node --experimental-strip-types scripts/eval/score-country-homograph.ts --model "$m" \
		"${GAZ_ARGS[@]}" --suppress-gaz-near-postcode > "$OUT_DIR/$tag-country.md"
	# v4.4.0 floors: po_box/cedex (the coverage-shard val) + intersections (real TIGER crossings).
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" \
		--file data/eval/external/po-box-cedex-val.jsonl "${GAZ_ARGS[@]}" > "$OUT_DIR/$tag-pobox.md"
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" \
		--file data/eval/external/intersection-real.jsonl "${GAZ_ARGS[@]}" > "$OUT_DIR/$tag-intersection.md"
	# Watch lenses (v4.4.0+, recorded not floored — one release of history before promotion, #488):
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" \
		--file data/eval/external/intersection-golden-vt.jsonl "${GAZ_ARGS[@]}" > "$OUT_DIR/$tag-watch-intersection-vt.md"
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" \
		--file data/eval/external/glue-rows-perturb.jsonl "${GAZ_ARGS[@]}" > "$OUT_DIR/$tag-watch-glue.md"
	scripts/eval/de-order-eval.sh --model "$m" --card "$CARD" --tokenizer "$TOK" \
		--anchor-lookup "$LK" --out "$OUT_DIR/$tag-deorder" > "$OUT_DIR/$tag-deorder.md" 2>&1 || true
}

run_battery "$MODEL" fp32
[[ -n "$INT8" ]] && run_battery "$INT8" int8
node --experimental-strip-types scripts/eval/demo-preset-compare.ts --model-path="${INT8:-$MODEL}" > "$OUT_DIR/presets.md"

# Arena leg (v4.4.0+: arena.perturb is a floor when the spec declares it) — heavy, ship artifact only.
if [[ "$(node -e "console.log('arena.perturb' in (JSON.parse(require('fs').readFileSync('$GATE','utf8')).floors||{}))")" == "true" ]]; then
	MODEL="${INT8:-$MODEL}" TOKENIZER="$TOK" MODELCARD="$CARD" \
		GAZETTEER="$GAZ" ANCHOR="$LK" CONVENTIONS="${CONV_MODE:-}" BRIDGE="${BRIDGE_MODE:-}" \
		OUT_DIR="$OUT_DIR/arenas" scripts/eval/external-arenas.sh > "$OUT_DIR/arenas.md" 2>&1
fi

# --- collect + verify (node does the parsing; bash stays an orchestrator) ---
node --experimental-strip-types scripts/eval/promotion-gate-verdict.ts \
	--gate "$GATE" --out-dir "$OUT_DIR" $( [[ -n "$INT8" ]] && echo --with-int8 )
