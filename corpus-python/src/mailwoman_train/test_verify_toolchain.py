"""Tests for scripts/verify_toolchain.py (#480 deliverable 4).

Guards that the export/quant pins stay consistent across pyproject, the Modal image, and the
export opset — so a one-sided pin bump (the drift that broke mobile-Safari int8 once) goes red
here instead of at the next export.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "verify_toolchain.py"


def _load():
    spec = importlib.util.spec_from_file_location("verify_toolchain", _SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_pyproject_and_modal_pins_agree():
    vt = _load()
    py = vt._pins_from_pyproject()
    md = vt._pins_from_modal()
    # Every invariant dep is pinned in pyproject...
    assert set(py) == set(vt.INVARIANT_DEPS), f"pyproject missing pins: {set(vt.INVARIANT_DEPS) - set(py)}"
    # ...and the Modal image pins it to the SAME version.
    for dep in vt.INVARIANT_DEPS:
        assert py[dep] == md.get(dep), f"{dep}: pyproject {py[dep]} != modal {md.get(dep)}"


def test_export_opset_holds_safari_invariant():
    vt = _load()
    opset = vt._export_opset()
    assert opset is not None, "could not read the export opset"
    assert opset <= vt.MAX_OPSET, f"opset {opset} > {vt.MAX_OPSET} (onnxruntime-web WebGPU invariant)"


def test_main_passes_on_a_consistent_tree():
    vt = _load()
    assert vt.main() == 0
