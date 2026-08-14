#!/usr/bin/env bash
#
# @copyright Sister Software
# @license AGPL-3.0
# @author Teffen Ellis, et al.
#
# Build the committed `sentencepiece.mjs` artifact: google/sentencepiece at the PINNED tag below,
# compiled to WASM with emscripten and linked against binding.cpp (the embind wrapper exposing
# native per-piece byte offsets — task #26).
#
# The artifact is COMMITTED (like core/data's reference blobs): consumers import
# `@mailwoman/sentencepiece-wasm` as a plain dependency and never need emscripten. Re-run this
# script only to bump the sentencepiece tag or change the binding; commit the regenerated .mjs in
# the same PR and note the tag bump in the header of index.d.ts.
#
# Prereqs: emsdk activated (`source ~/tools/emsdk/emsdk_env.sh`), cmake, git. The sentencepiece
# checkout is cached OUTSIDE the repo (a toolchain input, not a repo artifact).
#
# Single-file output on purpose: -sSINGLE_FILE=1 embeds the wasm as base64 in the .mjs, matching
# how the previous runtime (@sctg/sentencepiece-js) shipped — no separate .wasm delivery path to
# thread through neural-web, the docs demo, or the drop-in APIs. The size cost (~4/3× the wasm) is
# accepted; the artifact is fetched once and cached.

set -euo pipefail

# The pin. corpus-python trains with `sentencepiece>=0.2.2` — the runtime MUST tokenize
# byte-identically to the trainer, so the tags travel together (see project-tokenizer-mismatch).
SP_TAG="v0.2.2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SP_SRC="${SENTENCEPIECE_SRC:-$HOME/tools/sentencepiece}"
BUILD_DIR="$SP_SRC/build-wasm"

command -v emcc > /dev/null || {
	echo "emcc not found — source the emsdk env first (see header)." >&2
	exit 1
}

if [ ! -d "$SP_SRC" ]; then
	git clone https://github.com/google/sentencepiece.git "$SP_SRC"
fi

git -C "$SP_SRC" fetch --tags
git -C "$SP_SRC" checkout "$SP_TAG"

# Static library build. SPM_ENABLE_SHARED=OFF is required under emscripten; the TCMalloc probe is
# meaningless in WASM.
emcmake cmake -S "$SP_SRC" -B "$BUILD_DIR" \
	-DCMAKE_BUILD_TYPE=Release \
	-DSPM_ENABLE_SHARED=OFF \
	-DSPM_ENABLE_TCMALLOC=OFF > /dev/null

# Full build (not just sentencepiece-static): v0.2.2 links against the vendored abseil-cpp, whose
# ~90 small static libs only materialize with the default target set.
cmake --build "$BUILD_DIR" -j "$(nproc)" > /dev/null

# Every abseil archive joins the link line — wasm-ld's resolution across this many inter-dependent
# archives is handled by listing them all; the dead ones are dropped by -Oz + gc-sections anyway.
ABSL_LIBS=$(find "$BUILD_DIR/third_party/abseil-cpp" -name "*.a" | sort)

# Link the binding. Notes on the flags:
# - MODULARIZE + EXPORT_ES6: the artifact default-exports an async factory (createSentencePiece).
# - SINGLE_FILE: wasm embedded as base64 (see header).
# - ENVIRONMENT=web,webview,worker,node: every consumer surface (browser demo, workers, Node CLI).
# - ALLOW_MEMORY_GROWTH: tokenizer.model is ~1.6MB and encode allocations scale with input length.
# - DISABLE_EXCEPTION_CATCHING=0: protobuf-lite + sentencepiece throw in cold error paths; without
#   catching enabled a bad model file ABORTS the runtime instead of returning a status.
# - FILESYSTEM=0: only LoadFromSerializedProto is bound — no FS use anywhere.
emcc "$SCRIPT_DIR/binding.cpp" \
	-I "$SP_SRC/src" -I "$SP_SRC" -I "$SP_SRC/third_party/abseil-cpp" -I "$SP_SRC/third_party/protobuf-lite" -I "$SP_SRC/src/builtin_pb" -I "$BUILD_DIR" \
	"$BUILD_DIR/src/libsentencepiece.a" \
	$ABSL_LIBS \
	-Oz \
	-lembind \
	-sMODULARIZE=1 \
	-sEXPORT_ES6=1 \
	-sEXPORT_NAME=createSentencePiece \
	-sSINGLE_FILE=1 \
	-sALLOW_MEMORY_GROWTH=1 \
	-sENVIRONMENT=web,webview,worker,node \
	-sDISABLE_EXCEPTION_CATCHING=0 \
	-sFILESYSTEM=0 \
	-o "$SCRIPT_DIR/sentencepiece.mjs"

echo "Built $SCRIPT_DIR/sentencepiece.mjs from sentencepiece $SP_TAG:"
ls -la "$SCRIPT_DIR/sentencepiece.mjs"
