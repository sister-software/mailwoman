"""Verify the export/quant toolchain pins are internally consistent (#480 deliverable 4).

A dependency drift is what broke int8 quantization for mobile-Safari once already (2026-06-09:
unpinned ``>=`` let transformers→5.x / onnx→1.21 in, and the dynamo exporter started writing
stale ``value_info`` the quantizer choked on). The pins now live in THREE places that must agree,
or a local export silently differs from the browser-shipped graph:

1. ``corpus-python/pyproject.toml`` ``[project.optional-dependencies].train`` — the local toolchain.
2. ``scripts/modal/train_remote.py`` ``.pip_install(...)`` — the Modal image that produces the
   shipped artifact.
3. ``corpus-python/src/mailwoman_train/export_onnx.py`` — the opset the graph is exported at
   (the ``<= 17`` invariant onnxruntime-web's native WebGPU EP needs).

This script asserts all three agree, and (when the heavy ML deps are actually installed) that the
installed versions match the pins too. It needs none of torch/onnx to run the cross-file checks, so
it is a cheap CI guard — run it in the lint/CI lane, not just on a train machine.

Run: ``python corpus-python/scripts/verify_toolchain.py`` (exit 0 = consistent, 1 = drift).
"""

from __future__ import annotations

import importlib.metadata
import re
import sys
import tomllib
from pathlib import Path

# The export/quant deps whose version is load-bearing for the shipped ONNX graph. datasets/tqdm/
# trackio are loose by design (they don't touch the graph), so they are NOT guarded here.
INVARIANT_DEPS = ("torch", "transformers", "onnx", "onnxruntime")
MAX_OPSET = 17

REPO_ROOT = Path(__file__).resolve().parents[2]
PYPROJECT = REPO_ROOT / "corpus-python" / "pyproject.toml"
MODAL_IMAGE = REPO_ROOT / "scripts" / "modal" / "train_remote.py"
EXPORT_ONNX = REPO_ROOT / "corpus-python" / "src" / "mailwoman_train" / "export_onnx.py"

PIN_RE = re.compile(r"^([A-Za-z0-9_.-]+)==([0-9][^\"'\s]*)$")


def _pins_from_pyproject() -> dict[str, str]:
    data = tomllib.loads(PYPROJECT.read_text())
    train = data["project"]["optional-dependencies"]["train"]
    out: dict[str, str] = {}
    for spec in train:
        m = PIN_RE.match(spec.strip())
        if m and m.group(1) in INVARIANT_DEPS:
            out[m.group(1)] = m.group(2)
    return out


def _pins_from_modal() -> dict[str, str]:
    # The Modal image lists pins as "pkg==ver" string literals inside .pip_install(...).
    text = MODAL_IMAGE.read_text()
    out: dict[str, str] = {}
    for dep in INVARIANT_DEPS:
        m = re.search(rf'["\']{re.escape(dep)}==([0-9][^"\']*)["\']', text)
        if m:
            out[dep] = m.group(1)
    return out


def _export_opset() -> int | None:
    m = re.search(r"opset:\s*int\s*=\s*(\d+)", EXPORT_ONNX.read_text())
    return int(m.group(1)) if m else None


def main() -> int:
    problems: list[str] = []

    pyproject = _pins_from_pyproject()
    modal = _pins_from_modal()

    missing_py = [d for d in INVARIANT_DEPS if d not in pyproject]
    if missing_py:
        problems.append(f"pyproject train extras missing pins for: {', '.join(missing_py)}")

    # 1+2: pyproject must agree with the Modal image, dep by dep.
    for dep in INVARIANT_DEPS:
        py, md = pyproject.get(dep), modal.get(dep)
        if py and md and py != md:
            problems.append(f"{dep}: pyproject pins =={py} but Modal image pins =={md}")
        elif py and md is None:
            problems.append(f"{dep}: pinned =={py} in pyproject but absent from the Modal image pins")

    # 3: the export opset must hold the <= 17 mobile-Safari invariant.
    opset = _export_opset()
    if opset is None:
        problems.append(f"could not read the export opset from {EXPORT_ONNX.name}")
    elif opset > MAX_OPSET:
        problems.append(f"export opset is {opset} but the onnxruntime-web invariant requires <= {MAX_OPSET}")

    # Conditional: if the heavy deps are actually installed (train machine / Modal), they must match
    # the pins. In a lint-only checkout they are absent by design — skip with a note, don't fail.
    installed_checked = 0
    for dep, pin in pyproject.items():
        try:
            got = importlib.metadata.version(dep)
        except importlib.metadata.PackageNotFoundError:
            continue
        installed_checked += 1
        if got != pin:
            problems.append(f"{dep}: installed {got} != pinned {pin}")

    print(f"[verify-toolchain] pyproject pins: {pyproject}")
    print(f"[verify-toolchain] modal pins:     {modal}")
    print(f"[verify-toolchain] export opset:   {opset}")
    print(
        f"[verify-toolchain] installed-version check: {installed_checked}/{len(pyproject)} deps present"
        + (" (heavy deps not installed — cross-file checks only)" if installed_checked == 0 else "")
    )

    if problems:
        print("\n[verify-toolchain] DRIFT DETECTED:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print("[verify-toolchain] OK — pyproject, Modal image, and export opset agree.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
