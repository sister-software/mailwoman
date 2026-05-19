#!/usr/bin/env bash
# Symlink dev model + tokenizer files into this package for local testing.
# See @mailwoman/neural-weights-en-us/scripts/link-dev-weights.sh for the rationale.
#
# Phase 2 v0.2.0 currently ships a single multilingual model used as both en-us
# and fr-fr per the model card. Re-symlinks the same files until per-locale
# training lands.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_MODEL="${MAILWOMAN_DEV_MODEL:-/mnt/playpen/mailwoman-data/models/quantized/model-stage1-coarse-step-050000-int8.onnx}"
SRC_TOKENIZER="${MAILWOMAN_DEV_TOKENIZER:-/mnt/playpen/mailwoman-data/models/tokenizer/v0.1.0/tokenizer.model}"

if [ ! -f "$SRC_MODEL" ]; then
	echo "missing source model: $SRC_MODEL" >&2
	exit 1
fi
if [ ! -f "$SRC_TOKENIZER" ]; then
	echo "missing source tokenizer: $SRC_TOKENIZER" >&2
	exit 1
fi

ln -sf "$SRC_MODEL" "$PKG_DIR/model.onnx"
ln -sf "$SRC_TOKENIZER" "$PKG_DIR/tokenizer.model"

echo "linked $PKG_DIR/{model.onnx,tokenizer.model}"
