"""A manifest file with a split attribute holds every split's rows, and the attribute decides each row.

Each split must read exactly the rows the attribute assigns it, a deletion must still apply inside a split, and an
attribute written for other bytes must refuse.
"""

import hashlib
import json
import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.data.loader import corpus_split_files, source_row_counts
from mailwoman_train.data.loader.parquet import _file_row_iter


def _corpus(tmp: Path, *, deletions: list[dict] | None = None, stale: bool = False) -> Path:
    corpus = tmp / "corpus"
    corpus.mkdir()
    ids = [f"gb-{i}" for i in range(10)]
    data = corpus / "part-gb.parquet"
    pq.write_table(
        pa.table(
            {
                "raw": [f"{i} High Street" for i in range(10)],
                "tokens": [[str(i), "High", "Street"] for i in range(10)],
                "labels": [["O", "O", "O"]] * 10,
                "country": ["GB"] * 10,
                "source": ["rendered-gb-os-open"] * 10,
                "source_id": ids,
            }
        ),
        data,
    )
    digest = hashlib.sha256(data.read_bytes()).hexdigest()
    attribute = {
        "attribute": "split",
        "policyHash": "p" * 64,
        "policy": {"holdouts": {}, "codeHash": "c"},
        "file": {"name": data.name, "sha256": "0" * 64 if stale else digest, "rows": 10},
        "counts": {"train": 7, "val": 2, "test": 1},
        "val": ["gb-1", "gb-5"],
        "test": ["gb-8"],
    }
    attribute_path = corpus / f"part-gb.split.{'p' * 64}.json"
    attribute_path.write_text(json.dumps(attribute))
    entry = {
        "path": f"/data/corpus/versioned/v1/corpus-v1/{data.name}",
        "source": "rendered-gb-os-open",
        "rows": 10,
        "sha256": digest,
        "split_attribute": {
            "path": f"/data/corpus/versioned/v1/corpus-v1/{attribute_path.name}",
            "sha256": hashlib.sha256(attribute_path.read_bytes()).hexdigest(),
            "policy_hash": "p" * 64,
            "counts": attribute["counts"],
        },
    }
    (corpus / "MANIFEST.json").write_text(json.dumps({"slices": [entry], "deletions": deletions or []}))
    return corpus


def _split_ids(corpus: Path, split: str) -> list[str]:
    out: list[str] = []
    for file in corpus_split_files(corpus, split):
        for row in _file_row_iter(
            file.path,
            expected_source=None,
            rng=random.Random(0),
            country_weights={"GB": 1.0},
            max_weight=1.0,
            coarse_filter=False,
            row_filter=file.row_filter,
        ):
            out.append(row["raw"].split(" ")[0])
    return sorted(out, key=int)


def test_each_split_reads_exactly_the_rows_the_attribute_assigns_it(tmp_path: Path) -> None:
    corpus = _corpus(tmp_path)

    assert _split_ids(corpus, "val") == ["1", "5"]
    assert _split_ids(corpus, "test") == ["8"]
    assert _split_ids(corpus, "train") == ["0", "2", "3", "4", "6", "7", "9"]
    assert source_row_counts(corpus, "train") == {"rendered-gb-os-open": 7}


def test_a_deletion_applies_inside_an_attributed_split(tmp_path: Path) -> None:
    corpus = _corpus(
        tmp_path,
        deletions=[
            {"target": {"source": "rendered-gb-os-open"}, "source_ids": ["gb-5", "gb-0"], "reason": "r", "issue": "#1"}
        ],
    )

    assert _split_ids(corpus, "val") == ["1"]
    assert _split_ids(corpus, "train") == ["2", "3", "4", "6", "7", "9"]


def test_an_attribute_for_other_bytes_refuses(tmp_path: Path) -> None:
    corpus = _corpus(tmp_path, stale=True)

    with pytest.raises(ValueError, match="describes sha256"):
        corpus_split_files(corpus, "val")
