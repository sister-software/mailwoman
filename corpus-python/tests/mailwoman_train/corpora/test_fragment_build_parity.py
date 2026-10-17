"""One seeded fragment build, pinned end to end—every row, in emission order—because a moved block renumbers every row after it and re-draws the dev holdout."""

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
from mailwoman_train.corpora.fragment.sources import (
    OA_FILES,
    OA_LOCALES,
    RYHTI_REGISTER_ROW,
    SOURCE,
    collect_oa_pairs,
    collect_ryhti_pairs,
)
from mailwoman_train.source_rights import committed_source_rights

#: Committed beside this file. Regenerate with `uv run python -m
#: tests.mailwoman_train.corpora.test_fragment_build_parity` only when the current code is already
#: verified against the existing reference, or the test compares the new code against itself.
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

#: Two of the OA locales, keyed by the file `OA_FILES` names for each: one trailing-number (Czechia) and one
#: leading-number (Australia), so both branches of the `trailing` flag render.
OA_FIXTURE_FILES = {
    "cz/countrywide.csv": [
        ("Hauptstrasse", "12", "Wien", "1010", "3"),
        ("Ringstrasse", "7", "Graz", "8010", ""),
        ("Bahnhofplatz", "21", "Linz", "4020", "2"),
    ],
    "au/countrywide.csv": [
        ("Bouverie Street", "139", "Melbourne", "3000", "711"),
        ("George Street", "45", "Sydney", "2000", ""),
        ("Adelaide Terrace", "88", "Perth", "6000", "4"),
    ],
}

#: (country, raw, [(surface, tag)]) — the offsets are derived from the text, so the fixture cannot
#: store a span that disagrees with its own row.
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
    # The build refuses a listed file that is absent, so every other listed file is written with a header and no rows.
    listed = [relative for files in OA_FILES.values() for relative, _ in files]
    for relative in listed:
        path = oa_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["STREET", "NUMBER", "CITY", "POSTCODE", "UNIT"])
            writer.writerows(OA_FIXTURE_FILES.get(relative, []))

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
        ryhti_file="",
        out_parquet=out / "part-fragment.parquet",
        out_dev=out / "fragment-dev.jsonl",
        per_locale_cap=4,
        unshippable_reason=None,
    )


def run_build(root: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Runs one build and returns it as the pinned payload. `main` parses its own arguments, so they are
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
    assert {"CZ", "AU"} <= countries, "the OA locale blocks produced no rows"
    assert "ZZ" in countries, "the famous-locality block produced no rows"
    assert "US" in countries, "the corpus harvest and admin-pair blocks produced no rows"


def test_every_listed_file_reaches_a_register_row_the_source_maps() -> None:
    """Each listed file's publisher row is one of the source's inputs, and the source reads no row lacking train."""
    rights = committed_source_rights()
    mapped = {entry["registerSource"] for entry in rights.mappings[SOURCE]["inputs"]}
    named = {row for files in OA_FILES.values() for _, row in files} | {RYHTI_REGISTER_ROW}

    assert set(OA_FILES) == set(OA_LOCALES), "a locale has no file list, or a file list has no locale"
    assert named - mapped == set(), f"{sorted(named - mapped)} are read and absent from {SOURCE}'s inputs"
    assert rights.gaps(SOURCE) == []


def test_an_absent_listed_file_is_refused(tmp_path: Path) -> None:
    """A missing file raises rather than reading as a locale with no rows."""
    with pytest.raises(FileNotFoundError, match="cz/countrywide.csv"):
        collect_oa_pairs(tmp_path, "cz", 4)


#: Ryhti's columns the reader uses, with the published rendering in `address_fin`. The second row has no Finnish
#: street name and is skipped. The third renders a number with a subdivision letter.
RYHTI_COLUMNS = ["address_fin", "address_swe", "postal_office_fin", "address_name_fin", "postal_code"]
RYHTI_ROWS = [
    ("Vuorijärventie 216", "", "YLÄ-KOLKKI", "Vuorijärventie", "42830"),
    ("", "Storgatan 3", "", "", "65100"),
    ("Hämeenkatu 12 a", "", "TAMPERE", "Hämeenkatu", "33100"),
]


def write_ryhti(path: Path) -> Path:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(RYHTI_COLUMNS)
        writer.writerows(RYHTI_ROWS)
    return path


def test_the_ryhti_reader_takes_the_number_from_the_published_rendering(tmp_path: Path) -> None:
    pairs, cities, city_postcodes, units, triples = collect_ryhti_pairs(write_ryhti(tmp_path / "open_address.csv"), 4)

    assert sorted(pairs) == [("Hämeenkatu", "12 a"), ("Vuorijärventie", "216")]
    assert sorted(cities) == ["TAMPERE", "YLÄ-KOLKKI"]
    assert sorted(city_postcodes) == [("TAMPERE", "33100"), ("YLÄ-KOLKKI", "42830")]
    assert units == []
    assert sorted(triples) == [("Hämeenkatu", "12 a", "TAMPERE"), ("Vuorijärventie", "216", "YLÄ-KOLKKI")]


def test_an_absent_ryhti_file_is_refused(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="Ryhti"):
        collect_ryhti_pairs(tmp_path / "open_address.csv", 4)


def test_the_build_emits_finnish_rows_from_ryhti(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    args = reference_args(tmp_path)
    args.ryhti_file = str(write_ryhti(tmp_path / "open_address.csv"))
    monkeypatch.setattr(argparse.ArgumentParser, "parse_args", lambda self, *a, **k: args)
    main()

    rows = pq.read_table(args.out_parquet).to_pylist()
    rows += [json.loads(line) for line in args.out_dev.read_text(encoding="utf-8").splitlines()]
    finnish = [row for row in rows if row["country"] == "FI"]

    assert {row["register"] for row in finnish} == {"ryhti"}
    assert {row["locale"] for row in finnish} == {"fi-FI"}
    assert "Vuorijärventie 216" in {row["raw"] for row in finnish}


def write_reference() -> None:
    """Capture the current build as the reference the tests above compare against.

    Run it only when the current code already passes against the existing reference, or the artifact
    records whatever the code does now.
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
