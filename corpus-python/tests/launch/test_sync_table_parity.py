"""The table still stages exactly what the hand-written sync functions staged.

`launch/corpora.py` holds one row per corpus version and `plan_sync` assembles the transfers.
`sync-census.json` is the frozen record of what the fifty-seven clones this table replaced actually
ran — every rclone command, every verified path, every `__pycache__` cleared, extracted from their
source by an AST interpreter before any of them were touched. Nothing regenerates it: it is a pin,
and a pin that can be re-derived from the code it checks proves nothing.

The table stores the PARTS of a command — a source path, a destination path, a flag set — and
`plan_sync` builds the string. That is what keeps this a real check: a table storing whole command
strings would compare a stored string against itself and pass however wrong the command was.

A failure names the version whose generated transfers differ. Fix the row, never the fixture:
editing the fixture to match a wrong row is how a corpus version silently stops being staged, and
a launch against a half-staged volume trains on the wrong data and reports success.

The one exception is a DELIBERATE change to what a version stages. Then the row moves first, the
fixture row is updated to match, and the commit message says which version and why.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from launch.corpora import CORPUS_VERSIONS
from launch.plan import corpus_versions, plan_sync

FIXTURE = Path(__file__).with_name("sync-census.json")
PACKAGE_SOURCE = Path(__file__).resolve().parents[2] / "src" / "mailwoman_train"


def _census() -> dict[str, dict[str, list[str]]]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_table_covers_every_version_the_census_recorded() -> None:
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


@pytest.mark.parametrize("version", sorted(CORPUS_VERSIONS))
def test_each_transfer_names_both_endpoints(version: str) -> None:
    """The runner reads `destination` on its own, so it has to be a path and not part of a string.

    rclone exits 0 when the source prefix is empty, and the count of what landed in `destination` is
    the only thing that separates "copied nothing" from "copied". Recovering that path by splitting
    the assembled command would make the check depend on argument order.
    """
    for transfer in plan_sync(CORPUS_VERSIONS[version]).transfers:
        assert transfer.source.startswith(":s3:"), f"{version}: {transfer.source} is not a bucket path"
        assert transfer.destination.startswith("/data/"), f"{version}: {transfer.destination} is not on the volume"
        assert f"{transfer.source} {transfer.destination}" in transfer.command


def test_every_verified_package_path_exists() -> None:
    """A check naming a file the tree no longer has blocks a launch forever.

    The sync verifies the file landed and raises "staging incomplete" when it did not, so a path this
    campaign moved turns into a permanent refusal for that corpus version. `sync_v193` verified
    `postcode_shapes.py` after it became `features/postcode_shapes.py`.

    This reads the TABLE rather than the fixture, because the table is what the launcher now runs.
    """
    prefix = "/data/corpus-python/src/mailwoman_train/"
    stale = {
        f"{version}: {path.removeprefix(prefix)}"
        for version in CORPUS_VERSIONS
        for path in plan_sync(CORPUS_VERSIONS[version]).check_paths
        if path.startswith(prefix) and not (PACKAGE_SOURCE / path.removeprefix(prefix)).exists()
    }
    assert stale == set(), f"the launcher verifies paths that no longer exist: {sorted(stale)}"


def test_every_corpus_version_can_be_read_off_the_table() -> None:
    """A version must be enumerable, not just present.

    While each transfer spelled its version into two literal paths, the set of corpus versions the
    launcher knows about existed only as substrings and nobody could list it. `corpus()` records the
    name, so this answers "which versions are there" from the table itself — and `launch/stage.py`
    reads its corpora off the same row rather than retyping them.
    """
    versions = {version for entry in CORPUS_VERSIONS.values() for version in corpus_versions(entry)}

    assert len(versions) == 28, sorted(versions)
    assert "v0.30.0-bare-postcode" in versions
    assert "v8-cjk-regs-2026-09-08" in versions
    # Every one is a bare version name, never a path: a slash here means a literal crept back in.
    assert not [version for version in versions if "/" in version]


def test_the_totals_match_the_measured_census() -> None:
    """Totals as well as per-version equality: a row that drops a copy AND gains one would pass
    every per-version list comparison only if both lists agreed, but the totals make the size of
    the whole table visible in one number."""
    plans = [plan_sync(entry) for entry in CORPUS_VERSIONS.values()]
    assert sum(len(plan.rclone_commands) for plan in plans) == 59
    assert sum(len(plan.check_paths) for plan in plans) == 167
