"""`env.py` is the only module that reads the environment, and no tracked file names a machine.

The counterpart of `oxlint.config.ts` refusing a `node:*` import outside `@mailwoman/core`. Both
rules exist for the same reason: a setting read in one place can be changed in one place, and a
path that names somebody's machine is correct on exactly that machine.
"""

from __future__ import annotations

import ast
import subprocess  # nosec B404 — reads the tracked file list from git, no user input
from pathlib import Path

CORPUS_PYTHON = Path(__file__).resolve().parents[2]
SOURCE_ROOT = CORPUS_PYTHON / "src" / "mailwoman_train"

#: The one module allowed to read `os.environ`, by the same logic that lets `@mailwoman/core/fs`
#: import `node:fs`: a funnel is only a funnel if everything goes through it.
ENV_MODULE = SOURCE_ROOT / "env.py"

#: Paths that exist on one machine. A literal matching any of these is refused wherever it appears,
#: docstrings and usage examples included: an example a reader copies is a path they then have to
#: debug. Write `$MAILWOMAN_DATA_ROOT` instead.
MACHINE_PATHS = ("/mnt/playpen", "/home/lab", "/mnt/nexus")

#: This file, which has to contain the patterns above to search for them. The only exemption, and it
#: is structural rather than a suppression: a check cannot name what it refuses without writing it.
SELF = Path(__file__).resolve()

#: Files still carrying a machine path, each with what replaces it. The list only shrinks; a new
#: entry means one was added, which is what this refuses.
MACHINE_PATH_BASELINE: frozenset[str] = frozenset()

#: Modules still reading `os.environ` directly. The launcher is outside this package and loads the
#: checkout's untracked `.env` itself, before any of this package is importable.
ENVIRONMENT_READ_BASELINE: frozenset[str] = frozenset()


def _tracked_python_files() -> list[Path]:
    out = subprocess.run(  # nosec B603 B607 — fixed argv, no shell
        ["git", "ls-files", "*.py", "*.yaml", "*.yml"],
        cwd=CORPUS_PYTHON,
        capture_output=True,
        text=True,
        check=True,
    )
    return [CORPUS_PYTHON / line for line in out.stdout.splitlines() if line]


#: Attribute and function names that read the process environment, whatever they are reached
#: through. Matching the NAME rather than `os.<name>` is deliberate: `import os as _os` and
#: `__import__("os").environ` both reach the same place, and a check that only knows the literal
#: spelling `os` passes over both. Nothing else in this package has an attribute by these names, so
#: the cost of the wider match is nil — and a false positive here is loud, where a miss is silent.
ENVIRONMENT_NAMES = frozenset({"environ", "getenv", "environb"})


def _reads_environment(tree: ast.AST) -> list[int]:
    """Line numbers where this module reaches the process environment."""
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
            if any(machine in line for machine in MACHINE_PATHS)
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
