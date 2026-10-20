"""The trainer reads a corpus file of either row schema, and the Python writers stamp the register's license id.

A v0.7.x file holds `corpus_version` and `recipe` columns. A file written since #2741 holds `augmentation` and a
`license` column with an SPDX or `LicenseRef-*` id. The training configs point at v0.7.x corpora, so the loader must read both. It
reads only the columns it trains on, so the two files yield the same rows.
"""

from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.data.loader.parquet import _file_row_iter
from mailwoman_train.source_rights import RowLicenseError, committed_source_rights, stamp_row_licenses


def _base(source_id: str) -> dict:
    return {
        "raw": "1 Main St",
        "tokens": ["1", "Main", "St"],
        "labels": ["B-house_number", "B-street", "I-street"],
        "span_starts": [0, 2],
        "span_ends": [1, 9],
        "span_tags": ["house_number", "street"],
        "country": "US",
        "source": "tiger",
        "source_id": source_id,
        "register": "us-census-tiger",
        "surface": "attested",
        "base_source_id": None,
    }


def _write(path: Path, rows: list[dict]) -> Path:
    pq.write_table(pa.Table.from_pylist(rows), path)
    return path


def _read(path: Path) -> list[dict]:
    rows = _file_row_iter(
        path,
        expected_source="tiger",
        rng=random.Random(0),
        country_weights={"US": 1.0},
        max_weight=1.0,
        coarse_filter=False,
    )
    return sorted(rows, key=lambda row: row["raw"])


def test_the_loader_reads_an_older_and_a_current_file_alike(tmp_path: Path) -> None:
    old = _write(
        tmp_path / "old.parquet",
        [{**_base("t-1"), "corpus_version": "0.7.0-de-holdout", "license": "public domain", "recipe": None}],
    )
    current = _write(
        tmp_path / "current.parquet",
        [{**_base("t-1"), "license": committed_source_rights().row_license("tiger"), "augmentation": None}],
    )

    old_rows = _read(old)
    current_rows = _read(current)

    assert len(old_rows) == 1
    assert old_rows == current_rows
    assert set(old_rows[0]) == {"raw", "tokens", "labels", "country", "source", "span_starts", "span_ends", "span_tags"}


def test_the_writer_stamps_the_register_id_over_the_producer_statement() -> None:
    (row,) = stamp_row_licenses([{**_base("t-1"), "license": "TIGER/Line, public domain"}], context="test")
    assert row["license"] == committed_source_rights().row_license("tiger")


def test_the_writer_refuses_a_source_without_a_license_id() -> None:
    # `synthetic-secondary` is mapped to authored inputs only, and an unmapped source has no entry at all.
    for source in ("synthetic-secondary", "never-mapped-source"):
        assert committed_source_rights().row_license(source) is None
        with pytest.raises(RowLicenseError, match="have no license id"):
            stamp_row_licenses([{**_base("x-1"), "source": source}], context="test")


def test_the_python_and_typescript_readings_agree_on_a_multi_input_source() -> None:
    # `rendered-gb` reads an OS OpenData row and a refused Price Paid Data row, so its id joins two terms.
    license_id = committed_source_rights().row_license("rendered-gb")
    assert license_id is not None
    assert license_id.split(" AND ") == sorted(license_id.split(" AND "))
    assert "OGL-UK-3.0" in license_id.split(" AND ")
