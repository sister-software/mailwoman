#!/usr/bin/env bash
#
# Fixture test for docs/styles/Mailwoman/*.yml (docs-reorg Task 1: Vale toolchain).
#
# There's no vitest harness for a set of Vale YAML rule files, so this is the
# test: run Vale against scripts/vale-fixtures/dirty.md, which is written to
# trip every rule file at least once (and also embeds a code fence, a JSX tag,
# an import line, and a `<details>` block full of the same banned words, none
# of which should be flagged — that's the TokenIgnores/BlockIgnores coverage),
# and scripts/vale-fixtures/clean.md, which should pass with zero alerts. A
# rule that stops firing, or an ignore pattern that starts leaking banned
# words from a fence/import/JSX/details block into real alerts, shows up here
# as the wrong fixture producing the wrong verdict.
#
# dirty.md also carries NEGATIVE assertions, each checked only by its line
# staying quiet:
#
#   - The phrase "full-text search" sits in plain prose and must NOT trip
#     Terms.yml's `text search` swap. That swap is guarded precisely so the
#     FTS5 vocabulary this repo ships survives it.
#   - A backticked `neighbourhood` (a real Who's On First placetype) and a
#     backticked `licence` (Nominatim's response field) must NOT trip
#     Spelling.yml, nor must the JSON fence carrying both. Vale's markdown
#     parser skips inline code and fences natively, which is the whole reason
#     those two en-GB-looking identifiers can stay on the swap list.
#
# Run from anywhere:
#   docs/scripts/check-vale-rules.sh
#   yarn workspace @mailwoman/docs lint:prose:fixtures
#
# Wired into the docs CI job (.github/workflows/docs-build.yml) so a rule
# regression fails loudly instead of silently drifting.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# The exact error-severity count dirty.md produces today (measured, not
# estimated). It is a `>=` bar, so adding a rule + its fixture line passes
# without a bump; only a rule that STOPS firing fails. Raised 5 -> 29 when the
# derived writing system (docs/engineering/writing-system.md) added the
# API-key / data-layer / geocoding-direction terms and the ease-claim stock
# phrases, and dirty.md grew one hit for each. Raised 29 -> 48 when
# Spelling.yml (US English) landed with one fixture line per inflection.
# Raised 48 -> 52 when the wave-2 review found four Spelling.yml swap
# entries (metre, kilometres, neighbouring, normalises) with no fixture line
# exercising them; dirty.md now carries one hit for each.
MIN_DIRTY_ERRORS=52
RULE_FILES=(BannedWords StockPhrases Anthropomorphism Weasel Terms Spelling)

cd "$DOCS_DIR"

# yarn 4's node-modules linker hoists @vvago/vale to whichever node_modules is
# closest to the workspace root that doesn't have a conflicting version — that
# is the repo root here, not docs/node_modules — so walk up looking for it,
# the same resolution order Node itself would use.
VALE_BIN=""
search_dir="$DOCS_DIR"
while true; do
	if [[ -x "$search_dir/node_modules/@vvago/vale/bin/vale" ]]; then
		VALE_BIN="$search_dir/node_modules/@vvago/vale/bin/vale"
		break
	fi
	[[ "$search_dir" == "/" ]] && break
	search_dir="$(dirname "$search_dir")"
done

if [[ -z "$VALE_BIN" ]]; then
	echo "error: @vvago/vale binary not found in any node_modules above $DOCS_DIR — run 'yarn install' first" >&2
	exit 1
fi

echo "== dirty.md: expect failure, >= ${MIN_DIRTY_ERRORS} errors, every rule file represented =="
dirty_status=0
dirty_json="$("$VALE_BIN" --config .vale.ini --output=JSON scripts/vale-fixtures/dirty.md)" || dirty_status=$?

if [[ "$dirty_status" -eq 0 ]]; then
	echo "FAIL: dirty.md exited 0 (expected a non-zero exit from error-severity hits)" >&2
	exit 1
fi

error_count="$(jq '[.[][] | select(.Severity == "error")] | length' <<<"$dirty_json")"
if [[ "$error_count" -lt "$MIN_DIRTY_ERRORS" ]]; then
	echo "FAIL: dirty.md produced $error_count error-severity hits, expected >= $MIN_DIRTY_ERRORS" >&2
	exit 1
fi

for rule in "${RULE_FILES[@]}"; do
	hits="$(jq --arg rule "Mailwoman.$rule" '[.[][] | select(.Check == $rule)] | length' <<<"$dirty_json")"
	if [[ "$hits" -lt 1 ]]; then
		echo "FAIL: rule Mailwoman.$rule did not fire on dirty.md (regression)" >&2
		exit 1
	fi
done
echo "OK: dirty.md — $error_count error-severity hits, all ${#RULE_FILES[@]} rule files fired"

echo "== clean.md: expect success =="
if ! "$VALE_BIN" --config .vale.ini scripts/vale-fixtures/clean.md; then
	echo "FAIL: clean.md tripped a rule (false positive)" >&2
	exit 1
fi
echo "OK: clean.md — 0 alerts"

echo "All Vale rule fixture checks passed."
