"""The table generates exactly what the 57 hand-written sync functions do.

This is the check the census exists for. `launch/corpora.py` holds one row per corpus version and
`plan_sync` assembles the commands; the fixture holds what the clones produce today, extracted from
their source. If the two agree for every version, the table can replace them.

The table stores the PARTS of a command — a source path, a destination path, a flag set — and
`plan_sync` builds the string. That is what keeps this a real check: a table storing whole command
strings would compare a stored string against itself and pass however wrong the command was.

A failure names the version whose generated commands differ. Fix the row, never the fixture: the
fixture is what the launcher does today, and editing it to match a wrong row is how a corpus
version silently stops being staged.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from launch.corpora import CORPUS_VERSIONS
from launch.plan import plan_sync

FIXTURE = Path(__file__).with_name("sync-census.json")


def _census() -> dict[str, dict[str, list[str]]]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_table_covers_every_sync_function() -> None:
    """A version missing from the table is a corpus nobody can stage any more."""
    expected = {name.removeprefix("sync_") for name in _census()}
    assert set(CORPUS_VERSIONS) == expected, (
        f"missing from the table: {sorted(expected - set(CORPUS_VERSIONS))}; "
        f"invented: {sorted(set(CORPUS_VERSIONS) - expected)}"
    )


@pytest.mark.parametrize("version", sorted(CORPUS_VERSIONS))
def test_each_version_generates_what_its_function_ran(version: str) -> None:
    census = _census()[f"sync_{version}"]
    plan = plan_sync(CORPUS_VERSIONS[version])

    assert plan.rclone_commands == census["rclone_commands"], f"{version}: transfers differ"
    assert sorted(plan.check_paths) == census["check_paths"], f"{version}: verified paths differ"
    assert sorted(set(plan.pycache_paths)) == census["pycache_paths"], f"{version}: pycache clears differ"


def test_the_totals_match_the_measured_census() -> None:
    """Totals as well as per-version equality: a row that drops a copy AND gains one would pass
    every per-version list comparison only if both lists agreed, but the totals make the size of
    the whole table visible in one number."""
    plans = [plan_sync(entry) for entry in CORPUS_VERSIONS.values()]
    assert sum(len(plan.rclone_commands) for plan in plans) == 137
    assert sum(len(plan.check_paths) for plan in plans) == 317
