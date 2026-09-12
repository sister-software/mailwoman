"""One seeded fragment build, pinned end to end — every row, in emission order.

`main` pushes rows in blocks, and the ORDER of those blocks is baked into two things a rerun cannot
recover: each row's `source_id` carries its index in the list, and the final shuffle separates the
first 10% as the dev holdout. A block that moves renumbers every row after it and re-draws which
rows are read rather than trained.

Nothing exercised this. The builder reads OpenAddresses CSV extracts and a corpus parquet's span
columns, neither of which the suite has. The fixture supplies both at the shapes the collectors
read — two OA locales rather than sixteen, because the other fourteen contribute nothing when
their directories are absent, and that absence is what keeps the fixture small.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.corpora.fragment.build import main

#: Committed beside this file, captured from the code as it stood BEFORE a split. Regenerating it
#: after a change makes the test compare the new code against itself, so regenerate only when the
#: current code is already verified against the existing reference.
#:
#: Regenerate with: uv run python -m tests.mailwoman_train.corpora.test_fragment_build_parity
REFERENCE = Path(__file__).parent / "fragment-build-reference.json"

REFERENCE_README = [
    "Pins one seeded fragment build across a refactor.",
    "Regenerate: uv run python -m tests.mailwoman_train.corpora.test_fragment_build_parity",
    "Fixture: write_fixture() in the test beside this file — two OpenAddresses locales and a",
    "  span-schema corpus parquet, at the shapes the collectors read.",
    "",
    "train / dev: every row as source_id + country + raw, in emission order. The source_id",
    "  carries the row's index in the push list, so a block that moves renumbers everything",
    "  after it; the dev split is the first 10% the final shuffle separates.",
]

CORPUS_SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("span_starts", pa.list_(pa.int32())),
        ("span_ends", pa.list_(pa.int32())),
        ("span_tags", pa.list_(pa.string())),
        ("country", pa.string()),
    ]
)

#: Two of the sixteen OA locales: one trailing-number (Austria) and one leading-number (Australia),
#: so both branches of the `trailing` flag render.
OA_LOCALES = {
    "at": [
        ("Hauptstrasse", "12", "Wien", "1010", "3"),
        ("Ringstrasse", "7", "Graz", "8010", ""),
        ("Bahnhofplatz", "21", "Linz", "4020", "2"),
    ],
    "au": [
        ("Bouverie Street", "139", "Melbourne", "3000", "711"),
        ("George Street", "45", "Sydney", "2000", ""),
        ("Adelaide Terrace", "88", "Perth", "6000", "4"),
    ],
}

#: (country, raw, [(surface, tag)]) — the offsets are DERIVED from the text below rather than typed
#: beside it, so the fixture cannot carry a span that disagrees with its own row. Hand-typing them
#: put the region span one character off, which read as `"Y "` and silently produced no admin pair.
CORPUS_SPECS: list[tuple[str, str, list[tuple[str, str]]]] = [
    (
        "US",
        "350 5th Ave, New York, NY 10118",
        [("5th Ave", "street"), ("New York", "locality"), ("NY", "region")],
    ),
    (
        "US",
        "1 N Hartland Rd, White River Junction, VT 05001",
        [("N Hartland Rd", "street"), ("White River Junction", "locality"), ("VT", "region")],
    ),
    ("FR", "12 Rue de Rivoli, Paris", [("Rue de Rivoli", "street"), ("Paris", "locality")]),
    ("NO", "5 Vestre Haugen, Oslo", [("Vestre Haugen", "street"), ("Oslo", "locality")]),
]


def _corpus_row(country: str, raw: str, fields: list[tuple[str, str]]) -> dict[str, Any]:
    starts: list[int] = []
    ends: list[int] = []
    tags: list[str] = []
    cursor = 0
    for surface, tag in fields:
        start = raw.index(surface, cursor)
        cursor = start + len(surface)
        starts.append(start)
        ends.append(cursor)
        tags.append(tag)
    return {"raw": raw, "span_starts": starts, "span_ends": ends, "span_tags": tags, "country": country}


CORPUS_ROWS: list[dict[str, Any]] = [_corpus_row(*spec) for spec in CORPUS_SPECS]


def write_fixture(root: Path) -> tuple[Path, Path, Path]:
    """The OA root, the corpus parquet and the famous-locality list, as (oa_root, parquet, famous)."""
    root.mkdir(parents=True, exist_ok=True)
    oa_root = root / "openaddresses"
    for locale, rows in OA_LOCALES.items():
        directory = oa_root / locale / "city"
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "addresses.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["STREET", "NUMBER", "CITY", "POSTCODE", "UNIT"])
            writer.writerows(rows)

    parquet_dir = root / "corpus"
    parquet_dir.mkdir(parents=True, exist_ok=True)
    parquet = parquet_dir / "part-0000.parquet"
    pq.write_table(pa.Table.from_pylist(CORPUS_ROWS * 4, schema=CORPUS_SCHEMA), parquet)

    famous = root / "famous.txt"
    famous.write_text("Dublin\nMelbourne\nCasablanca\n", encoding="utf-8")
    return oa_root, parquet, famous


def reference_args(root: Path) -> argparse.Namespace:
    oa_root, parquet, famous = write_fixture(root)
    out = root / "out"
    return argparse.Namespace(
        oa_root=oa_root,
        corpus_parquet_glob=str(parquet),
        famous_localities_file=str(famous),
        locality_parquet_glob="",
        out_parquet=out / "part-fragment.parquet",
        out_dev=out / "fragment-dev.jsonl",
        per_locale_cap=4,
    )


def run_build(root: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """One build, returned as the pinned payload. `main` parses its own arguments, so they are
    supplied by standing in for the parse rather than by assembling a command line."""
    args = reference_args(root)
    monkeypatch.setattr(argparse.ArgumentParser, "parse_args", lambda self, *a, **k: args)
    main()

    train = pq.read_table(args.out_parquet, columns=["source_id", "country", "raw"]).to_pylist()
    dev = [json.loads(line) for line in args.out_dev.read_text(encoding="utf-8").splitlines()]
    return {
        "train": train,
        "dev": [{key: row[key] for key in ("source_id", "country", "raw")} for row in dev],
    }


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    patch = pytest.MonkeyPatch()
    try:
        return run_build(tmp_path_factory.mktemp("fragment-build"), patch)
    finally:
        patch.undo()


def test_the_build_is_deterministic_under_a_fixed_seed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Sanity: two builds of the same fixture agree, so a later mismatch means the code moved."""
    assert run_build(tmp_path / "a", monkeypatch) == run_build(tmp_path / "b", monkeypatch)


@pytest.mark.parametrize("split", ["train", "dev"])
def test_the_rows_match_the_committed_reference(built: dict[str, Any], split: str) -> None:
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text(encoding="utf-8"))[split]
    actual = built[split]

    assert len(actual) == len(expected), f"{split}: row count changed"
    drifted = [i for i, (got, want) in enumerate(zip(actual, expected, strict=True)) if got != want]
    assert drifted == [], f"{split}: {len(drifted)} rows moved, starting at {actual[drifted[0]]['source_id']}"


def test_the_holdout_is_a_tenth_and_shares_no_row_with_train(built: dict[str, Any]) -> None:
    """The dev split is read, never trained. A row in both is a row the read-out cannot measure."""
    total = len(built["train"]) + len(built["dev"])
    assert len(built["dev"]) == total // 10, f"dev holds {len(built['dev'])} of {total}, not a tenth"
    train_ids = {row["source_id"] for row in built["train"]}
    shared = train_ids & {row["source_id"] for row in built["dev"]}
    assert shared == set(), f"{len(shared)} row(s) are in both splits"


def test_the_fixture_reaches_every_block(built: dict[str, Any]) -> None:
    """A fixture that missed a block would pin an empty path through it."""
    countries = {row["country"] for row in built["train"]} | {row["country"] for row in built["dev"]}
    assert {"AT", "AU"} <= countries, "the OA locale blocks produced no rows"
    assert "ZZ" in countries, "the famous-locality block produced no rows"
    assert "US" in countries, "the corpus harvest and admin-pair blocks produced no rows"


def write_reference() -> None:
    """Capture the current build as the reference the tests above compare against.

    Run this only when the current code already passes against the existing reference — otherwise
    the artifact records whatever the code does now, and the tests assert nothing.
    """
    import tempfile

    patch = pytest.MonkeyPatch()
    try:
        with tempfile.TemporaryDirectory() as scratch:
            payload = {"README": REFERENCE_README, **run_build(Path(scratch), patch)}
    finally:
        patch.undo()
    REFERENCE.write_text(json.dumps(payload, ensure_ascii=False, indent="\t", sort_keys=False) + "\n")
    print(f"wrote {REFERENCE}")
    print(f"  {len(payload['train'])} train rows, {len(payload['dev'])} dev rows")


if __name__ == "__main__":
    write_reference()
