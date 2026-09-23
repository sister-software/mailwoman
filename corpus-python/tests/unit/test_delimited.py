"""Reading a compressed part file must be indistinguishable from reading a plain one."""

from __future__ import annotations

import json
from pathlib import Path

import zstandard

from mailwoman_train.data.delimited import ZSTD_EXTENSION, prefer_compressed, read_jsonl

ROWS = [
    {"street": "AVENIDA URUGUAI", "postcode": "96255-000", "locality": "Chuí" if i % 2 else "Santa Vitória"}
    for i in range(5000)
]


def _write_pair(tmp_path: Path) -> tuple[Path, Path]:
    text = "\n".join(json.dumps(row, ensure_ascii=False) for row in ROWS) + "\n"
    plain = tmp_path / "part-0000.jsonl"
    plain.write_text(text, encoding="utf-8")
    compressed = tmp_path / f"part-0000.jsonl{ZSTD_EXTENSION}"
    compressed.write_bytes(zstandard.ZstdCompressor(level=6).compress(text.encode("utf-8")))
    return plain, compressed


def test_reads_the_same_rows_either_way(tmp_path: Path) -> None:
    plain, compressed = _write_pair(tmp_path)

    assert list(read_jsonl(plain)) == ROWS
    assert list(read_jsonl(compressed)) == ROWS


def test_non_ascii_survives_the_round_trip(tmp_path: Path) -> None:
    _, compressed = _write_pair(tmp_path)

    localities = {row["locality"] for row in read_jsonl(compressed)}

    assert "Chuí" in localities


def test_compression_is_worth_doing(tmp_path: Path) -> None:
    plain, compressed = _write_pair(tmp_path)

    assert compressed.stat().st_size < plain.stat().st_size / 10


def test_prefer_compressed_picks_the_sibling_when_present(tmp_path: Path) -> None:
    plain, compressed = _write_pair(tmp_path)

    assert prefer_compressed(plain) == compressed

    compressed.unlink()

    assert prefer_compressed(plain) == plain
