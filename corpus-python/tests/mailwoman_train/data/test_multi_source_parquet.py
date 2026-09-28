"""A parquet file carrying more than one source is indexed under every one of them.

The writer caps a file at ``rowsPerFile`` rows. A source boundary can fall anywhere, so a file can contain multiple
sources. In ``v0.31.0-region-code-and-unit``, 8 of 718 train files carry two sources and one file carries four.
Two of those sources appear in no other file.

Taking the first row's source as the whole file lost those sources in three places. ``_index_by_source`` never saw
them. As a result, ``_apply_source_weights`` could not raise for a source omitted from the config. The function's
unnamed-source guard exists to catch that omission. ``source_row_counts`` also attributed each whole file to its
first source. Reps per row is a ratio. An overstated numerator therefore understates the reps this audit checks.
The sampler's row values remain correct because ``_file_row_iter`` filters each row by the requested source.
"""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.data.loader.corpus_files import file_source_counts, source_row_counts
from mailwoman_train.data.loader.mixture import _apply_source_weights, _index_by_source

SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
    ]
)


def _rows(source: str, n: int) -> list[dict]:
    return [
        {
            "raw": f"{i} quiet lane {source}",
            "tokens": [str(i), "quiet", "lane", source],
            "labels": ["O", "O", "O", "O"],
            "country": "US",
            "source": source,
        }
        for i in range(n)
    ]


def _write(path: Path, rows: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), path)
    return path


def test_file_source_counts_reports_every_source_with_its_own_row_count(tmp_path: Path) -> None:
    path = _write(tmp_path / "train" / "part-0000.parquet", _rows("tiger", 7) + _rows("usgov-nad", 3))

    assert file_source_counts(path) == {"tiger": 7, "usgov-nad": 3}


def test_file_source_counts_raises_on_a_label_less_golden_file(tmp_path: Path) -> None:
    schema = pa.schema([("raw", pa.string()), ("source", pa.null())])
    table = pa.Table.from_pylist([{"raw": "x", "source": None}], schema=schema)
    path = tmp_path / "train" / "golden.parquet"
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path)

    with pytest.raises(TypeError):
        file_source_counts(path)


def test_the_index_lists_a_multi_source_file_under_each_of_its_sources(tmp_path: Path) -> None:
    single = _write(tmp_path / "train" / "part-0000.parquet", _rows("tiger", 4))
    mixed = _write(tmp_path / "train" / "part-0001.parquet", _rows("tiger", 4) + _rows("usgov-nad", 2))

    index = _index_by_source([single, mixed])

    assert sorted(index) == ["tiger", "usgov-nad"]
    assert sorted(index["tiger"]) == sorted([single, mixed])
    assert index["usgov-nad"] == [mixed]


def test_the_unnamed_source_guard_sees_a_source_that_never_opens_a_file(tmp_path: Path) -> None:
    # `usgov-nad` is second in the file and opens no file. First-row reading misses this case.
    mixed = _write(tmp_path / "train" / "part-0000.parquet", _rows("tiger", 4) + _rows("usgov-nad", 2))

    with pytest.raises(ValueError, match="usgov-nad"):
        _apply_source_weights(_index_by_source([mixed]), {"tiger": 1.0}, "train")


def test_row_counts_split_a_multi_source_file_between_its_sources(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    _write(corpus / "train" / "part-0000.parquet", _rows("tiger", 4) + _rows("usgov-nad", 6))
    _write(corpus / "train" / "part-0001.parquet", _rows("tiger", 5))

    # First-row attribution instead answers `{"tiger": 15}`.
    assert source_row_counts(corpus, "train") == {"tiger": 9, "usgov-nad": 6}
