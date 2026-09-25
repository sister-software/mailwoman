"""Checks that the corpus sync table stages what the original per-version sync functions staged.

`launch/corpora.py` holds one row per corpus version, and `plan_sync` builds the transfers from it.
`sync-census.json` is a hand-kept pin of the rclone commands, verified paths and `__pycache__`
clears that the original functions ran. No code regenerates it.

When a version fails, fix its table row. Edit the fixture only when a version's staging is meant to
change, and say which version and why in the commit message.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from launch.corpora import CORPUS_VERSIONS
from launch.plan import corpus_versions, plan_sync

from tests import paths

FIXTURE = Path(__file__).with_name("sync-census.json")
PACKAGE_SOURCE = paths.SOURCE_ROOT


def _census() -> dict[str, dict[str, list[str]]]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_table_covers_every_version_the_census_recorded() -> None:
    """Require the table and the census to list the same corpus versions."""
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
    """Require each transfer to expose its source and destination as separate fields.

    rclone exits 0 when the source prefix is empty, so the runner counts the files in `destination`
    to detect an empty copy.
    """
    for transfer in plan_sync(CORPUS_VERSIONS[version]).transfers:
        assert transfer.source.startswith(":s3:"), f"{version}: {transfer.source} is not a bucket path"
        assert transfer.destination.startswith("/data/"), f"{version}: {transfer.destination} is not on the volume"
        assert f"{transfer.source} {transfer.destination}" in transfer.command


def test_every_verified_package_path_exists() -> None:
    """Require every package path the table verifies to exist in the source tree.

    The sync raises "staging incomplete" when a verified file is missing, so a moved file would block
    every launch of that corpus version. This reads the table because the launcher runs the table.
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
    """Require the table to list its corpus versions by name.

    `corpus()` records each version name, and `launch/stage.py` reads its corpora from the same rows.
    """
    versions = {version for entry in CORPUS_VERSIONS.values() for version in corpus_versions(entry)}

    assert len(versions) == 28, sorted(versions)
    assert "v0.30.0-bare-postcode" in versions
    assert "v8-cjk-regs-2026-09-08" in versions
    # Each entry must be a bare version name. A slash means a row stored a literal path.
    assert not [version for version in versions if "/" in version]


def test_the_totals_match_the_measured_census() -> None:
    """Pin the total transfer and verified-path counts across the whole table."""
    plans = [plan_sync(entry) for entry in CORPUS_VERSIONS.values()]
    assert sum(len(plan.rclone_commands) for plan in plans) == 59
    assert sum(len(plan.check_paths) for plan in plans) == 167
