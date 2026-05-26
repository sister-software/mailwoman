#!/usr/bin/env bash
# Symlink dev model + tokenizer files into this package for local testing.
#
# The published @mailwoman/neural-weights-en-us bundle contains the real model.onnx
# + tokenizer.model files (declared in package.json `files`). In the monorepo only
# the metadata files (package.json, model-card.json, README.md) are committed; the
# binaries live in /mnt/playpen/mailwoman-data/models/ from Phase 2 training and
# get copied in at publish time.
#
# This script symlinks the dev artifacts so `@mailwoman/neural`'s loadFromWeights
# can find them during local testing. Run from anywhere; resolves paths from the
# package dir.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_MODEL="${MAILWOMAN_DEV_MODEL:-/mnt/playpen/mailwoman-data/models/quantized/model-v052-step-100000-int8.onnx}"
SRC_TOKENIZER="${MAILWOMAN_DEV_TOKENIZER:-/mnt/playpen/mailwoman-data/models/tokenizer/v0.5.0-a1/tokenizer.model}"

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
