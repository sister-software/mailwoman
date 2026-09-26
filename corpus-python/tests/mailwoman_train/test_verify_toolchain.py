"""Tests for scripts/verify_toolchain.py.

Guards that the export/quant pins stay consistent across pyproject, the Modal image and the export opset, and that the ruff pin matches every `uvx ruff@` call site, so a one-sided bump goes red here rather than at the next export or as a local linter that disagrees with CI.
"""

from __future__ import annotations

import importlib.util

from tests import paths

_SCRIPT = paths.PACKAGE_ROOT / "scripts" / "verify_toolchain.py"


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
    assert set(py) == set(vt.INVARIANT_DEPS), f"pyproject missing pins: {set(vt.INVARIANT_DEPS) - set(py)}"
    for dep in vt.INVARIANT_DEPS:
        assert py[dep] == md.get(dep), f"{dep}: pyproject {py[dep]} != modal {md.get(dep)}"


def test_every_base_requirement_is_installed_in_the_modal_image():
    # A base requirement absent from the image raises inside the container at first import, after
    # the run has taken a GPU.
    vt = _load()
    missing = sorted(vt._base_requirements() - vt._modal_packages())
    assert not missing, f"the Modal image does not install: {missing}"


def test_modal_package_names_are_read_from_code_not_comments():
    # The pin block's prose quotes version specifiers in passing, so a name read out of a comment
    # would make a missing install look present.
    vt = _load()
    packages = vt._modal_packages()
    assert "torch" in packages
    assert "platformdirs" in packages
    assert vt._requirement_name("platformdirs>=4.3") == "platformdirs"
    assert vt._requirement_name("onnxruntime==1.29.0") == "onnxruntime"


def test_export_opset_holds_safari_invariant():
    vt = _load()
    opset = vt._export_opset()
    assert opset is not None, "could not read the export opset"
    assert opset <= vt.MAX_OPSET, f"opset {opset} > {vt.MAX_OPSET} (onnxruntime-web WebGPU invariant)"


def test_main_passes_on_a_consistent_tree():
    vt = _load()
    assert vt.main() == 0


def test_every_ruff_call_site_names_the_pinned_version():
    """The [dev] ruff pin and every `uvx ruff@` call site must name one version, or local and CI ruff disagree."""
    vt = _load()
    pin = vt._ruff_dev_pin()
    assert pin, "pyproject [dev] carries no exact ruff== pin"
    sites = vt._ruff_call_site_versions()
    assert sites, "no ruff call sites are declared"
    for path, versions in sites.items():
        assert versions, f"{path} declares no `uvx ruff@<version>` — the check reads a file it no longer guards"
        assert versions == {pin}, f"{path} calls ruff@{sorted(versions)} but the pin is =={pin}"
