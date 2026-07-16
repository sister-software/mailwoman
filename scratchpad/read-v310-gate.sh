#!/usr/bin/env bash
# Read the v3.1.0-fr-fragment gate (#1143 T2). Run AFTER the training run reaches step-008000.
#
# Everything here is pre-registered — see the config header and baselines.json (profile
# fragment-fr-v264). This script does not decide anything; it produces the numbers the gate is read
# against, in the same production config every baseline was registered under (ffcb8e96).
#
#   MOVE  : bare-street 0.215 · street-particle 0.273 · admin-street-homonym 0.087 · date-name 0.055
#   GUARD : street-housenumber 0.925 · alnum-housenumber 0.925  (contextful)
#   GUARD : bare-locality 0.980 — MAY FALL BY DESIGN. It passes for the wrong reason today (the model
#           calls everything without a house number a locality). If it collapses while the bare
#           classes rise, the shard traded one default for another and --bare-prob is the knob.
#   GUARD : the global parity floor. Board 2 moving is not a verdict alone.
#
# Usage:  bash scratchpad/read-v310-gate.sh [STEP]     (default 8000)
set -euo pipefail

STEP="${1:-008000}"  # ZERO-PADDED: the export builds `checkpoints/step-{step}` by interpolation,
                     # and the dirs are step-008000. `8000` yields step-8000 and a FileNotFoundError.
OUT_DIR="/data/output-v310-fr-fragment-s42"
TOKENIZER="/data/models/tokenizer/v0.9.0-multisplice/tokenizer.model"
CACHE="scratchpad/v310-cache"
PKG="$CACHE/node_modules/@mailwoman/neural-weights-en-us"
BASE="scratchpad/v264-cache/node_modules/@mailwoman/neural-weights-en-us"

echo "### 1. export step-$STEP -> ONNX, then QUANTIZE to int8 (both on Modal)"
# The export is fp32 (39.2M params x 4 bytes = 157 MB). The SHIPPED v264 cache — and therefore every
# baseline in baselines.json — is int8 (39.4 MB, DynamicQuantizeLinear + MatMulInteger). Reading an
# fp32 candidate against int8 baselines attributes the QUANTIZATION delta to the shard. The gate spec
# caps int8-vs-fp32 at 1.5pp, which is larger than several cells we are trying to read.
# Quantizing runs on Modal on purpose: the dynamo-exported graph trips shape inference in local
# onnxruntime builds (see quantize_onnx's docstring).
modal run corpus-python/modal/train_remote.py::export_onnx \
	--output-dir="$OUT_DIR" --step="$STEP" --tokenizer-path="$TOKENIZER"
modal run corpus-python/modal/train_remote.py::quantize_onnx \
	--fp32-path="$OUT_DIR/model.onnx" --int8-path="$OUT_DIR/model-int8.onnx"

echo
echo "### 2. build the package-shaped cache"
# Package-shaped ONLY (#718): the explicit --model path grades a CHANNEL-STARVED model, because the
# anchor / gazetteer / country lexicons are resolved as package siblings. Every sibling here comes
# from the shipped v264 package — they are unchanged by this run, which trains weights, not lexicons.
mkdir -p "$PKG"
cp "$BASE"/tokenizer.model "$BASE"/model-card.json "$BASE"/calibration.json \
	"$BASE"/anchor-lexicon-v1.json "$BASE"/country-surface-lexicon-v1.json "$BASE"/postcode-us.bin "$PKG/"
modal volume get mailwoman-training "${OUT_DIR#/data/}/model-int8.onnx" "$PKG/model.onnx" --force

echo
echo "### 3. sanity — TWO checks, because 'differs' is not enough"
a=$(md5sum "$BASE/model.onnx" | cut -d' ' -f1)
b=$(md5sum "$PKG/model.onnx" | cut -d' ' -f1)
echo "  v264 md5: $a"
echo "  v310 md5: $b"
if [ "$a" = "$b" ]; then
	echo "  ✗ IDENTICAL — the export did not pick up the new checkpoint. STOP; the read would be meaningless."
	exit 1
fi
echo "  ✓ differs"

# An md5 difference is trivially satisfied by a PRECISION change, which is exactly the trap this
# script walked into on its first run: fp32 candidate vs int8 baselines. Assert the candidate is
# int8, like every registered baseline.
python3 - "$PKG/model.onnx" "$BASE/model.onnx" <<'PYCHECK'
import sys, onnx
def quantized(path):
    m = onnx.load(path, load_external_data=False)
    return any("Quant" in n.op_type or n.op_type == "MatMulInteger" for n in m.graph.node)
cand, base = sys.argv[1], sys.argv[2]
c, b = quantized(cand), quantized(base)
print(f"  candidate int8: {c}    baseline int8: {b}")
if c != b:
    print("  ✗ PRECISION MISMATCH — the candidate and the baselines are different numeric classes.")
    print("    The gate spec caps int8-vs-fp32 at 1.5pp; that is larger than cells we read here, so")
    print("    the shard's effect would be confounded with quantization. STOP.")
    sys.exit(1)
print("  ✓ same precision class as the baselines")
PYCHECK

echo
echo "### 4. BOARD 2 — the FR fragment board (the read)"
node mailwoman/out/cli.js eval fragment-board --weights-cache "$CACHE" 2>&1 | head -14

echo
echo "### 5. BOARD 1 — the global parity floor (the guard)"
node mailwoman/out/cli.js eval parity --weights-cache "$CACHE" 2>&1 | tail -6

echo
echo "### 6. instrument check — oracle-k against the v264 profile is EXPECTED to refuse."
echo "###    v310 is a different model; a pass here would mean the weights did not move."
node mailwoman/out/cli.js eval oracle-k --weights-cache "$CACHE" --k 10 2>&1 | head -8
