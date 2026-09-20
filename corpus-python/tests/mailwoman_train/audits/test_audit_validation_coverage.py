"""The validation-coverage audit's two readings, and its refusal to read absent files as absent rows.

The case it was written for is GB, which held 0 rows in both the validation and test splits of
`v0.32.0-locality-shape` while US held 1,839,635 in each. `evaluate()` reports one `val_rows` over
the whole split, so neither number reaches a run's reader (#2353).
"""

from typing import Any

import pytest

from mailwoman_train.audits.validation_coverage import blind_countries, scan_split


def _report(splits: dict[str, dict[str, dict[str, int]]]) -> dict[str, Any]:
    return {
        "corpus_dir": "/test",
        "splits": {
            split: {"files": 1, "rows": sum(e["rows"] for e in by_country.values()), "by_country": by_country}
            for split, by_country in splits.items()
        },
    }


def test_a_country_absent_from_a_split_is_reported_as_holding_no_rows() -> None:
    report = _report({"val": {"US": {"rows": 100, "street_rows": 96}}})

    assert blind_countries(report, ("US", "GB")) == {"GB": {"val": "no rows at all"}}


def test_a_country_present_with_no_street_row_is_a_different_finding() -> None:
    # Present and street-free is visible to the admin metrics and invisible to the street ones.
    # Absent is invisible to both. Collapsing them would report one repair for two problems.
    report = _report({"val": {"FR": {"rows": 12_898, "street_rows": 0}}})

    assert blind_countries(report, ("FR",)) == {"FR": {"val": "12,898 rows, none carrying a street or house number"}}


def test_a_country_holding_street_rows_in_every_split_is_not_reported() -> None:
    report = _report(
        {
            "val": {"US": {"rows": 1_839_635, "street_rows": 1_780_240}},
            "test": {"US": {"rows": 1_839_042, "street_rows": 1_779_768}},
        }
    )

    assert blind_countries(report, ("US",)) == {}


def test_a_country_blind_in_one_split_only_reports_that_split() -> None:
    report = _report(
        {
            "val": {"DE": {"rows": 38_115, "street_rows": 4_000}},
            "test": {"DE": {"rows": 33_801, "street_rows": 0}},
        }
    )

    assert blind_countries(report, ("DE",)) == {"DE": {"test": "33,801 rows, none carrying a street or house number"}}


def test_no_parquet_files_raises_rather_than_reporting_zero_coverage() -> None:
    # An unreadable split and a split holding no row for anybody would otherwise produce the same
    # table, and the second is a finding about the corpus while the first is a finding about a path.
    with pytest.raises(FileNotFoundError, match="absence of FILES"):
        scan_split([])
