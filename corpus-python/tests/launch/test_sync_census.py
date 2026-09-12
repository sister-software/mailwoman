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

import ast
import json
from pathlib import Path

import pytest

from .extract_current import extract_sync_functions

LAUNCHER = Path(__file__).resolve().parents[2] / "launch" / "train_remote.py"
FIXTURE = Path(__file__).with_name("sync-census.json")

#: Measured on the pre-collapse file. A table that generates fewer commands stages less corpus.
EXPECTED_FUNCTIONS = 57
EXPECTED_RCLONE_COMMANDS = 137
EXPECTED_CHECK_PATHS = 317

#: Functions whose command count cannot equal their count of `rclone copy` literals, with the
#: reason. Every other function must match exactly — see the cross-check below for why that
#: comparison is the one that catches a census which is wrong but self-consistent.
EXPANDS_DIFFERENTLY = {
    "sync_assets": "parameterized: it builds commands from runtime arguments, so none are static",
    "sync_v8cjk_regs": "one literal is a generator over a 7-name tuple, so 3 literals are 9 commands",
}


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


def _rclone_literals(node: ast.FunctionDef) -> int:
    """Count `rclone copy` string literals, reading the source rather than interpreting it.

    `ast.walk` yields an f-string as a JoinedStr AND as its leading Constant, so a naive walk counts
    every command twice — the same double-count this check exists to catch.
    """
    nested = {id(child) for sub in ast.walk(node) if isinstance(sub, ast.JoinedStr) for child in ast.walk(sub)}
    total = 0
    for sub in ast.walk(node):
        if isinstance(sub, ast.JoinedStr) and sub.values:
            first = sub.values[0]
            if isinstance(first, ast.Constant) and str(first.value).startswith("rclone copy"):
                total += 1
        elif isinstance(sub, ast.Constant) and id(sub) not in nested and str(sub.value).startswith("rclone copy"):
            total += 1
    return total


def test_every_command_traces_to_one_literal_in_the_source() -> None:
    """The extractor's count, checked against the source by a second method.

    The census is compared against itself everywhere else, so a census that is WRONG but consistent
    passes every other test here. Two defects of that shape shipped: `for cmd in cmds:` re-read a
    list the assignment above had already recorded, doubling 64 commands, and a starred generator
    resolved to nothing, dropping 7. Both are visible only against an independent count.
    """
    tree = ast.parse(LAUNCHER.read_text(encoding="utf-8"))
    specs = extract_sync_functions(LAUNCHER.read_text(encoding="utf-8"))
    mismatched: dict[str, tuple[int, int]] = {}
    for node in tree.body:
        if not (isinstance(node, ast.FunctionDef) and node.name.startswith("sync_")):
            continue
        if node.name in EXPANDS_DIFFERENTLY:
            continue
        literals = _rclone_literals(node)
        extracted = len(specs[node.name].rclone_commands)
        if literals != extracted:
            mismatched[node.name] = (literals, extracted)
    assert mismatched == {}, f"literals vs extracted: {mismatched}"


def test_the_exceptions_are_still_exceptional() -> None:
    """A named exception that starts matching is a stale entry, not a passing check."""
    tree = ast.parse(LAUNCHER.read_text(encoding="utf-8"))
    specs = extract_sync_functions(LAUNCHER.read_text(encoding="utf-8"))
    by_name = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    for name in EXPANDS_DIFFERENTLY:
        literals = _rclone_literals(by_name[name])
        extracted = len(specs[name].rclone_commands)
        assert literals != extracted, f"{name} now matches — delete it from EXPANDS_DIFFERENTLY"


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
