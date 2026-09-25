"""Which countries the validation and test splits hold rows for, and how many of those rows carry a street.

WHY THIS EXISTS. `evaluate()` reports `val_loss`, `val_rows` and `macro_f1` over the whole split. A
country contributing no row to it changes none of those numbers, so a run cannot tell a locale it
validates well from a locale it does not validate at all. Measured on `v0.32.0-locality-shape`
(#2353): GB holds **0** validation rows and **0** test rows, FR holds 12,898 validation rows of which
**0** carry a street or house number, and DE's test split holds 33,801 rows of which **0** do. US
holds 1,839,635 validation rows, 1,780,240 of them with a street. Three of the four locales iron rule
6 blocks a default-on regression on therefore have no street-level validation signal.

THE SPLIT RULE PRODUCES THIS. `splitForRow` in
`packages/corpus/lib/utils/split.ts` sends a row to val or test only when its `components.region`
matches a declared holdout string for its country, and `defaultHoldouts()` names US, FR and DE. So
the splits are geographic holdouts over three countries rather than a sample of the corpus, every
other country holds zero by construction, and a street row carrying no `region` component cannot be
held out whatever the holdouts name.

WHAT TO DO WITH THE OUTPUT. Read a per-locale validation metric with its denominator beside it. A
`macro_f1` computed over a split holding no GB row makes no statement about GB, and `cross_pollution`'s
per-locale readings carry the same limit.

Scans the parquet directly rather than the loader, because the question is which rows the split
contains. What a run draws from it is a property of the sampler and is `audit_epoch_mixture`.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

import pyarrow.dataset as ds

from ..config import ValidationCoverageConfig, load_config
from ..data.loader import _parquet_paths

#: Tags whose presence makes a row street-level. A validation row carrying neither measures the
#: admin hierarchy alone, which is a different claim from parsing an address.
STREET_TAGS = frozenset({"street", "house_number"})

#: Columns the scan projects. Everything else in the row is irrelevant to the counts and reading it
#: costs the scan its speed on a split the size of US's.
COLUMNS = ["country", "span_tags", "source"]


def scan_split(files: list[Path]) -> dict[str, Any]:
    """Count rows, street rows and sources per country over one split's parquet files."""
    rows: Counter[str] = Counter()
    street_rows: Counter[str] = Counter()
    by_source: Counter[str] = Counter()

    if not files:
        raise FileNotFoundError(
            "no parquet files resolved for this split. That is an absence of FILES rather than of "
            "validation rows, and reporting it as zero coverage would state the wrong finding."
        )

    dataset = ds.dataset([str(path) for path in files], format="parquet")

    for batch in dataset.to_batches(columns=COLUMNS, batch_size=8192):
        countries = batch.column("country").to_pylist()
        tags = batch.column("span_tags").to_pylist()
        sources = batch.column("source").to_pylist()

        for country, span_tags, source in zip(countries, tags, sources, strict=True):
            key = str(country or "(none)")
            rows[key] += 1
            by_source[f"{key}/{source}"] += 1

            if STREET_TAGS.intersection(span_tags or ()):
                street_rows[key] += 1

    return {
        "files": len(files),
        "rows": sum(rows.values()),
        "countries": len(rows),
        "by_country": {
            country: {"rows": count, "street_rows": street_rows.get(country, 0)}
            for country, count in rows.most_common()
        },
        "by_country_source": dict(by_source.most_common()),
    }


def audit(corpus_dir: Path, splits: tuple[str, ...] = ("val", "test")) -> dict[str, Any]:
    """Scan each split and report per-country row and street-row counts."""
    return {
        "corpus_dir": str(corpus_dir),
        "splits": {split: scan_split(_parquet_paths(corpus_dir, split)) for split in splits},
    }


def blind_countries(report: dict[str, Any], wanted: tuple[str, ...]) -> dict[str, dict[str, str]]:
    """For each wanted country, the split in which it holds no row, or holds rows carrying no street.

    Reported per country rather than as a count, because the two readings are different findings: a
    country absent from a split is invisible to every metric the split produces, while a country
    present with no street row is visible to the admin metrics and invisible to the street ones.
    """
    findings: dict[str, dict[str, str]] = {}

    for country in wanted:
        per_split: dict[str, str] = {}

        for split, measured in report["splits"].items():
            entry = measured["by_country"].get(country)

            if entry is None:
                per_split[split] = "no rows at all"
            elif entry["street_rows"] == 0:
                per_split[split] = f"{entry['rows']:,} rows, none carrying a street or house number"

        if per_split:
            findings[country] = per_split

    return findings


class ValidationCoverageError(ValueError):
    """A held-out split that cannot measure a locale the config asked it to, with the report attached."""

    def __init__(self, message: str, report: dict[str, Any]):
        super().__init__(message)
        self.report = report


def failing_requirements(
    report: dict[str, Any],
    required: list[ValidationCoverageConfig],
) -> list[dict[str, Any]]:
    """Each declared coverage floor the measured splits do not meet, with both numbers beside it.

    A country absent from a split is reported as observing zero rather than skipped. Skipping it
    would make the strongest failure. A locale the split holds no rows for is the one case the
    check makes no statement about.
    """
    failures: list[dict[str, Any]] = []

    for entry in required:
        measured = report["splits"].get(entry.split)

        if measured is None:
            failures.append(
                {
                    "country": entry.country,
                    "split": entry.split,
                    "because": f"the report carries no {entry.split} split",
                }
            )
            continue

        observed = measured["by_country"].get(entry.country, {"rows": 0, "street_rows": 0})
        shortfalls: list[str] = []

        if observed["rows"] < entry.min_rows:
            shortfalls.append(f"{observed['rows']:,} rows against a floor of {entry.min_rows:,}")

        if observed["street_rows"] < entry.min_street_rows:
            shortfalls.append(f"{observed['street_rows']:,} street rows against a floor of {entry.min_street_rows:,}")

        if shortfalls:
            failures.append(
                {
                    "country": entry.country,
                    "split": entry.split,
                    "rows": observed["rows"],
                    "street_rows": observed["street_rows"],
                    "min_rows": entry.min_rows,
                    "min_street_rows": entry.min_street_rows,
                    "because": "; ".join(shortfalls),
                }
            )

    return failures


def run(
    config_path: Path,
    *,
    json_path: Path | None = None,
    countries: tuple[str, ...] = ("US", "FR", "DE", "GB"),
    corpus_dir: Path | None = None,
) -> dict[str, Any]:
    """Print the per-country table for each split, then the countries with no street-level signal.

    ``corpus_dir`` overrides ``data.corpus_dir``, which a training config states as the path the
    corpus has on the Modal volume. On a machine that built the corpus, that path does not exist,
    and the audit has to run there: it is the check that decides whether a run may start.

    Raises {@link ValidationCoverageError} when the config declares ``data.required_validation_coverage``
    and a split falls short of it. The report is written and printed first either way, because a
    reader needs the numbers that failed rather than the fact that something did.
    """
    cfg = load_config(config_path)
    report = audit(corpus_dir or Path(cfg.data.corpus_dir))

    print(f"validation coverage — {config_path.name}")
    print(f"  corpus {report['corpus_dir']}\n")

    for split, measured in report["splits"].items():
        print(f"  {split} — {measured['files']} files, {measured['rows']:,} rows, {measured['countries']} countries")
        print(f"    {'country':>8s} {'rows':>14s} {'street rows':>14s} {'street share':>14s}")

        for country, entry in list(measured["by_country"].items())[:20]:
            share = entry["street_rows"] / entry["rows"] if entry["rows"] else 0.0
            print(f"    {country:>8s} {entry['rows']:>14,} {entry['street_rows']:>14,} {share:>13.1%}")

        print()

    findings = blind_countries(report, countries)
    report["blind"] = findings

    if findings:
        print("  countries with no street-level validation signal:")
        for country, per_split in findings.items():
            for split, reason in per_split.items():
                print(f"    {country} / {split}: {reason}")
    else:
        print(f"  every one of {', '.join(countries)} holds street rows in every split.")

    required = cfg.data.required_validation_coverage
    failures = failing_requirements(report, required) if required else []
    report["required_validation_coverage"] = {
        "declared": [
            {
                "country": entry.country,
                "split": entry.split,
                "min_rows": entry.min_rows,
                "min_street_rows": entry.min_street_rows,
            }
            for entry in required
        ],
        "failures": failures,
    }

    if required:
        print(f"\n  declared coverage floors ({len(required)}):")
        for entry in required:
            observed = (
                report["splits"]
                .get(entry.split, {"by_country": {}})["by_country"]
                .get(entry.country, {"rows": 0, "street_rows": 0})
            )
            print(
                f"    {entry.country} / {entry.split}: {observed['rows']:,} rows "
                f"(floor {entry.min_rows:,}), {observed['street_rows']:,} street rows "
                f"(floor {entry.min_street_rows:,})"
            )

    if json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nwrote {json_path}")

    if failures:
        lines = "\n".join(f"  {f['country']} / {f['split']}: {f['because']}" for f in failures)
        raise ValidationCoverageError(
            f"{len(failures)} of {len(required)} declared validation-coverage floors are not met:\n{lines}",
            report,
        )

    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--json", type=Path, default=None)
    parser.add_argument(
        "--corpus-dir",
        type=Path,
        default=None,
        help="Override data.corpus_dir, which names the path the corpus has on the Modal volume.",
    )
    parser.add_argument(
        "--countries",
        type=str,
        default="US,FR,DE,GB",
        help="Comma-separated codes to report a blindness finding for. Defaults to the four scope.config.json names.",
    )
    args = parser.parse_args()

    run(
        args.config,
        json_path=args.json,
        countries=tuple(code.strip().upper() for code in args.countries.split(",") if code.strip()),
        corpus_dir=args.corpus_dir,
    )


if __name__ == "__main__":
    main()
