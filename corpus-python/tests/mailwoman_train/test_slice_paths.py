"""Strict slice-resolution contract (#480 — the v0.7.1 trap).

A manifest that declares slices the resolver cannot find is a BROKEN corpus; partial
resolution must raise with the missing list, never train on the survivors.
"""

import json
from pathlib import Path

import pytest

from mailwoman_train.data_loader import _slice_paths


def _mk(tmp: Path, slices: list[dict], base_version: str | None = None) -> Path:
    corpus = tmp / "corpus"
    (corpus / "train").mkdir(parents=True)
    manifest: dict = {"slices": slices}
    if base_version:
        manifest["base_corpus_version"] = base_version
    (corpus / "MANIFEST.json").write_text(json.dumps(manifest))
    return corpus


def test_full_resolution_passes(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    slice = corpus / "train" / "part-0000.parquet"
    slice.write_bytes(b"x")
    (corpus / "MANIFEST.json").write_text(json.dumps({"slices": [{"split": "train", "path": str(slice)}]}))
    assert _slice_paths(corpus, "train") == [slice]


def test_rerooting_still_works(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    slice = corpus / "train" / "part-0000.parquet"
    slice.write_bytes(b"x")
    stale = "/mnt/playpen/elsewhere/train/part-0000.parquet"
    (corpus / "MANIFEST.json").write_text(json.dumps({"slices": [{"split": "train", "path": stale}]}))
    assert _slice_paths(corpus, "train") == [slice]


def test_partial_resolution_raises_with_missing_list(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    present = corpus / "train" / "part-0000.parquet"
    present.write_bytes(b"x")
    gone = "/data/other-corpus/train/part-9999.parquet"
    (corpus / "MANIFEST.json").write_text(
        json.dumps(
            {
                "slices": [
                    {"split": "train", "path": str(present)},
                    {"split": "train", "path": gone},
                ]
            }
        )
    )
    with pytest.raises(FileNotFoundError, match="part-9999"):
        _slice_paths(corpus, "train")


def test_all_missing_falls_through_to_glob(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [{"split": "train", "path": "/nope/train/x.parquet"}])
    legacy = corpus / "train" / "legacy.parquet"
    legacy.write_bytes(b"x")
    assert _slice_paths(corpus, "train") == [legacy]
