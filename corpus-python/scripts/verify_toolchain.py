from __future__ import annotations

import importlib.metadata
import re
import subprocess  # nosec B404
import sys
import tomllib
from pathlib import Path

INVARIANT_DEPS = ("torch", "transformers", "onnx", "onnxruntime", "onnxscript")
MAX_OPSET = 17


ONNX_WEB_CALL_SITES = ("package.json", "packages/neural/package.json")
ONNX_WEB_RE = re.compile(r'"onnxruntime-web"\s*:\s*"([0-9][^"]*)"')

REPO_ROOT = Path(__file__).resolve().parents[2]
PYPROJECT = REPO_ROOT / "corpus-python" / "pyproject.toml"
MODAL_IMAGE = REPO_ROOT / "corpus-python" / "launch" / "app.py"
EXPORT_ONNX = REPO_ROOT / "corpus-python" / "src" / "mailwoman_train" / "export" / "onnx.py"


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


PROJECT_VENV = REPO_ROOT / "corpus-python" / ".venv" / "bin" / "python3"


def _installed_versions() -> dict[str, str]:
    if PROJECT_VENV.is_file():
        probe = (
            "import importlib.metadata as m\n"
            f"for d in {list(INVARIANT_DEPS)!r}:\n"
            "    try: print(d, m.version(d))\n"
            "    except Exception: pass\n"
        )
        result = subprocess.run(  # nosec B603
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

    text = MODAL_IMAGE.read_text()
    out: dict[str, str] = {}
    for dep in INVARIANT_DEPS:
        m = re.search(rf'["\']{re.escape(dep)}==([0-9][^"\']*)["\']', text)
        if m:
            out[dep] = m.group(1)
    return out


def _requirement_name(spec: str) -> str:
    name = re.split(r"[\[=><!~;\s]", spec.strip(), maxsplit=1)[0]

    return name.lower().replace("_", ".").replace(".", "-")


def _base_requirements() -> set[str]:
    data = tomllib.loads(PYPROJECT.read_text())

    return {_requirement_name(spec) for spec in data["project"]["dependencies"]}


def _modal_packages() -> set[str]:
    text = MODAL_IMAGE.read_text()
    block = text[text.index(".pip_install(") : text.index(".add_local_python_source")]
    code = "\n".join(line for line in block.splitlines() if not line.lstrip().startswith("#"))

    return {_requirement_name(m.group(1)) for m in re.finditer(r'"([A-Za-z0-9_.-]+[^"]*)"', code)}


def _ruff_dev_pin() -> str | None:
    data = tomllib.loads(PYPROJECT.read_text())
    for spec in data["project"]["optional-dependencies"]["dev"]:
        m = PIN_RE.match(spec.strip())
        if m and m.group(1) == "ruff":
            return m.group(2)
    return None


def _ruff_call_site_versions() -> dict[Path, set[str]]:
    return {path: set(RUFF_UVX_RE.findall(path.read_text())) for path in RUFF_CALL_SITES}


def _export_opset() -> int | None:
    m = re.search(r"opset:\s*int\s*=\s*(\d+)", EXPORT_ONNX.read_text())
    return int(m.group(1)) if m else None


def _onnxruntime_web_versions() -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for relative in ONNX_WEB_CALL_SITES:
        path = REPO_ROOT / relative
        if not path.is_file():
            versions[relative] = None
            continue
        found = ONNX_WEB_RE.search(path.read_text())
        versions[relative] = found.group(1) if found else None
    return versions


def main() -> int:
    problems: list[str] = []

    pyproject = _pins_from_pyproject()
    modal = _pins_from_modal()

    missing_py = [d for d in INVARIANT_DEPS if d not in pyproject]
    if missing_py:
        problems.append(f"pyproject train extras missing pins for: {', '.join(missing_py)}")

    for dep in INVARIANT_DEPS:
        py, md = pyproject.get(dep), modal.get(dep)
        if py and md and py != md:
            problems.append(f"{dep}: pyproject pins =={py} but Modal image pins =={md}")
        elif py and md is None:
            problems.append(f"{dep}: pinned =={py} in pyproject but absent from the Modal image pins")

    missing_from_image = sorted(_base_requirements() - _modal_packages())
    if missing_from_image:
        problems.append(
            "the Modal image does not install "
            + ", ".join(missing_from_image)
            + " — `mailwoman_train` imports these, so a run fails inside the container rather than here"
        )

    opset = _export_opset()
    if opset is None:
        problems.append(f"could not read the export opset from {EXPORT_ONNX.name}")
    elif opset > MAX_OPSET:
        problems.append(f"export opset is {opset} but the onnxruntime-web invariant requires <= {MAX_OPSET}")

    web_versions = _onnxruntime_web_versions()
    python_runtime = pyproject.get("onnxruntime")
    for relative, version in web_versions.items():
        if version is None:
            problems.append(
                f"{relative}: no `onnxruntime-web` version found — this check reads a file it no longer guards"
            )
        elif python_runtime and version != python_runtime:
            problems.append(
                f"{relative}: onnxruntime-web {version} but pyproject pins onnxruntime=={python_runtime} — "
                "the graph would be quantized by one runtime and executed by another"
            )

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
        f"[verify-toolchain] onnxruntime:     python {python_runtime}, web "
        + ", ".join(f"{name} {version or '(none)'}" for name, version in web_versions.items())
    )
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

    print("[verify-toolchain] OK — pyproject, Modal image, export opset, the onnxruntime pair and the ruff pin agree.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
