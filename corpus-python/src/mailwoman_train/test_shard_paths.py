"""Strict shard-resolution contract (#480 — the v0.7.1 trap).

A manifest that declares shards the resolver cannot find is a BROKEN corpus; partial
resolution must raise with the missing list, never train on the survivors.
"""

import json
from pathlib import Path

import pytest

from mailwoman_train.data_loader import _shard_paths


def _mk(tmp: Path, shards: list[dict], base_version: str | None = None) -> Path:
    corpus = tmp / "corpus"
    (corpus / "train").mkdir(parents=True)
    manifest: dict = {"shards": shards}
    if base_version:
        manifest["base_corpus_version"] = base_version
    (corpus / "MANIFEST.json").write_text(json.dumps(manifest))
    return corpus


def test_full_resolution_passes(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    shard = corpus / "train" / "part-0000.parquet"
    shard.write_bytes(b"x")
    (corpus / "MANIFEST.json").write_text(json.dumps({"shards": [{"split": "train", "path": str(shard)}]}))
    assert _shard_paths(corpus, "train") == [shard]


def test_rerooting_still_works(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    shard = corpus / "train" / "part-0000.parquet"
    shard.write_bytes(b"x")
    stale = "/mnt/playpen/elsewhere/train/part-0000.parquet"
    (corpus / "MANIFEST.json").write_text(json.dumps({"shards": [{"split": "train", "path": stale}]}))
    assert _shard_paths(corpus, "train") == [shard]


def test_partial_resolution_raises_with_missing_list(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    present = corpus / "train" / "part-0000.parquet"
    present.write_bytes(b"x")
    gone = "/data/other-corpus/train/part-9999.parquet"
    (corpus / "MANIFEST.json").write_text(
        json.dumps(
            {
                "shards": [
                    {"split": "train", "path": str(present)},
                    {"split": "train", "path": gone},
                ]
            }
        )
    )
    with pytest.raises(FileNotFoundError, match="part-9999"):
        _shard_paths(corpus, "train")


def test_all_missing_falls_through_to_glob(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [{"split": "train", "path": "/nope/train/x.parquet"}])
    legacy = corpus / "train" / "legacy.parquet"
    legacy.write_bytes(b"x")
    assert _shard_paths(corpus, "train") == [legacy]
