#!/usr/bin/env bash
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# The NON-US assembled-coordinate panel (#229 / #148). For each locale it builds a
# representative held-out set from real OpenAddresses data (build-oa-coord-golden.py)
# and grades the SHIPPED model on the metric we ship — parse → resolve → great-circle
# error — reporting RESOLVE RATE (did it produce a resolvable parse?) and the
# RESOLVED-ONLY coordinate (how accurate when it does). Label-F1 understates non-US
# (it charges street-boundary mis-tags the coordinate ignores); this is the honest dial.
#
# The night-22 finding (2026-06-22-fr-eval-coverage-scorecard.md): resolve rate tracks
# TRAINING REPRESENTATION — FR/IT (trained) ~80% → PT/PL ~52% → AU 28% — and the gap is
# PARSE (model), not gazetteer coverage. This runner makes that map reproducible + lets
# the next shift complete the remaining ~15 on-disk locales toward the #148 decision.
#
# ⚠ HEAT: each grade is local ONNX inference and spikes the lab box to ~90 °C (it cools
# fast when idle). Grade a few locales, let it cool, repeat — or run on Modal. Use
# --build-only to materialise the goldens (cool) without grading.
#
# Usage:
#   scripts/eval/nonus-coord-panel.sh fr it pt pl au         # build + grade these
#   scripts/eval/nonus-coord-panel.sh --build-only at be cz  # just build the goldens
#
# Source map: OA ships per-locale in three on-disk forms — the per-country `oa-cache`
# zips, entries inside `openaddresses/europe.zip`, and loose CSVs under
# `openaddresses/extracted/<cc>/`. This encodes which form each locale uses (the
# non-obvious part); extend SRC for new locales.

set -euo pipefail

ROOT="${MAILWOMAN_DATA:-/mnt/playpen/mailwoman-data}"
OA="$ROOT/openaddresses"
OUT_DIR="data/eval/external"
MODEL="${MODEL:-out/v180/model.onnx}"
TOK="${TOK:-$ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model}"
CARD="${CARD:-neural-weights-en-us/model-card.json}"
ANCHOR="${ANCHOR:-$ROOT/anchor/pilot-anchor-lookup.json}"

# locale → "zip|<zipfile>|<entry>"  or  "glob|<glob>"   (extend as needed)
src_for() {
	case "$1" in
	it) echo "zip|$ROOT/oa-cache/it__countrywide.zip|it/countrywide.csv" ;;
	es) echo "zip|$ROOT/oa-cache/es__countrywide.zip|es/countrywide.csv" ;; # NB: ES is cadastral schema; label-only
	fr) echo "zip|$OA/europe.zip|fr/countrywide.csv" ;;
	nl) echo "zip|$OA/europe.zip|nl/countrywide.csv" ;;
	*) echo "glob|$OA/extracted/$1/*.csv" ;; # at be cz dk ee fi gr il is lt lu lv nz pl pt au qa ro sa se sg si sk
	esac
}

BUILD_ONLY=0
[ "${1:-}" = "--build-only" ] && { BUILD_ONLY=1; shift; }
[ "$#" -gt 0 ] || { echo "usage: $0 [--build-only] <cc> [cc...]" >&2; exit 2; }

printf '%-4s %-7s %-13s %-13s\n' loc resolve p50_resolved p90_resolved
for cc in "$@"; do
	CC=$(echo "$cc" | tr '[:lower:]' '[:upper:]')
	out="$OUT_DIR/oa-${cc}-coord-150.jsonl"
	if [ ! -s "$out" ]; then
		IFS='|' read -r kind a b <<<"$(src_for "$cc")"
		if [ "$kind" = "zip" ]; then
			python3 scripts/eval/build-oa-coord-golden.py --country "$cc" --zip "$a" --entry "$b" --out "$out" --n 150 >&2
		else
			python3 scripts/eval/build-oa-coord-golden.py --country "$cc" --csv-glob "$a" --out "$out" --n 150 >&2
		fi
	fi
	[ "$BUILD_ONLY" = 1 ] && continue
	json="/tmp/nonus-panel-${cc}.json"
	# A grade failure for one locale must not abort the whole panel (set -e), so guard it.
	if node --experimental-strip-types scripts/eval/fr-admin-split-gate.ts \
		--model "$MODEL" --tokenizer "$TOK" --model-card "$CARD" --anchor-lookup "$ANCHOR" \
		--golden "$out" --default-country "$CC" --label "$cc" --out "$json" >/dev/null 2>&1; then
		jq -r '"\(.label)\t\(.resolve_rate)\t\(.coord_p50_resolved_km)\t\(.coord_p90_resolved_km)"' "$json"
	else
		echo "${cc}	GRADE-FAILED (see gate output)"
	fi
done
