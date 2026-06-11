#!/usr/bin/env bash
# Symlink dev model + tokenizer files into this package for local testing.
#
# The published @mailwoman/neural-weights-en-us bundle contains the real model.onnx
# + tokenizer.model files (declared in package.json `files`). In the monorepo only
# the metadata files (package.json, model-card.json, README.md) are committed; the
# binaries live in /mnt/playpen/mailwoman-data/models/ from training and get copied
# in at publish time.
#
# This script symlinks the dev artifacts so `@mailwoman/neural`'s loadFromWeights
# can find them during local testing. Run from anywhere; resolves paths from the
# package dir.
#
# ---------------------------------------------------------------------------
# #397 GUARD — why this script verifies a hash (read before editing the paths)
# ---------------------------------------------------------------------------
# `neural/test/weights.test.ts` invokes this script, so EVERY `yarn test` run
# re-creates these symlinks. If the defaults below point at a stale model, the
# whole repo silently starts grading evals against the wrong weights — which is
# exactly the trap that wasted an eval shift (the symlink had drifted to
# v0.5.3 / tokenizer v0.5.0-a1 while the deployed default was v4.0.0).
#
# To make drift impossible to ignore, when the DEFAULT artifacts are used (no
# MAILWOMAN_DEV_MODEL / MAILWOMAN_DEV_TOKENIZER override) this script asserts the
# linked bytes match EXPECTED_*_MD5 — the md5 of what the demo actually serves at
#   https://public.sister.software/mailwoman/en-us/<defaultVersion>/{model,tokenizer}
# A mismatch FAILS LOUD instead of grading the wrong model.
#
# ON DEFAULT PROMOTION (releases.json `defaultVersion` bump): update the four
# DEFAULT_* values below to the new artifact + its md5 in ONE place. Recompute via:
#   curl -s https://public.sister.software/mailwoman/en-us/<ver>/model.onnx | md5sum
#   curl -s https://public.sister.software/mailwoman/en-us/<ver>/tokenizer.model | md5sum
# ---------------------------------------------------------------------------
set -euo pipefail

# --- current default (releases.json defaultVersion = v4.4.0) ---------------
# v4.3.0 en-us ships the v1.1.0-relabel-consolidation model (step 40000, from
# scratch on the label-consistent mix — #511 affix relabel; affix 93.6/96.6) with
# the locale head exported (locale_logits) for the conventions mask (#478 slice 1),
# + the 0.6.0-a0 tokenizer. These md5s are the authoritative bytes the demo serves
# at .../mailwoman/en-us/v4.3.0/{model,tokenizer}.
DEFAULT_MODEL="/mnt/playpen/mailwoman-data/models/quantized/model-v130-step-40000-int8.onnx"
DEFAULT_MODEL_MD5="f086951a807b35e1ef700c0c2662a088"
DEFAULT_TOKENIZER="/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
DEFAULT_TOKENIZER_MD5="b6137e8c52914c9715374268ecaa4bc6"

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# An explicit override means the caller is deliberately experimenting with a
# non-default model — skip the hash assertion in that case (but warn loudly).
MODEL_OVERRIDDEN=0
TOKENIZER_OVERRIDDEN=0
[ -n "${MAILWOMAN_DEV_MODEL:-}" ] && MODEL_OVERRIDDEN=1
[ -n "${MAILWOMAN_DEV_TOKENIZER:-}" ] && TOKENIZER_OVERRIDDEN=1

SRC_MODEL="${MAILWOMAN_DEV_MODEL:-$DEFAULT_MODEL}"
SRC_TOKENIZER="${MAILWOMAN_DEV_TOKENIZER:-$DEFAULT_TOKENIZER}"

if [ ! -f "$SRC_MODEL" ]; then
	echo "missing source model: $SRC_MODEL" >&2
	echo "set MAILWOMAN_DEV_MODEL to override" >&2
	exit 1
fi
if [ ! -f "$SRC_TOKENIZER" ]; then
	echo "missing source tokenizer: $SRC_TOKENIZER" >&2
	echo "set MAILWOMAN_DEV_TOKENIZER to override" >&2
	exit 1
fi

ln -sf "$SRC_MODEL" "$PKG_DIR/model.onnx"
ln -sf "$SRC_TOKENIZER" "$PKG_DIR/tokenizer.model"

echo "linked:"
echo "  $PKG_DIR/model.onnx → $SRC_MODEL"
echo "  $PKG_DIR/tokenizer.model → $SRC_TOKENIZER"

# --- #397 drift guard: assert default bytes match what the demo serves ------
assert_md5() {
	local label="$1" path="$2" expected="$3"
	local actual
	actual="$(md5sum "$path" | cut -d' ' -f1)"
	if [ "$actual" != "$expected" ]; then
		echo "" >&2
		echo "ERROR (#397 guard): linked default $label md5 mismatch." >&2
		echo "  linked:   $path" >&2
		echo "  got:      $actual" >&2
		echo "  expected: $expected (deployed en-us defaultVersion)" >&2
		echo "  The dev symlink has drifted from the deployed default. Either the" >&2
		echo "  artifact moved, or releases.json defaultVersion changed without a" >&2
		echo "  matching bump to DEFAULT_${label^^}_MD5 in this script." >&2
		exit 1
	fi
}

if [ "$MODEL_OVERRIDDEN" -eq 0 ]; then
	assert_md5 "model" "$PKG_DIR/model.onnx" "$DEFAULT_MODEL_MD5"
else
	echo "  (model override active — skipping #397 default-hash check)" >&2
fi
if [ "$TOKENIZER_OVERRIDDEN" -eq 0 ]; then
	assert_md5 "tokenizer" "$PKG_DIR/tokenizer.model" "$DEFAULT_TOKENIZER_MD5"
else
	echo "  (tokenizer override active — skipping #397 default-hash check)" >&2
fi
