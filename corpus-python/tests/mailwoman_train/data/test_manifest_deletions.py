"""A version manifest's ``deletions[]`` removes rows by ``source_id`` from the files it targets.

The loader applies the list as a set-membership test, so a deleted row must leave the row stream and the source
counts, a file the deletion does not target must keep every row, and a reader that cannot apply the filter must
refuse rather than read the deleted rows.
"""

import hashlib
import json
import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.data.loader import _parquet_paths, corpus_split_files, source_row_counts
from mailwoman_train.data.loader.parquet import _file_row_iter

SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
        ("source_id", pa.string()),
    ]
)


def _write(path: Path, source: str, n: int) -> dict:
    rows = [
        {
            "raw": f"{i} quiet lane",
            "tokens": [str(i), "quiet", "lane"],
            "labels": ["O", "O", "O"],
            "country": "US",
            "source": source,
            "source_id": f"{source}:{i}",
        }
        for i in range(n)
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), path)
    return {
        "split": "train",
        "path": str(path),
        "source": source,
        "rows": n,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def _corpus(tmp: Path, deletions: list[dict]) -> Path:
    corpus = tmp / "corpus"
    tiger = _write(corpus / "train" / "tiger.parquet", "tiger", 6)
    nad = _write(corpus / "train" / "nad.parquet", "usgov-nad", 4)
    (corpus / "MANIFEST.json").write_text(json.dumps({"slices": [tiger, nad], "deletions": deletions}))
    return corpus


def _ids(corpus: Path) -> list[str]:
    out: list[str] = []
    for file in corpus_split_files(corpus, "train"):
        for row in _file_row_iter(
            file.path,
            expected_source=None,
            rng=random.Random(0),
            country_weights={"US": 1.0},
            max_weight=1.0,
            coarse_filter=False,
            row_filter=file.row_filter,
        ):
            out.append(row["raw"] + "|" + row["source"])
    return sorted(out)


def test_an_inline_deletion_drops_its_rows_from_the_source_target_only(tmp_path: Path) -> None:
    corpus = _corpus(
        tmp_path,
        [{"target": {"source": "tiger"}, "source_ids": ["tiger:1", "tiger:4"], "reason": "r", "issue": "#1"}],
    )

    assert source_row_counts(corpus, "train") == {"tiger": 4, "usgov-nad": 4}
    rows = _ids(corpus)
    assert "1 quiet lane|tiger" not in rows
    assert "4 quiet lane|tiger" not in rows
    assert "1 quiet lane|usgov-nad" in rows
    assert len(rows) == 8


def test_a_sidecar_deletion_is_verified_and_applied_by_path(tmp_path: Path) -> None:
    sidecar = tmp_path / "corpus" / "deletions" / "ids.parquet"
    sidecar.parent.mkdir(parents=True)
    pq.write_table(pa.table({"source_id": ["usgov-nad:0", "usgov-nad:3"]}), sidecar)
    digest = hashlib.sha256(sidecar.read_bytes()).hexdigest()
    nad_path = str(tmp_path / "corpus" / "train" / "nad.parquet")
    corpus = _corpus(
        tmp_path,
        [
            {
                "target": {"path": nad_path},
                # The Modal path. The loader re-roots it under the corpus's own `deletions/`.
                "source_ids_file": {"path": "/data/elsewhere/deletions/ids.parquet", "sha256": digest, "ids": 2},
                "reason": "r",
                "issue": "#2",
            }
        ],
    )

    assert source_row_counts(corpus, "train") == {"tiger": 6, "usgov-nad": 2}


def test_a_sidecar_whose_bytes_changed_raises(tmp_path: Path) -> None:
    sidecar = tmp_path / "corpus" / "deletions" / "ids.parquet"
    sidecar.parent.mkdir(parents=True)
    pq.write_table(pa.table({"source_id": ["tiger:0"]}), sidecar)
    corpus = _corpus(
        tmp_path,
        [
            {
                "target": {"source": "tiger"},
                "source_ids_file": {"path": str(sidecar), "sha256": "0" * 64, "ids": 1},
                "reason": "r",
                "issue": "#3",
            }
        ],
    )

    with pytest.raises(ValueError, match="hashes to"):
        corpus_split_files(corpus, "train")


def test_a_reader_that_cannot_apply_the_filter_refuses(tmp_path: Path) -> None:
    corpus = _corpus(
        tmp_path, [{"target": {"source": "tiger"}, "source_ids": ["tiger:0"], "reason": "r", "issue": "#4"}]
    )

    with pytest.raises(ValueError, match="corpus_split_files"):
        _parquet_paths(corpus, "train")
