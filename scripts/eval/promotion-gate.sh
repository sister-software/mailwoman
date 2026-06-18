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
#   - Demo-cascade smoke (#524): whole-stack parse→reconcile→resolve against the slim hot DB
#     (MAILWOMAN_WOF_HOT_DB or the v4.4.0 stage default). Skips LOUD when the DB is absent;
#     floor key `cascade.demo_smoke` (pass-rate %) for specs that gate on it.
#   - Mask-regression gate (#718): when the spec declares requires_conventions, re-runs the ship
#     artifact mask-off vs mask-on and FAILS the gate if any tag drops >2pp under the mask — the
#     "second lock" beside createScorer's load-time capability delta-gate.
#   - Collects headline numbers into <out-dir>/verdict.json with per-floor PASS/FAIL.
#   - Exit 0 = every floor met AND the mask-regression lock held; exit 1 = any miss.
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
		--model-card "$CARD" --model-anchor-lookup "$LK" "${GAZ_ARGS[@]}" --out-json "$OUT_DIR/$tag-per-locale.json" > "$OUT_DIR/$tag-per-locale.md"
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" "${GAZ_ARGS[@]}" --json "$OUT_DIR/$tag-affix.json" > "$OUT_DIR/$tag-affix.md"
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" \
		--file data/eval/external/unit-real-designators.jsonl "${GAZ_ARGS[@]}" --json "$OUT_DIR/$tag-unit.json" > "$OUT_DIR/$tag-unit.md"
	node --experimental-strip-types scripts/eval/score-country-homograph.ts --model "$m" \
		"${GAZ_ARGS[@]}" --suppress-gaz-near-postcode --json "$OUT_DIR/$tag-country.json" > "$OUT_DIR/$tag-country.md"
	# v4.4.0 floors: po_box/cedex (the coverage-shard val) + intersections (real TIGER crossings).
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" \
		--file data/eval/external/po-box-cedex-val.jsonl "${GAZ_ARGS[@]}" --json "$OUT_DIR/$tag-pobox.json" > "$OUT_DIR/$tag-pobox.md"
	node --experimental-strip-types scripts/eval/score-affix.ts --model "$m" \
		--file data/eval/external/intersection-real.jsonl "${GAZ_ARGS[@]}" --json "$OUT_DIR/$tag-intersection.json" > "$OUT_DIR/$tag-intersection.md"
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

# Demo-cascade smoke (#524): the whole-stack parse→reconcile→resolve pass the per-layer battery
# lacks (the 2026-06-11 lesson: #520/#521/#522 all shipped through green per-layer gates). Runs on
# the ship artifact against the slim hot DB the demo serves. Env-gated like the other
# artifact-dependent legs: skips LOUD when the DB is absent so CI stays green without it — but a
# gate spec that floors `cascade.demo_smoke` will then FAIL on the missing sidecar (by design).
HOT_DB="${MAILWOMAN_WOF_HOT_DB:-/tmp/v440-stage/en-us/v4.4.0/wof-hot.db}"
HOT_STAGE="$(dirname "$HOT_DB")"
if [[ -f "$HOT_DB" ]]; then
	node --experimental-strip-types scripts/eval/demo-cascade-smoke.ts \
		--db "$HOT_DB" --stage-dir "$HOT_STAGE" --model "${INT8:-$MODEL}" --tokenizer "$TOK" --card "$CARD" \
		--gazetteer-lexicon "$GAZ" --json "$OUT_DIR/cascade-smoke.json" > "$OUT_DIR/cascade-smoke.md" \
		|| echo "✗ demo-cascade smoke errored (see $OUT_DIR/cascade-smoke.md) — no sidecar; a floored gate spec will FAIL" >&2
else
	echo "⚠ demo-cascade smoke SKIPPED — no wof-hot.db at $HOT_DB (set MAILWOMAN_WOF_HOT_DB). The whole-stack lens did NOT run (#524)." | tee "$OUT_DIR/cascade-smoke.md" >&2
fi

# Arena leg (v4.4.0+: arena.perturb is a floor when the spec declares it) — heavy, ship artifact only.
if [[ "$(node -e "console.log('arena.perturb' in (JSON.parse(require('fs').readFileSync('$GATE','utf8')).floors||{}))")" == "true" ]]; then
	# (Historical note: the compiled v0 arena parser used to ENOENT on libpostal dicts because
	# repo.ts's __isCompiledTree detection landed CorePackageAbsolutePath at core/out, so dict reads
	# went to core/out/data/... while the data lives at core/data/.... A local core/out/data symlink
	# bridged the gap. #481 fixed the detection — the compiled tree now reads core/data directly — so
	# no bridge is needed here anymore.)
	MODEL="${INT8:-$MODEL}" TOKENIZER="$TOK" MODELCARD="$CARD" \
		GAZETTEER="$GAZ" ANCHOR="$LK" CONVENTIONS="${CONV_MODE:-}" BRIDGE="${BRIDGE_MODE:-}" \
		OUT_DIR="$OUT_DIR/arenas" scripts/eval/external-arenas.sh > "$OUT_DIR/arenas.md" 2>&1
fi

# --- mask-regression gate (#718) — the "second lock" ------------------------
# Re-runs the SHIP artifact mask-off vs the declared conventions mode and FAILS if any tag's UNFOLDED
# F1 drops >2pp under the mask — a finer net than createScorer's load-time 5pp delta-gate (it catches
# INDIRECT mask harms, e.g. forbidding street_suffix depressing street). Weight-dependent, so it lives
# on the release path here, NOT Test CI (#582). Only meaningful when the spec declares a conventions
# mask; skipped = PASS otherwise. Its exit folds into the final verdict below.
MASK_GATE_STATUS=0
if [[ -n "$CONV_MODE" ]]; then
	echo "== mask-regression gate (#718) =="
	node --experimental-strip-types scripts/eval/mask-regression-gate.ts \
		--model "${INT8:-$MODEL}" --tokenizer "$TOK" --model-card "$CARD" \
		--anchor-lookup "$LK" --gazetteer-lexicon "$GAZ" \
		--json "$OUT_DIR/mask-regression.json" > "$OUT_DIR/mask-regression.md" 2>&1 || MASK_GATE_STATUS=$?
	if [[ "$MASK_GATE_STATUS" -eq 0 ]]; then
		echo "✓ mask-regression gate PASS (no tag regresses >2pp under the conventions mask)"
	else
		echo "✗ mask-regression gate FAIL (see $OUT_DIR/mask-regression.md) — a tag regresses >2pp under the '$CONV_MODE' mask" >&2
	fi
else
	echo "⚠ mask-regression gate SKIPPED — spec declares no requires_conventions (no mask in the ship config)"
fi

# --- collect + verify (node does the parsing; bash stays an orchestrator) ---
# Folds BOTH locks: the floor verdict AND the mask-regression gate above. Either miss fails the gate.
VERDICT_STATUS=0
node --experimental-strip-types scripts/eval/promotion-gate-verdict.ts \
	--gate "$GATE" --out-dir "$OUT_DIR" $( [[ -n "$INT8" ]] && echo --with-int8 ) || VERDICT_STATUS=$?

if [[ "$VERDICT_STATUS" -ne 0 || "$MASK_GATE_STATUS" -ne 0 ]]; then
	[[ "$MASK_GATE_STATUS" -ne 0 ]] && echo "✗ gate FAILED the mask-regression lock (#718) — see $OUT_DIR/mask-regression.md" >&2
	exit 1
fi
