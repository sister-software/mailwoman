"""One seeded JP probe build, pinned across every artifact it writes.

Nothing exercised this. The builder reads a 19.59M-point Overture-JP parquet and a cp932 KEN_ALL
extract, neither of which the suite has, so the whole path — the per-prefecture reservoirs, the
round-robin draw, the postcode join, the held-out board and the sealed char vocab — has never run
under pytest.

One `random.Random` feeds the board reservoir, each prefecture's reservoir, the per-prefecture
shuffle, the draw shuffle, the postcode coin for every rendered row and the board's own postcode
coin. Adding, dropping or reordering a draw reshuffles which addresses a seeded build trains on,
and no artifact says so. This pins every one of them: the rendered rows in emission order, the
board, the vocabulary and the report.

The fixture supplies all 47 prefectures because the builder RAISES below that, and it names each
municipality by searching for the bucket it must land in — the board split is md5 of the
municipality, so a fixture that does not construct board municipalities pins an empty board.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.countries.jp.probe_corpora import (
    BOARD_BUCKET_MIN,
    JP_PREFECTURES,
    main,
    muni_bucket,
)

#: Committed beside this file, captured from the code as it stood BEFORE a split. Regenerating it
#: after a change makes the test compare the new code against itself, so regenerate only when the
#: current code is already verified against the existing reference.
#:
#: Regenerate with: uv run python -m tests.mailwoman_train.countries.test_jp_probe_parity
REFERENCE = Path(__file__).parent / "jp-probe-reference.json"

REFERENCE_README = [
    "Pins one seeded JP probe build across a refactor.",
    "Regenerate: uv run python -m tests.mailwoman_train.countries.test_jp_probe_parity",
    "Fixture: write_fixture() in the test beside this file — all 47 prefectures, each with three",
    "  pool municipalities and one board municipality found by bucket, plus a cp932 KEN_ALL.",
    "",
    "train / val: every rendered row as raw + span tags, in emission order. The order is the",
    "  round-robin draw and the shuffle that follows it, both drawn from the one seeded RNG.",
    "board: the held-out rows, each with its municipality and coordinate.",
    "report: the build report, which carries the KEN_ALL join counts and the vocabulary size.",
    "vocab: the sealed char vocabulary, which is built from the train split alone.",
]

#: The parquet column layout the builder reads. `address_levels` is Overture's list of
#: `{value: ...}` structs; the builder takes level 0 as the prefecture and level 1 as the
#: municipality.
FIXTURE_SCHEMA = pa.schema(
    [
        ("address_levels", pa.list_(pa.struct([("value", pa.string())]))),
        ("street", pa.string()),
        ("number", pa.string()),
        ("lon", pa.float64()),
        ("lat", pa.float64()),
    ]
)

#: Rows per pool municipality. The draw needs at least `(train_rows + val_rows) / 47` per
#: prefecture to reach its target, and the reservoir caps at three times that.
ROWS_PER_POOL_MUNI = 5

#: Small enough to run in a test, large enough that the train split still covers all 47
#: prefectures after the draw is shuffled — which the builder RAISES on.
TRAIN_ROWS = 470
VAL_ROWS = 47
BOARD_ROWS = 20


def municipality_names(prefecture: str) -> tuple[list[str], str]:
    """Three pool municipalities and one board municipality for a prefecture.

    The split is `muni_bucket`, an md5 of the name — so a name cannot be chosen for a side, only
    searched for. Without the search the board reservoir stays empty and the held-out check pins
    nothing.
    """
    pool: list[str] = []
    board: str | None = None
    index = 0
    while len(pool) < 3 or board is None:
        name = f"{prefecture[0]}{index}市"
        if muni_bucket(name) >= BOARD_BUCKET_MIN:
            board = board or name
        elif len(pool) < 3:
            pool.append(name)
        index += 1
        if index > 10_000:  # pragma: no cover — the search terminates in tens of names
            raise RuntimeError(f"no board municipality found for {prefecture}")
    return pool, board


def write_fixture(scratch: Path) -> tuple[Path, Path]:
    """Write the Overture-JP parquet and the cp932 KEN_ALL the builder reads."""
    rows: list[dict[str, Any]] = []
    kenall_lines: list[str] = []
    for order, prefecture in enumerate(sorted(JP_PREFECTURES)):
        pool, board = municipality_names(prefecture)
        for muni_index, muni in enumerate([*pool, board]):
            code = f"{order + 1:03d}{muni_index:04d}"
            kenall_lines.append(",".join(f'"{cell}"' for cell in (code, prefecture, muni, "", "", "")))
            repeats = 1 if muni == board else ROWS_PER_POOL_MUNI
            for repeat in range(repeats):
                rows.append(
                    {
                        "address_levels": [{"value": prefecture}, {"value": muni}],
                        "street": f"{muni_index + 1}丁目",
                        "number": f"{repeat + 1}-{muni_index + 1}",
                        "lon": 135.0 + order / 100,
                        "lat": 35.0 + repeat / 100,
                    }
                )
    parquet = scratch / "addresses-jp.parquet"
    pq.write_table(pa.Table.from_pylist(rows, schema=FIXTURE_SCHEMA), parquet)
    kenall = scratch / "KEN_ALL_ROME.CSV"
    kenall.write_bytes(("\r\n".join(kenall_lines) + "\r\n").encode("cp932"))
    return parquet, kenall


def run_build(scratch: Path, patch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Run one seeded build over the fixture and read back every artifact."""
    parquet, kenall = write_fixture(scratch)
    out_dir = scratch / "out"
    patch.setattr(
        "sys.argv",
        [
            "probe_corpora",
            "--parquet",
            str(parquet),
            "--kenall",
            str(kenall),
            "--out-dir",
            str(out_dir),
            "--train-rows",
            str(TRAIN_ROWS),
            "--val-rows",
            str(VAL_ROWS),
            "--board-rows",
            str(BOARD_ROWS),
        ],
    )
    main()

    def read_split(split: str) -> list[dict[str, Any]]:
        table = pq.read_table(out_dir / split / "part-0000.parquet")
        return [
            {"raw": row["raw"], "span_tags": row["span_tags"], "span_starts": row["span_starts"]}
            for row in table.to_pylist()
        ]

    report = json.loads((out_dir / "build-report.json").read_text())
    report.pop("source_parquet", None)  # the fixture's own scratch path, different every run
    return {
        "train": read_split("train"),
        "val": read_split("val"),
        "board": [json.loads(line) for line in (out_dir / "jp-probe-board.jsonl").read_text().splitlines()],
        "report": report,
        "vocab": json.loads((out_dir / "char-vocab-jp-v1.json").read_text()),
    }


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    patch = pytest.MonkeyPatch()
    try:
        return run_build(tmp_path_factory.mktemp("jp-probe"), patch)
    finally:
        patch.undo()


@pytest.mark.parametrize("split", ["train", "val", "board"])
def test_the_rows_match_the_committed_reference(built: dict[str, Any], split: str) -> None:
    """Emission order is the draw order, and the draw order is the seeded RNG's."""
    expected = json.loads(REFERENCE.read_text())[split]
    actual = built[split]
    assert len(actual) == len(expected), f"{split}: {len(actual)} rows, not {len(expected)}"
    drifted = [i for i, (got, want) in enumerate(zip(actual, expected, strict=True)) if got != want]
    assert drifted == [], f"{split}: {len(drifted)} rows moved, starting at {actual[drifted[0]]['raw']!r}"


def test_the_report_and_vocabulary_match_the_committed_reference(built: dict[str, Any]) -> None:
    """The KEN_ALL join counts and the sealed vocabulary both follow from the same draw."""
    expected = json.loads(REFERENCE.read_text())
    assert built["report"] == expected["report"]
    assert built["vocab"] == expected["vocab"]


def test_the_fixture_reaches_the_board_and_the_postcode_join(built: dict[str, Any]) -> None:
    """A fixture that missed either would pin an empty block rather than the code that fills it."""
    assert len(built["board"]) == BOARD_ROWS, "the board reservoir did not fill"
    assert built["report"]["kenall_join"]["hit"] > 0, "no row joined a postcode"
    assert any("〒" in row["raw"] for row in built["train"]), "no train row carries a postcode"
    assert built["report"]["prefectures_train"] == 47, "the train split lost a prefecture"


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
    print(f"  {len(payload['train'])} train, {len(payload['val'])} val, {len(payload['board'])} board rows")


if __name__ == "__main__":
    write_reference()
