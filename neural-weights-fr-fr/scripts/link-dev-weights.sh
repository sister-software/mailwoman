#!/usr/bin/env bash
# Symlink dev model + tokenizer files into this package for local testing.
# See @mailwoman/neural-weights-en-us/scripts/link-dev-weights.sh for the rationale.
#
# A single multilingual model serves both en-us and fr-fr (byte-identical artifact;
# fr-fr just carries its own calibration). Re-symlinks the SAME files as en-us until
# per-locale training lands. Keep these defaults in lockstep with en-us's DEFAULT_*
# on every defaultVersion bump (currently v4.1.0 = v0.9.7-unit-v3, tokenizer 0.6.0-a0).
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_MODEL="${MAILWOMAN_DEV_MODEL:-/mnt/playpen/mailwoman-data/models/quantized/model-v097-step-20000-int8.onnx}"
SRC_TOKENIZER="${MAILWOMAN_DEV_TOKENIZER:-/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model}"

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
