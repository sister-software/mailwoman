"""The launcher's 57 sync functions, pinned before anything moves them.

Nothing imports `launch/train_remote.py`: it pulls in the Modal SDK, talks to a volume, and every
function in it is a deployment entry point. A green suite therefore says nothing about it, which is
why renaming the directory or collapsing the 57 near-identical clones into a table would otherwise
be unverifiable — and a sync that silently stops staging one corpus version is a launch that trains
on the wrong data and reports success.

`sync-census.json` is what the file does today: every rclone command, every path checked, every
`__pycache__` cleared, resolved to concrete strings. Do NOT regenerate it after a change to the
launcher — that asserts the new code against itself. Regenerate it only when a sync function is
deliberately added or edited, and say which in the commit message.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from .extract_current import extract_sync_functions

LAUNCHER = Path(__file__).resolve().parents[2] / "launch" / "train_remote.py"
FIXTURE = Path(__file__).with_name("sync-census.json")

#: Measured on the pre-collapse file. Task 13 collapses the clones into a table and these must not
#: move: a table that generates fewer commands stages less corpus.
EXPECTED_FUNCTIONS = 57
EXPECTED_RCLONE_COMMANDS = 194
EXPECTED_CHECK_PATHS = 317


def _census() -> dict[str, dict[str, list[str]]]:
    specs = extract_sync_functions(LAUNCHER.read_text(encoding="utf-8"))
    return {
        name: {
            "rclone_commands": spec.rclone_commands,
            "check_paths": sorted(spec.check_paths),
            "pycache_paths": sorted(set(spec.pycache_paths)),
        }
        for name, spec in sorted(specs.items())
    }


def test_the_launcher_matches_its_pinned_census() -> None:
    actual = _census()
    expected = json.loads(FIXTURE.read_text(encoding="utf-8"))

    assert set(actual) == set(expected), (
        f"sync functions added: {sorted(set(actual) - set(expected))}; removed: {sorted(set(expected) - set(actual))}"
    )
    for name in sorted(expected):
        assert actual[name] == expected[name], f"{name} no longer stages what it staged"


def test_the_census_resolves_every_interpolation() -> None:
    """A `{package}` left in a pinned string compares equal to itself and names no file.

    Without this the census can look complete while pinning placeholders, which is the failure
    mode that makes an instrument worse than none.
    """
    specs = extract_sync_functions(LAUNCHER.read_text(encoding="utf-8"))
    holes = {name: spec.unresolved_count for name, spec in specs.items() if spec.unresolved_count}
    assert holes == {}, f"unresolved interpolations: {holes}"


def test_the_census_is_the_measured_size() -> None:
    specs = extract_sync_functions(LAUNCHER.read_text(encoding="utf-8"))
    assert len(specs) == EXPECTED_FUNCTIONS
    assert sum(len(spec.rclone_commands) for spec in specs.values()) == EXPECTED_RCLONE_COMMANDS
    assert sum(len(spec.check_paths) for spec in specs.values()) == EXPECTED_CHECK_PATHS


@pytest.mark.parametrize(
    ("description", "removed"),
    [
        ("an rclone command", 'f"rclone copy :s3:{BUCKET}/corpus/v8-kr-2026-09-06/ '),
        ("a verified path", '"KR val part": os.path.isfile(f"{kr}/val/kr-part-0000.parquet"),'),
    ],
)
def test_the_extractor_sees_a_dropped_line(description: str, removed: str) -> None:
    """The census is only a pin if deleting a line changes it.

    Each case removes one line from a copy of the launcher in memory and asserts the census moves.
    A census that survived the deletion would pass every future comparison while the launcher
    quietly staged less.
    """
    source = LAUNCHER.read_text(encoding="utf-8")
    kept = [line for line in source.splitlines(keepends=True) if removed not in line]
    assert len(kept) < len(source.splitlines()), f"the fixture line for {description} is not in the launcher"

    before = extract_sync_functions(source)
    after = extract_sync_functions("".join(kept))
    assert after != before, f"the extractor does not see {description} disappear"
