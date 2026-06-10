#!/usr/bin/env bash
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# Verify the LOCAL export/quant toolchain matches the pinned training-image set (#480).
#
# Why this exists: the set was once unpinned (`>=`) and drifted between v0.9.3 and v0.9.7,
# silently breaking int8 quant for Safari WebGPU (the value_info/opset incident — see
# project-v4.1.0-release + the pinned block in scripts/modal/train_remote.py, which is the
# SOURCE OF TRUTH this script reads). Run before any local quantize; CI-able (exit 1 on
# mismatch). A bumped dep here is never a free upgrade — it must re-prove the Safari int8
# graph (opset ≤17, value_info strip) end to end.
set -euo pipefail

PYTHON="${PYTHON:-corpus-python/.venv/bin/python}"
TRAIN_REMOTE="scripts/modal/train_remote.py"

[[ -x "$PYTHON" ]] || { echo "✗ $PYTHON not found — create the corpus-python venv first" >&2; exit 2; }

# Local quantize needs only the QUANT subset (onnx, onnxruntime) — export runs on Modal,
# where the full image pins apply. Export-side packages absent locally are a WARNING;
# present-but-mismatched is a FAILURE either way (a wrong version is worse than a missing one).
QUANT_PKGS="onnx onnxruntime"

fail=0
while IFS='==' read -r pkg pinned; do
	pkg=$(echo "$pkg" | tr -d ' "',)
	pinned=$(echo "$pinned" | tr -d ' "',=)
	[[ -z "$pkg" || -z "$pinned" ]] && continue
	actual=$("$PYTHON" -c "import importlib.metadata as m; print(m.version('$pkg'))" 2>/dev/null || echo "MISSING")
	if [[ "$actual" == "$pinned" ]]; then
		echo "✓ $pkg $actual"
	elif [[ "$actual" == "MISSING" && " $QUANT_PKGS " != *" $pkg "* ]]; then
		echo "⚠ $pkg: not installed locally (export-side; required on Modal, fine here)"
	else
		echo "✗ $pkg: local=$actual pinned=$pinned" >&2
		fail=1
	fi
done < <(grep -oE '"(torch|transformers|onnx|onnxruntime|onnxscript)==[0-9.]+"' "$TRAIN_REMOTE")

if [[ $fail -ne 0 ]]; then
	echo "" >&2
	echo "Toolchain drift vs $TRAIN_REMOTE — do NOT quantize for release with this env." >&2
	exit 1
fi
echo "toolchain matches the pinned training-image set"
