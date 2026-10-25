"""The foreign-place CJK builder routes CJK-script rows of non-CJK countries and respects the split attribute."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from mailwoman_train.countries.cjk.foreign_places import build, cjk_share, is_foreign_cjk_row, to_record


def _row(raw: str, country: str, source_id: str, spans: list[tuple[str, str]]) -> dict[str, Any]:
    starts, ends, tags, cursor = [], [], [], 0
    for tag, text in spans:
        start = raw.index(text, cursor)
        starts.append(start)
        ends.append(start + len(text))
        tags.append(tag)
        cursor = start + len(text)
    tokens = raw.split()
    return {
        "raw": raw,
        "tokens": tokens,
        "labels": ["O"] * len(tokens),
        "span_starts": starts,
        "span_ends": ends,
        "span_tags": tags,
        "country": country,
        "source_id": source_id,
    }


def test_cjk_share_reads_letters_only() -> None:
    assert cjk_share("ニューヨーク州ブルックリン区") == 1.0
    assert cjk_share("フェアモント, WV") < 0.9
    assert cjk_share("12345") == 0.0


def test_a_mixed_row_and_a_cjk_country_row_stay_with_their_families() -> None:
    assert is_foreign_cjk_row({"raw": "ニューヨーク州ブルックリン区", "country": "US"})
    assert not is_foreign_cjk_row({"raw": "フェアモント, WV", "country": "US"})
    assert not is_foreign_cjk_row({"raw": "東京都渋谷区", "country": "JP"})


def test_build_writes_train_and_val_and_leaves_test_out(tmp_path: Path) -> None:
    rows = [
        _row(
            "ブルックリン区ニューヨークニューヨーク州",
            "US",
            "a",
            [("dependent_locality", "ブルックリン区"), ("locality", "ニューヨーク"), ("region", "ニューヨーク州")],
        ),
        _row("ミュンヘン", "DE", "b", [("locality", "ミュンヘン")]),
        _row("뉴욕 주 브루클린", "US", "c", [("region", "뉴욕 주"), ("dependent_locality", "브루클린")]),
        _row("Brooklyn, New York", "US", "d", [("dependent_locality", "Brooklyn"), ("locality", "New York")]),
        _row("渋谷区", "JP", "e", [("municipality", "渋谷区")]),
    ]
    parquet = tmp_path / "wof-admin.parquet"
    pq.write_table(pa.Table.from_pylist(rows), parquet)
    attribute = tmp_path / "wof-admin.split.x.json"
    attribute.write_text(json.dumps({"val": ["b"], "test": ["c"]}))

    report = build(parquet=parquet, split_attribute=attribute, out_dir=tmp_path / "out")

    assert report["rows"] == {"train": 1, "val": 1}
    assert report["test_rows_left_out"] == 1
    assert report["countries"] == {"US": 1, "DE": 1}
    train = pq.read_table(tmp_path / "out" / "train" / "wof-admin-0000.parquet").to_pylist()
    assert train[0]["raw"] == "ブルックリン区ニューヨークニューヨーク州"
    assert train[0]["register"] == "wof-foreign-cjk"


def test_to_record_moves_utf16_offsets_to_code_points() -> None:
    # 𦑃 (U+26443) is two UTF-16 units, so the TypeScript build writes the locality span as [0, 3).
    row = {**_row("翼𦑃", "US", "f", [("locality", "翼𦑃")]), "span_starts": [0], "span_ends": [3]}

    record = to_record(row)

    assert (record["span_starts"], record["span_ends"]) == ([0], [2])
    assert record["raw"][record["span_starts"][0] : record["span_ends"][0]] == "翼𦑃"
