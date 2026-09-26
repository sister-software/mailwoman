"""Every module that runs as `python -m` imports, and its usage string names its own path; discovery is by the `__main__` guard rather than a list, so a new builder is covered by existing."""

from __future__ import annotations

import ast
import importlib
from pathlib import Path

import pytest

from tests import paths

SOURCE_ROOT = paths.SOURCE_ROOT


def _module_name(path: Path) -> str:
    relative = path.relative_to(SOURCE_ROOT).with_suffix("")
    return ".".join(["mailwoman_train", *(part for part in relative.parts if part != "__init__")])


def _invocation_name(path: Path) -> str:
    """What follows `python -m`. A `__main__.py` is invoked by its PACKAGE name rather than its own."""
    name = _module_name(path)
    return name.rsplit(".", 1)[0] if name.endswith(".__main__") else name


def _runnable_modules() -> list[Path]:
    """Every module carrying an `if __name__ == "__main__"` block."""
    found: list[Path] = []
    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            if not isinstance(node, ast.If):
                continue
            test = node.test
            if (
                isinstance(test, ast.Compare)
                and isinstance(test.left, ast.Name)
                and test.left.id == "__name__"
                and any(isinstance(c, ast.Constant) and c.value == "__main__" for c in test.comparators)
            ):
                found.append(path)
                break
    return found


RUNNABLE = _runnable_modules()


def test_the_discovery_found_the_builders() -> None:
    """Compared by invocation name, so a builder that moves its guard into `__main__.py` still answers to the command a person types; an empty discovery would pass every test below."""
    names = {_invocation_name(path) for path in RUNNABLE}
    assert {"mailwoman_train.corpora.fragment", "mailwoman_train.countries.jp.corpora"} <= names
    assert len(RUNNABLE) >= 7


@pytest.mark.parametrize("path", RUNNABLE, ids=_module_name)
def test_a_runnable_module_imports(path: Path) -> None:
    """Import alone, which is where a moved data file or a stale relative import raises."""
    importlib.import_module(_module_name(path))


@pytest.mark.parametrize("path", RUNNABLE, ids=_module_name)
def test_a_usage_string_names_the_module_it_is_written_in(path: Path) -> None:
    """A docstring's `python -m …` line is a command someone copies, so a move must not leave it naming a path that no longer resolves."""
    name = _invocation_name(path)
    docstring = ast.get_docstring(ast.parse(path.read_text(encoding="utf-8"))) or ""
    for line in docstring.splitlines():
        # Only a line that begins with the command is a usage line; prose mentioning it in passing
        # refers to another module's entry point.
        stripped = line.strip().removeprefix("uv run ")
        if not stripped.startswith("python -m mailwoman_train"):
            continue
        # The whole token after `-m`, not a substring: a lost space turns `…corpora.registry tw`
        # into `…corpora.registrytw`, which contains the module name but is not it.
        documented = stripped.split()[2]
        assert documented == name, f"{name} documents `{stripped}`"
