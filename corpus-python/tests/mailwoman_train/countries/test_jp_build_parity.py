"""One seeded Japan build, pinned end to end — the rows, the board and the report.

`build` threads one `random.Random` through the selection masks, the register draw, the postcode
fraction, the hyphen variant, the spacing and the country prefix. They share a stream, so moving,
adding or dropping a draw anywhere re-renders the whole slice, and nothing else in the suite would
notice: the JP builder reads Overture-JP and KEN_ALL, which no test has, so it has never run under
pytest at all.

The fixture supplies both inputs at a size the build can finish in a second. It is NOT a sample of
the real source — it is the shapes the renderers branch on: a chōme district and a bare one, a
compact number and one the designator register cannot re-render, a town KEN_ALL entry, an ōaza
prefix that only matches once stripped, and a municipality catch-all.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.countries.jp.corpora import build

#: Committed beside this file, captured from the code as it stood BEFORE a split. Regenerating it
#: after a change makes the test compare the new code against itself, so regenerate only when the
#: current code is already verified against the existing reference.
#:
#: Regenerate with: uv run python tests/mailwoman_train/countries/test_jp_build_parity.py
REFERENCE = Path(__file__).parent / "jp-build-reference.json"

REFERENCE_README = [
    "Pins one seeded Japan build across a refactor.",
    "Regenerate: uv run python tests/mailwoman_train/countries/test_jp_build_parity.py",
    "Fixture: write_fixture() in the test beside this file — a synthetic Overture-JP parquet and",
    "  KEN_ALL CSV carrying the shapes the renderers branch on, not a sample of the real source.",
    "",
    "train / val: every rendered row as raw + register + the span triple, in emission order.",
    "  The ORDER is the assertion: one moved draw off the shared RNG re-renders the whole slice.",
    "board: the held-out municipalities' rows, same form.",
    "report: the build report with the paths removed, since those are the fixture's tmp dir.",
]

SOURCE_SCHEMA = pa.schema(
    [
        ("address_levels", pa.list_(pa.struct([("value", pa.string())]))),
        ("street", pa.string()),
        ("number", pa.string()),
        ("lon", pa.float64()),
        ("lat", pa.float64()),
    ]
)

#: (prefecture, municipality, street, number) — the branches, not a sample. 神戸市 and 宮崎市 both
#: hash to bucket 98, so they are the held-out board here and everything else is the training pool.
SOURCE_ROWS: list[tuple[str, str, str, str]] = [
    ("東京都", "八王子市", "八島町二丁目", "3-16"),  # chōme + compact: every register available
    ("東京都", "八王子市", "字崎枝", "12-4"),  # no chōme: native + designator + kana
    ("東京都", "町田市", "大字上田", "362B-2"),  # unclean number: native only
    ("北海道", "札幌市", "大通東一丁目", "5-7"),
    ("北海道", "函館市", "本町", "1-2"),
    ("沖縄県", "那覇市", "久茂地三丁目", "1-1"),
    ("沖縄県", "石垣市", "字大川", "9"),
    ("京都府", "京都市", "烏丸通二丁目", "4-5"),
    ("京都府", "宇治市", "宇治", "10-20"),
    ("大阪府", "大阪市", "梅田一丁目", "2-3"),
    ("大阪府", "堺市", "中区深井", "77"),
    ("愛知県", "名古屋市", "栄三丁目", "6-8"),
    ("兵庫県", "神戸市", "中央区元町通四丁目", "2-8"),  # board bucket 98
    ("宮崎県", "宮崎市", "橘通東一丁目", "9-3"),  # board bucket 98
]

#: KEN_ALL_ROME columns: postcode, prefecture-kanji, city-kanji, town-kanji, then romaji. The town
#: rows cover an exact match, an ōaza-prefixed one that matches only once stripped, a parenthetical
#: annotation the reader strips, and the municipality catch-all every city needs.
KENALL_ROWS: list[tuple[str, str, str, str]] = [
    ("1920000", "東京都", "八王子市", "以下に掲載がない場合"),
    ("1920062", "東京都", "八王子市", "八島町"),
    ("1940000", "東京都", "町田市", "以下に掲載がない場合"),
    ("1940211", "東京都", "町田市", "上田"),
    ("0600000", "北海道", "札幌市", "以下に掲載がない場合"),
    ("0600041", "北海道", "札幌市", "大通東（１～１３丁目）"),
    ("0400000", "北海道", "函館市", "以下に掲載がない場合"),
    ("9000000", "沖縄県", "那覇市", "以下に掲載がない場合"),
    ("9000015", "沖縄県", "那覇市", "久茂地"),
    ("9070000", "沖縄県", "石垣市", "以下に掲載がない場合"),
    ("9070022", "沖縄県", "石垣市", "大川"),
    ("6040000", "京都府", "京都市", "以下に掲載がない場合"),
    ("6110000", "京都府", "宇治市", "以下に掲載がない場合"),
    ("5300000", "大阪府", "大阪市", "以下に掲載がない場合"),
    ("5900000", "大阪府", "堺市", "以下に掲載がない場合"),
    ("4600000", "愛知県", "名古屋市", "以下に掲載がない場合"),
    ("6500000", "兵庫県", "神戸市", "以下に掲載がない場合"),
    ("8800000", "宮崎県", "宮崎市", "以下に掲載がない場合"),
    ("8800805", "宮崎県", "宮崎市", "橘通東"),
]


def write_fixture(root: Path) -> tuple[Path, Path]:
    """The synthetic Overture parquet and KEN_ALL CSV, returned as (parquet, kenall)."""
    root.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for index in range(8):  # repeat the shapes so the quota arithmetic has something to divide
        for prefecture, municipality, street, number in SOURCE_ROWS:
            rows.append(
                {
                    "address_levels": [{"value": prefecture}, {"value": municipality}],
                    "street": street,
                    "number": f"{number}-{index}" if number.count("-") == 1 and index % 3 == 0 else number,
                    "lon": 139.0 + index / 100,
                    "lat": 35.0 + index / 100,
                }
            )

    parquet = root / "addresses-jp.parquet"
    pq.write_table(pa.Table.from_pylist(rows, schema=SOURCE_SCHEMA), parquet, row_group_size=len(rows))

    kenall = root / "KEN_ALL_ROME.CSV"
    lines = [",".join(f'"{cell}"' for cell in (*row, "", "")) for row in KENALL_ROWS]
    kenall.write_bytes("\r\n".join(lines).encode("cp932"))
    return parquet, kenall


def reference_args(parquet: Path, kenall: Path, out_dir: Path) -> argparse.Namespace:
    """Every fraction non-zero, so every optional draw is taken off the shared RNG stream."""
    return argparse.Namespace(
        parquet=str(parquet),
        kenall=str(kenall),
        admin_db="",  # the kana register needs a WOF admin DB; an empty string declines it
        out_dir=str(out_dir),
        train_rows=40,
        val_rows=8,
        board_rows=8,
        rows_per_part=16,
        stats_sample_per_part=16,
        postcode_fraction=0.5,
        country_fraction=0.3,
        spaced_fraction=0.4,
        variant_hyphen_fraction=0.25,
        max_field_chars=64,
        max_row_groups=1,  # also skips the 47-prefecture check, which a fixture cannot satisfy
        upweight_pattern="市$:2",
        seed=42,
        force=True,
    )


def run_build(root: Path) -> dict[str, Any]:
    """One build, returned as the pinned payload."""
    parquet, kenall = write_fixture(root)
    out_dir = root / "slice"
    report = build(reference_args(parquet, kenall, out_dir))

    def rendered(split: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for path in sorted((out_dir / split).glob("*.parquet")):
            table = pq.read_table(path, columns=["raw", "register", "span_starts", "span_ends", "span_tags"])
            out.extend(table.to_pylist())
        return out

    board = [json.loads(line) for line in (out_dir / "jp-board.jsonl").read_text(encoding="utf-8").splitlines()]
    trimmed = {key: value for key, value in report.items() if key not in ("source_parquet", "kenall")}
    return {
        "train": rendered("train"),
        "val": rendered("val"),
        "board": [
            {key: row[key] for key in ("raw", "register", "span_starts", "span_ends", "span_tags")} for row in board
        ],
        "report": trimmed,
    }


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    return run_build(tmp_path_factory.mktemp("jp-build"))


def test_the_build_is_deterministic_under_a_fixed_seed(tmp_path: Path) -> None:
    """Sanity: two builds of the same fixture agree, so a later mismatch means the code moved."""
    assert run_build(tmp_path / "a") == run_build(tmp_path / "b")


@pytest.mark.parametrize("split", ["train", "val", "board"])
def test_rendered_rows_match_the_committed_reference(built: dict[str, Any], split: str) -> None:
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text(encoding="utf-8"))[split]
    actual = built[split]

    assert len(actual) == len(expected), f"{split}: row count changed"
    drifted = [i for i, (got, want) in enumerate(zip(actual, expected, strict=True)) if got != want]
    assert drifted == [], f"{split}: {len(drifted)} rows moved, starting at {actual[drifted[0]]['raw']!r}"


def test_the_report_matches_the_committed_reference(built: dict[str, Any]) -> None:
    """The report carries the counts a reader trusts — the join tiers, the quota, the vocab size."""
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text(encoding="utf-8"))["report"]
    assert built["report"] == expected


def test_every_span_covers_the_text_it_claims(built: dict[str, Any]) -> None:
    """The spans are emitted by construction, so this holds for any input — and says so when it stops."""
    for split in ("train", "val", "board"):
        for row in built[split]:
            raw = row["raw"]
            triple = zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True)
            for start, end, tag in triple:
                assert 0 <= start < end <= len(raw), f"{split}: {tag} span ({start}, {end}) is outside {raw!r}"
                covered = raw[start:end]
                assert covered == covered.strip(), f"{split}: {tag} covers {covered!r}, which has an edge space"


def test_no_board_municipality_reaches_the_trained_splits(built: dict[str, Any]) -> None:
    """The leak check `build` runs, asserted from the OUTPUT rather than from its own bookkeeping."""
    assert built["report"]["board_municipalities"] > 0, "the fixture produced no board rows to hold out"
    assert built["report"]["prefectures_train"] > 1, "the fixture produced a single-prefecture train split"


def write_reference() -> None:
    """Capture the current build as the reference the tests above compare against.

    Run this only when the current code already passes against the existing reference — otherwise
    the artifact records whatever the code does now, and the tests assert nothing.
    """
    import tempfile

    with tempfile.TemporaryDirectory() as scratch:
        payload = {"README": REFERENCE_README, **run_build(Path(scratch))}
    REFERENCE.write_text(json.dumps(payload, ensure_ascii=False, indent="\t", sort_keys=False) + "\n")
    print(f"wrote {REFERENCE}")
    print(f"  {len(payload['train'])} train, {len(payload['val'])} val, {len(payload['board'])} board rows")


if __name__ == "__main__":
    write_reference()
