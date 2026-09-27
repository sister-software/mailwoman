from __future__ import annotations

import ast
import subprocess  # nosec B404
from pathlib import Path

from tests import paths

CORPUS_PYTHON = paths.PACKAGE_ROOT
SOURCE_ROOT = paths.SOURCE_ROOT


ENV_MODULE = SOURCE_ROOT / "env.py"


MACHINE_PATH_ROOTS = ("/mnt/", "/media/", "/home/", "/Users/")


SELF = Path(__file__).resolve()


MACHINE_PATH_BASELINE: frozenset[str] = frozenset()


ENVIRONMENT_READ_BASELINE: frozenset[str] = frozenset()


def _tracked_python_files() -> list[Path]:
    out = subprocess.run(  # nosec B603 B607
        ["git", "ls-files", "*.py", "*.yaml", "*.yml"],
        cwd=CORPUS_PYTHON,
        capture_output=True,
        text=True,
        check=True,
    )
    return [CORPUS_PYTHON / line for line in out.stdout.splitlines() if line]


ENVIRONMENT_NAMES = frozenset({"environ", "getenv", "environb"})


def _reads_environment(tree: ast.AST) -> list[int]:
    found: list[int] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in ENVIRONMENT_NAMES:
            found.append(node.lineno)
        elif isinstance(node, ast.ImportFrom) and node.module == "os":
            found.extend(node.lineno for alias in node.names if alias.name in ENVIRONMENT_NAMES)
        elif isinstance(node, ast.Name) and node.id in ENVIRONMENT_NAMES:
            found.append(node.lineno)
    return sorted(set(found))


def test_only_the_env_module_reads_the_environment() -> None:
    offenders: dict[str, list[int]] = {}
    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        if path == ENV_MODULE:
            continue
        lines = _reads_environment(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
        if lines:
            offenders[str(path.relative_to(CORPUS_PYTHON))] = lines

    introduced = sorted(set(offenders) - ENVIRONMENT_READ_BASELINE)
    assert introduced == [], (
        "these modules read the environment directly; declare the variable in env.py and read it "
        "through public()/private() instead:\n" + "\n".join(f"  {name}: {offenders[name]}" for name in introduced)
    )

    fixed = sorted(ENVIRONMENT_READ_BASELINE - set(offenders))
    assert fixed == [], f"these no longer read the environment — drop them from the baseline: {fixed}"


def test_no_tracked_file_names_a_machine() -> None:
    offenders: dict[str, list[int]] = {}
    for path in _tracked_python_files():
        if not path.is_file() or path.resolve() == SELF:
            continue
        hits = [
            number
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
            if any(root in line for root in MACHINE_PATH_ROOTS)
        ]
        if hits:
            offenders[str(path.relative_to(CORPUS_PYTHON))] = hits

    introduced = sorted(set(offenders) - MACHINE_PATH_BASELINE)
    assert introduced == [], (
        "these files name a path that exists on one machine; use $MAILWOMAN_DATA_ROOT or a "
        "paths.py helper:\n" + "\n".join(f"  {name}: {offenders[name]}" for name in introduced)
    )

    fixed = sorted(MACHINE_PATH_BASELINE - set(offenders))
    assert fixed == [], f"these no longer name a machine — drop them from the baseline: {fixed}"
