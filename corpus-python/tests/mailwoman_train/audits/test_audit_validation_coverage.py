"""The validation-coverage audit's two readings, and its refusal to read an unreadable split as one holding no rows."""

from typing import Any

import pytest

from mailwoman_train.audits.validation_coverage import blind_countries, failing_requirements, scan_split
from mailwoman_train.config import ValidationCoverageConfig


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
    with pytest.raises(FileNotFoundError, match="absence of FILES"):
        scan_split([])


def test_a_met_floor_reports_no_failure() -> None:
    report = _report({"val": {"US": {"rows": 1_839_635, "street_rows": 1_780_240}}})
    required = [ValidationCoverageConfig(country="US", split="val", min_rows=1000, min_street_rows=500)]

    assert failing_requirements(report, required) == []


def test_a_country_the_split_holds_nothing_for_fails_on_both_counts() -> None:
    report = _report({"val": {"US": {"rows": 100, "street_rows": 96}}})
    required = [ValidationCoverageConfig(country="GB", split="val", min_rows=1000, min_street_rows=500)]

    failures = failing_requirements(report, required)

    assert len(failures) == 1
    assert failures[0]["rows"] == 0
    assert failures[0]["street_rows"] == 0
    assert "0 rows against a floor of 1,000" in failures[0]["because"]
    assert "0 street rows against a floor of 500" in failures[0]["because"]


def test_a_country_with_rows_and_no_street_rows_fails_the_street_floor_alone() -> None:
    report = _report({"val": {"FR": {"rows": 12_898, "street_rows": 0}}})
    required = [ValidationCoverageConfig(country="FR", split="val", min_rows=1000, min_street_rows=500)]

    failures = failing_requirements(report, required)

    assert len(failures) == 1
    assert failures[0]["because"] == "0 street rows against a floor of 500"


def test_a_floor_naming_a_split_the_report_lacks_is_a_failure_rather_than_a_pass() -> None:
    report = _report({"val": {"US": {"rows": 100, "street_rows": 96}}})
    required = [ValidationCoverageConfig(country="US", split="test", min_rows=1)]

    assert failing_requirements(report, required) == [
        {"country": "US", "split": "test", "because": "the report carries no test split"}
    ]
