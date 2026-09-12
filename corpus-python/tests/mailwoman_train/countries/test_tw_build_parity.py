"""One seeded Taiwan build, pinned end to end — the rows, the board, the centroids and the report.

The third of three country builders, and the last without a seeded reference. `build` threads one
`random.Random` through the selection masks, the register draw and the country-prefix fraction, so
moving a draw re-renders the slice; and nothing in the suite ran this path, because it reads an
Overture-TW parquet no test has.

The fixture is not a sample of that source. It is the shapes the renderers branch on: a village
present and a village absent, a floor unit and none, and a `之N` sub-number the splitter has to
separate from the house number.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.countries.tw.corpora import build

#: Committed beside this file, captured from the code as it stood BEFORE a split. Regenerating it
#: after a change makes the test compare the new code against itself, so regenerate only when the
#: current code is already verified against the existing reference.
#:
#: Regenerate with: uv run python -m tests.mailwoman_train.countries.test_tw_build_parity
REFERENCE = Path(__file__).parent / "tw-build-reference.json"

REFERENCE_README = [
    "Pins one seeded Taiwan build across a refactor.",
    "Regenerate: uv run python -m tests.mailwoman_train.countries.test_tw_build_parity",
    "Fixture: SOURCE_ROWS in the test beside this file — an Overture-TW-shaped parquet carrying the",
    "  shapes the renderers branch on, not a sample of the source.",
    "",
    "train / val: every rendered row as raw + register + the span triple, in emission order.",
    "  The ORDER is the assertion: one moved draw off the shared RNG re-renders the whole slice.",
    "board: the held-out 鄉鎮市區 rows, each carrying its coordinate and routing fields.",
    "centroids: the per-district means, which are what the board rows are scored against.",
    "report: the build report with the source path removed, since that is the fixture's tmp dir.",
]

SOURCE_SCHEMA = pa.schema(
    [
        ("address_levels", pa.list_(pa.struct([("value", pa.string())]))),
        ("street", pa.string()),
        ("number", pa.string()),
        ("unit", pa.string()),
        ("lon", pa.float64()),
        ("lat", pa.float64()),
        ("sources", pa.list_(pa.struct([("dataset", pa.string())]))),
    ]
)

#: (region, district, village, street, number, unit) — the branches, not a sample. 新北市中和區 and
#: 臺中市豐原區 hash to buckets 97 and 94, over the default board floor of 90, so they are held out.
SOURCE_ROWS: list[tuple[str, str, str, str, str, str]] = [
    ("臺北市", "中正區", "黎明里", "重慶南路一段", "122號", "3樓"),  # every field present
    ("臺北市", "中正區", "", "館前路", "8號", ""),  # no village, no floor
    ("臺北市", "大安區", "龍泉里", "新生南路三段", "之2號", "5樓"),  # a 之N sub-number
    ("新北市", "板橋區", "留侯里", "文化路一段", "266號", ""),
    ("新北市", "三重區", "五谷里", "重新路五段", "609號", "12樓"),
    ("臺中市", "西屯區", "何厝里", "臺灣大道三段", "301號", ""),
    ("臺中市", "北區", "賴明里", "三民路三段", "129號", "2樓"),
    ("高雄市", "前金區", "自強里", "中正四路", "211號", ""),
    ("高雄市", "苓雅區", "五權里", "四維三路", "6號", "8樓"),
    ("臺南市", "中西區", "赤崁里", "民權路二段", "30號", ""),
    ("桃園市", "桃園區", "中路里", "復興路", "195號", "4樓"),
    ("新竹市", "東區", "光復里", "光復路一段", "89號", ""),
    ("新北市", "中和區", "安平里", "中和路", "100號", "6樓"),  # board bucket 97
    ("臺中市", "豐原區", "北陽里", "中正路", "45號", ""),  # board bucket 94
]


def write_fixture(root: Path) -> Path:
    """The synthetic Overture-TW parquet, returned as its path."""
    root.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for index in range(6):  # repeat the shapes so the quota arithmetic has something to divide
        for region, district, village, street, number, unit in SOURCE_ROWS:
            rows.append(
                {
                    "address_levels": [{"value": region}, {"value": district}, {"value": village}],
                    "street": street,
                    "number": number,
                    "unit": unit,
                    "lon": 120.0 + index / 100 + len(district) / 1000,
                    "lat": 23.0 + index / 100 + len(street) / 1000,
                    "sources": [{"dataset": "tw-civil-affairs"}],
                }
            )
    parquet = root / "addresses-tw.parquet"
    pq.write_table(pa.Table.from_pylist(rows, schema=SOURCE_SCHEMA), parquet, row_group_size=len(rows))
    return parquet


def reference_args(parquet: Path, out_dir: Path) -> argparse.Namespace:
    """Every fraction non-zero, so every optional draw is taken off the shared RNG stream."""
    return argparse.Namespace(
        parquet=str(parquet),
        out_dir=str(out_dir),
        train_rows=30,
        val_rows=6,
        board_rows=6,
        rows_per_part=12,
        stats_sample_per_part=12,
        country_fraction=0.4,
        max_field_chars=64,
        max_row_groups=1,
        board_bucket_min=90,
        seed=42,
        force=True,
    )


def run_build(root: Path) -> dict[str, Any]:
    """One build, returned as the pinned payload."""
    parquet = write_fixture(root)
    out_dir = root / "slice"
    report = build(reference_args(parquet, out_dir))

    def rendered(split: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for path in sorted((out_dir / split).glob("*.parquet")):
            table = pq.read_table(path, columns=["raw", "register", "span_starts", "span_ends", "span_tags"])
            out.extend(table.to_pylist())
        return out

    board = [json.loads(line) for line in (out_dir / "tw-board.jsonl").read_text(encoding="utf-8").splitlines()]
    return {
        "train": rendered("train"),
        "val": rendered("val"),
        "board": board,
        "centroids": json.loads((out_dir / "tw-district-centroids.json").read_text(encoding="utf-8")),
        "report": {key: value for key, value in report.items() if key != "parquet"},
    }


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    return run_build(tmp_path_factory.mktemp("tw-build"))


def test_the_build_is_deterministic_under_a_fixed_seed(tmp_path: Path) -> None:
    """Sanity: two builds of the same fixture agree, so a later mismatch means the code moved."""
    assert run_build(tmp_path / "a") == run_build(tmp_path / "b")


@pytest.mark.parametrize("section", ["train", "val", "board", "centroids"])
def test_the_written_slice_matches_the_committed_reference(built: dict[str, Any], section: str) -> None:
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text(encoding="utf-8"))[section]
    assert built[section] == expected, f"{section} moved"


def test_the_report_matches_the_committed_reference(built: dict[str, Any]) -> None:
    """The report carries the attribution the licence requires, and the counts a reader trusts."""
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text(encoding="utf-8"))["report"]
    assert built["report"] == expected


def test_every_span_covers_the_text_it_claims(built: dict[str, Any]) -> None:
    """The spans are emitted by construction, so this holds for any input — and says so when it stops."""
    for section in ("train", "val", "board"):
        for row in built[section]:
            raw = row["raw"]
            triple = zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True)
            for start, end, tag in triple:
                assert 0 <= start < end <= len(raw), f"{section}: {tag} span ({start}, {end}) is outside {raw!r}"
                covered = raw[start:end]
                assert covered == covered.strip(), f"{section}: {tag} covers {covered!r}, which has an edge space"


def test_the_fixture_holds_out_a_district_and_keeps_the_attribution(built: dict[str, Any]) -> None:
    """A fixture with no board row, or no agency, would pin an empty path through the build."""
    assert built["report"]["board_districts"] >= 1, "no held-out 鄉鎮市區 — the bucket floor missed the fixture"
    assert built["report"]["attribution"], "the report carries no source agency, which the licence requires"
    assert built["centroids"], "no district centroid landed, so no board row can be scored"


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
