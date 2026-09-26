"""Checks that the `modal run` command in each recipe header still resolves.

These tests check that the launcher module, the named recipe, the selected function and the staged
corpus version all still exist. Only `modal run` commands are checked: a header's local
`python -m mailwoman_train train --config <path>` command takes a filesystem path instead of the
bare filename the launcher expects.
"""

from __future__ import annotations

import ast
import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from launch.corpora import CORPUS_VERSIONS

from tests import paths

CONFIGS = paths.CONFIGS
ENTRY_POINT = paths.PACKAGE_ROOT / "launch" / "train_remote.py"

#: A backslash line continuation inside a comment, joined so a command split across lines keeps
#: its `--config` argument.
CONTINUATION = re.compile(r"\\\n#\s*")

#: `modal run` followed by arguments; the required whitespace skips prose mentions where a
#: backtick follows immediately.
MODAL_RUN = re.compile(r"modal run\s+([^\n`]+)")

#: Mentions of `modal volume put`, and the subset that warns against it; any other mention reads
#: as an instruction to use it.
BLIND_STAGING = re.compile(r"modal volume put\b")
WARNED_AGAINST = re.compile(r"\bnot `?modal volume put\b", re.IGNORECASE)

NAMED_CONFIG = re.compile(r"--config\s+(\S+)")
NAMED_VERSION = re.compile(r"::sync\s+--version\s+(\S+)")
NAMED_FUNCTION = re.compile(r"launch\.train_remote::([A-Za-z_][A-Za-z_0-9]*)")

RECIPES = sorted(CONFIGS.glob("*.yaml"))
PRESENT = {path.name for path in RECIPES}


def _launchable() -> set[str]:
    """Return the function names that `launch.train_remote` exports in `__all__`, parsed rather than imported because the module imports the Modal SDK, which this checkout does not install."""
    tree = ast.parse(ENTRY_POINT.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "__all__" for t in node.targets):
            return {element.value for element in node.value.elts}
    raise AssertionError(f"{ENTRY_POINT} declares no __all__")


LAUNCHABLE = _launchable()


def _modal_commands(recipe: Path) -> Iterator[str]:
    """Yield the arguments of each `modal run` command in the recipe."""
    return (match.group(1) for match in MODAL_RUN.finditer(CONTINUATION.sub(" ", recipe.read_text(encoding="utf-8"))))


def test_there_are_recipes_to_check() -> None:
    """Guard against a glob that matches no file and makes every recipe test pass vacuously."""
    assert len(RECIPES) > 100, f"only {len(RECIPES)} recipes found under {CONFIGS}"


def test_some_recipe_carries_a_modal_command() -> None:
    """Guard against a `MODAL_RUN` pattern that matches no recipe."""
    assert any(any(_modal_commands(recipe)) for recipe in RECIPES)


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda p: p.name)
def test_the_launcher_is_named_as_a_module(recipe: Path) -> None:
    """Require `-m launch.train_remote` in every `modal run` command; Modal imports a file path as a top-level module, so the launcher's relative imports fail."""
    for arguments in _modal_commands(recipe):
        assert "-m launch.train_remote" in arguments, (
            f"{recipe.name}: `modal run {arguments}` does not name the launcher as a module"
        )


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda p: p.name)
def test_every_named_recipe_exists(recipe: Path) -> None:
    """Require each `--config` value to be the filename of a recipe under `configs/`; the launcher joins `--config` onto its configs directory, so a path finds no file."""
    for arguments in _modal_commands(recipe):
        for named in NAMED_CONFIG.findall(arguments):
            if named.startswith("<"):  # A `<placeholder>` is the reader's to fill in.
                continue
            assert named in PRESENT, f"{recipe.name}: --config {named} names no file under configs/"


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda p: p.name)
def test_every_selected_function_can_be_launched(recipe: Path) -> None:
    """Require each `::<name>` in a command to be exported by the launcher."""
    for arguments in _modal_commands(recipe):
        for named in NAMED_FUNCTION.findall(arguments):
            assert named in LAUNCHABLE, (
                f"{recipe.name}: ::{named} is not exported by launch/train_remote.py; "
                f"launchable: {', '.join(sorted(LAUNCHABLE))}"
            )


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda p: p.name)
def test_no_recipe_tells_the_reader_to_stage_blind(recipe: Path) -> None:
    """Allow `modal volume put` in a recipe only inside a warning against it.

    A file written that way is invisible to a mounted container even after `vol.reload()`, so the
    run trains on stale data and still reports success. A line passes when every mention is
    preceded by "not".
    """
    for line in recipe.read_text(encoding="utf-8").splitlines():
        mentions = len(BLIND_STAGING.findall(line))
        warnings = len(WARNED_AGAINST.findall(line))
        assert mentions == warnings, (
            f"{recipe.name}: `modal volume put` cannot stage anything a run will read — "
            f"upload to R2 and use sync_assets instead: {line.strip()}"
        )


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda p: p.name)
def test_every_staged_version_is_in_the_table(recipe: Path) -> None:
    """Require each `sync --version` key to be a row in `launch/corpora.py`."""
    for arguments in _modal_commands(recipe):
        for named in NAMED_VERSION.findall(arguments):
            assert named in CORPUS_VERSIONS, (
                f"{recipe.name}: --version {named} is not a row in launch/corpora.py; "
                f"known: {', '.join(sorted(CORPUS_VERSIONS))}"
            )
