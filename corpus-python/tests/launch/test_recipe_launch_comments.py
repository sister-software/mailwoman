"""Every recipe's launch comment names a command that still works.

A recipe header carries the command that trains it. Those commands have gone stale three times —
`scripts/modal/` became `corpus-python/modal/` became `corpus-python/launch/` — and each time the
rot was invisible, because a comment nobody executes cannot fail. Whoever reads the header types a
path that has not existed for months.

So the command shape is checked rather than documented. The three questions below are the ones a
reader's shell would ask: is the launcher named the way Modal can resolve it, does the recipe it
names exist, and is the version it stages still in the table.

Every check is scoped to a `modal run` command. A recipe header also carries local-CLI commands —
`python -m mailwoman_train train --config <path>` — whose `--config` takes a filesystem path,
the opposite of what the launcher takes; scanning the whole file would flag those as broken.
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

#: A shell line continued into the next comment line. Joined before matching, so a command split
#: across `\` still reads as one command and its `--config` is not lost with the tail.
CONTINUATION = re.compile(r"\\\n#\s*")

#: `modal run` followed by arguments. The space is what separates a command from the prose mention
#: "(2) `modal run`." — there, a backtick follows immediately.
MODAL_RUN = re.compile(r"modal run\s+([^\n`]+)")

#: Every mention of the blind staging command, and the subset that warns AGAINST it. A mention the
#: warning form does not cover is an instruction to use it.
BLIND_STAGING = re.compile(r"modal volume put\b")
WARNED_AGAINST = re.compile(r"\bnot `?modal volume put\b", re.IGNORECASE)

NAMED_CONFIG = re.compile(r"--config\s+(\S+)")
NAMED_VERSION = re.compile(r"::sync\s+--version\s+(\S+)")
#: The function a command selects with `::`.
NAMED_FUNCTION = re.compile(r"launch\.train_remote::([A-Za-z_][A-Za-z_0-9]*)")

RECIPES = sorted(CONFIGS.glob("*.yaml"))
PRESENT = {path.name for path in RECIPES}


def _launchable() -> set[str]:
    """The names `modal run -m launch.train_remote::<name>` can resolve, read from `__all__`.

    By AST rather than by import: the entry module pulls in the Modal SDK, which is installed
    wherever `modal run` runs and not in this checkout. `__all__` is the declared surface and the
    entry module's own reason for existing, so a name absent from it is a name nobody can launch.
    """
    tree = ast.parse(ENTRY_POINT.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "__all__" for t in node.targets):
            return {element.value for element in node.value.elts}
    raise AssertionError(f"{ENTRY_POINT} declares no __all__")


LAUNCHABLE = _launchable()


def _modal_commands(recipe: Path) -> Iterator[str]:
    """The arguments of each `modal run` in this recipe's header."""
    return (match.group(1) for match in MODAL_RUN.finditer(CONTINUATION.sub(" ", recipe.read_text(encoding="utf-8"))))


def test_there_are_recipes_to_check() -> None:
    """Without this, a glob that stops matching turns every check below green."""
    assert len(RECIPES) > 100, f"only {len(RECIPES)} recipes found under {CONFIGS}"


def test_some_recipe_carries_a_modal_command() -> None:
    """Likewise: a matcher that stops matching makes the per-recipe checks vacuous."""
    assert any(any(_modal_commands(recipe)) for recipe in RECIPES)


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda p: p.name)
def test_the_launcher_is_named_as_a_module(recipe: Path) -> None:
    """`modal run <file>` cannot import the launcher package — it must be `-m launch.train_remote`.

    Modal imports a file path as a TOP-LEVEL module with that file's own directory on `sys.path`,
    so `launch` is unimportable and the package's relative imports raise. The failure is loud when
    it happens, but only after someone has typed the command; this catches the comment instead.
    """
    for arguments in _modal_commands(recipe):
        assert "-m launch.train_remote" in arguments, (
            f"{recipe.name}: `modal run {arguments}` does not name the launcher as a module"
        )


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda p: p.name)
def test_every_named_recipe_exists(recipe: Path) -> None:
    """The launcher joins `--config` onto its own configs directory, so it takes a BARE FILENAME.

    A path there resolves under `configs/` and finds nothing; a deleted recipe fails the same way.
    """
    for arguments in _modal_commands(recipe):
        for named in NAMED_CONFIG.findall(arguments):
            if named.startswith("<"):  # a placeholder the reader fills in
                continue
            assert named in PRESENT, f"{recipe.name}: --config {named} names no file under configs/"


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda p: p.name)
def test_every_selected_function_can_be_launched(recipe: Path) -> None:
    """A `::<name>` the launcher no longer exports is a command that fails before it starts.

    The collapse of twenty `sync_*` clones into one `sync --version <key>` left nine headers naming
    a function that had been deleted, and the path swap alone would not have found them: the module
    part was correct and only the name after `::` was dead.
    """
    for arguments in _modal_commands(recipe):
        for named in NAMED_FUNCTION.findall(arguments):
            assert named in LAUNCHABLE, (
                f"{recipe.name}: ::{named} is not exported by launch/train_remote.py; "
                f"launchable: {', '.join(sorted(LAUNCHABLE))}"
            )


@pytest.mark.parametrize("recipe", RECIPES, ids=lambda p: p.name)
def test_no_recipe_tells_the_reader_to_stage_blind(recipe: Path) -> None:
    """`modal volume put` writes what a mounted container cannot see.

    The file lands, `modal volume ls/get` shows it, and `vol.reload()` does not bridge the gap
    (verified 2026-06-12 with a marker file). A run staged that way reads whatever was on the volume
    already and reports success — the corpus is wrong and nothing says so. Sixteen v0.9.x headers
    instructed it, written before the blindness was found.

    Naming it to warn against it is the point of the warning, so a mention the warning form covers
    stands. Comparing the two counts is what separates them: an instruction is a mention with no
    "not" in front of it.
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
    """A `--version` key the table lost is a corpus the reader cannot stage."""
    for arguments in _modal_commands(recipe):
        for named in NAMED_VERSION.findall(arguments):
            assert named in CORPUS_VERSIONS, (
                f"{recipe.name}: --version {named} is not a row in launch/corpora.py; "
                f"known: {', '.join(sorted(CORPUS_VERSIONS))}"
            )
