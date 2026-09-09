"""Tests for scripts/verify_toolchain.py (#480 deliverable 4).

Guards that the export/quant pins stay consistent across pyproject, the Modal image, and the
export opset — so a one-sided pin bump (the drift that broke mobile-Safari int8 once) goes red
here instead of at the next export. The ruff pin is guarded on the same grounds: its version is
named in pyproject and in every `uvx ruff@` shell call site, and a bump that moves one leaves a
local linter that disagrees with the one CI runs.
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


def test_every_ruff_call_site_names_the_pinned_version():
    """The [dev] ruff pin and every `uvx ruff@` call site must name one version.

    The bump that added this: `pyproject.toml` moved to 0.16.5 and the three call sites in
    `package.json` and `.husky/pre-commit` stayed at 0.15.20, so a developer's ruff and CI's ruff
    were different minor versions with nothing checking.
    """
    vt = _load()
    pin = vt._ruff_dev_pin()
    assert pin, "pyproject [dev] carries no exact ruff== pin"
    sites = vt._ruff_call_site_versions()
    assert sites, "no ruff call sites are declared"
    for path, versions in sites.items():
        assert versions, f"{path} declares no `uvx ruff@<version>` — the check reads a file it no longer guards"
        assert versions == {pin}, f"{path} calls ruff@{sorted(versions)} but the pin is =={pin}"
