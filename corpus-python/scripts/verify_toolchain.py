"""Verify the export/quant toolchain pins are internally consistent (#480 deliverable 4).

A dependency drift is what broke int8 quantization for mobile-Safari once already (2026-06-09:
unpinned ``>=`` let transformers→5.x / onnx→1.21 in, and the dynamo exporter started writing
stale ``value_info`` the quantizer choked on). The pins now live in THREE places that must agree,
or a local export silently differs from the browser-shipped graph:

1. ``corpus-python/pyproject.toml`` ``[project.optional-dependencies].train`` — the local toolchain.
2. ``corpus-python/launch/app.py`` ``.pip_install(...)`` — the Modal image that produces the
   shipped artifact.
3. ``corpus-python/src/mailwoman_train/export_onnx.py`` — the opset the graph is exported at
   (the ``<= 17`` invariant onnxruntime-web's native WebGPU EP needs).

The ruff pin has the same shape and one more copy: ``pyproject.toml``'s ``[dev]`` extra names the
version a developer's venv installs, and three shell call sites (``package.json``'s ``lint:python``
and ``fix:python``, ``.husky/pre-commit``) name the version ``uvx`` fetches. A bump that moves the
pin without the call sites leaves a local ruff that lints differently from the one CI runs, which is
the failure the pyproject comment warns about — and it happened, so this script now checks all four.

This script asserts they agree, and (when the heavy ML deps are actually installed) that the
installed versions match the pins too. It needs none of torch/onnx to run the cross-file checks, so
it is a cheap CI guard — run it in the lint/CI lane, not just on a train machine.

Run: ``python corpus-python/scripts/verify_toolchain.py`` (exit 0 = consistent, 1 = drift).
"""

from __future__ import annotations

import importlib.metadata
import re
import subprocess  # nosec B404 — probes the project venv's interpreter for installed versions
import sys
import tomllib
from pathlib import Path

# The export/quant deps whose version is required for the shipped ONNX graph. datasets/tqdm/
# trackio are loose by design (they don't touch the graph), so they are NOT guarded here.
#
# `onnxscript` was absent from this list while five graph pins existed, so pyproject read 0.7.1
# against the Modal image's 0.7.0 and this check still printed that the two agree. It is the dynamo
# exporter, which decides the graph — a narrower guard than its own message claims is worse than no
# guard, because the message is what a reader trusts.
INVARIANT_DEPS = ("torch", "transformers", "onnx", "onnxruntime", "onnxscript")
MAX_OPSET = 17

REPO_ROOT = Path(__file__).resolve().parents[2]
PYPROJECT = REPO_ROOT / "corpus-python" / "pyproject.toml"
MODAL_IMAGE = REPO_ROOT / "corpus-python" / "launch" / "app.py"
EXPORT_ONNX = REPO_ROOT / "corpus-python" / "src" / "mailwoman_train" / "export" / "onnx.py"

# Every file that names a ruff version for `uvx` to fetch. Each must agree with the [dev] pin.
RUFF_CALL_SITES = (REPO_ROOT / "package.json", REPO_ROOT / ".husky" / "pre-commit")
RUFF_UVX_RE = re.compile(r"uvx ruff@([0-9][^\s\"']*)")

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


#: The interpreter that exports and quantizes locally. `REPRODUCIBILITY.md`'s quantize step and
#: `verify-export-quant-versions.run.ts` both use it, so it is the environment these pins describe.
PROJECT_VENV = REPO_ROOT / "corpus-python" / ".venv" / "bin" / "python3"


def _installed_versions() -> dict[str, str]:
    """Installed versions of the guarded deps, read from the project venv where there is one.

    The pre-commit hook invokes this script with a bare `python3`, so reading THIS interpreter
    reports whatever the system Python happens to carry — a stray global copy of one dep made the
    check disagree with the venv that actually runs the export. Falls back to this interpreter when
    no venv exists, which is the lint-only checkout the skip note describes.
    """
    if PROJECT_VENV.is_file():
        probe = (
            "import importlib.metadata as m\n"
            f"for d in {list(INVARIANT_DEPS)!r}:\n"
            "    try: print(d, m.version(d))\n"
            "    except Exception: pass\n"
        )
        result = subprocess.run(  # nosec B603 — fixed argv, no shell, interpreter inside this checkout
            [str(PROJECT_VENV), "-c", probe], capture_output=True, text=True, check=False
        )
        if result.returncode == 0:
            return dict(line.split() for line in result.stdout.splitlines() if line.strip())
    out: dict[str, str] = {}
    for dep in INVARIANT_DEPS:
        try:
            out[dep] = importlib.metadata.version(dep)
        except importlib.metadata.PackageNotFoundError:
            continue
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


def _ruff_dev_pin() -> str | None:
    data = tomllib.loads(PYPROJECT.read_text())
    for spec in data["project"]["optional-dependencies"]["dev"]:
        m = PIN_RE.match(spec.strip())
        if m and m.group(1) == "ruff":
            return m.group(2)
    return None


def _ruff_call_site_versions() -> dict[Path, set[str]]:
    """Every ruff version each call site asks `uvx` for. A file naming none is reported by its caller.

    A file with no match is a real finding, not a skip: it means the call site moved or the command
    was respelled, and this check would then pass over a copy it no longer reads.
    """
    return {path: set(RUFF_UVX_RE.findall(path.read_text())) for path in RUFF_CALL_SITES}


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

    # 4: the ruff pin and every `uvx ruff@` call site must name the same version.
    ruff_pin = _ruff_dev_pin()
    ruff_sites = _ruff_call_site_versions()
    if ruff_pin is None:
        problems.append("pyproject [dev] extras carry no exact ruff== pin")
    for path, versions in ruff_sites.items():
        name = path.relative_to(REPO_ROOT)
        if not versions:
            problems.append(f"{name}: no `uvx ruff@<version>` call found — this check reads a file it no longer guards")
            continue
        wrong = sorted(v for v in versions if v != ruff_pin)
        if wrong:
            problems.append(f"{name}: calls ruff@{', ruff@'.join(wrong)} but pyproject [dev] pins =={ruff_pin}")

    # Conditional: if the heavy deps are actually installed, they must match the pins. In a
    # lint-only checkout they are absent by design — skip with a note, don't fail.
    installed = _installed_versions()
    installed_checked = 0
    for dep, pin in pyproject.items():
        got = installed.get(dep)
        if got is None:
            continue
        installed_checked += 1
        if got != pin:
            problems.append(f"{dep}: installed {got} != pinned {pin}")

    print(f"[verify-toolchain] pyproject pins: {pyproject}")
    print(f"[verify-toolchain] modal pins:     {modal}")
    print(f"[verify-toolchain] export opset:   {opset}")
    print(
        f"[verify-toolchain] ruff pin =={ruff_pin}, call sites: "
        + ", ".join(f"{p.relative_to(REPO_ROOT)} {sorted(v) or '(none)'}" for p, v in ruff_sites.items())
    )
    print(
        f"[verify-toolchain] installed-version check: {installed_checked}/{len(pyproject)} deps present"
        + (" (heavy deps not installed — cross-file checks only)" if installed_checked == 0 else "")
    )

    if problems:
        print("\n[verify-toolchain] DRIFT DETECTED:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print("[verify-toolchain] OK — pyproject, Modal image, export opset, and the ruff pin agree.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
