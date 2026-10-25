"""Strict parquet-path resolution rejects missing manifest files and reports their paths.

The resolver must also keep accepting the legacy manifest key, resolve the store's single-source files, and refuse a
file whose bytes do not hash to the sha256 its manifest entry lists.
"""

import hashlib
import json
from pathlib import Path

import pytest

from mailwoman_train.data.loader import _parquet_paths, manifest_files
from mailwoman_train.data.loader.corpus_files import _RETIRED_MANIFEST_KEYS

_OLDEST_KEY = _RETIRED_MANIFEST_KEYS[-1]

#: Every fixture file holds the one byte ``x``.
X_SHA = hashlib.sha256(b"x").hexdigest()


def _mk(tmp: Path, entries: list[dict], base_version: str | None = None) -> Path:
    corpus = tmp / "corpus"
    (corpus / "train").mkdir(parents=True)
    manifest: dict = {"files": entries}
    if base_version:
        manifest["base_corpus_version"] = base_version
    (corpus / "MANIFEST.json").write_text(json.dumps(manifest))
    return corpus


def test_full_resolution_passes(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    part = corpus / "train" / "part-0000.parquet"
    part.write_bytes(b"x")
    (corpus / "MANIFEST.json").write_text(
        json.dumps({"files": [{"split": "train", "sha256": X_SHA, "path": str(part)}]})
    )
    assert _parquet_paths(corpus, "train") == [part]


def test_rerooting_still_works(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    part = corpus / "train" / "part-0000.parquet"
    part.write_bytes(b"x")
    # The path stands in for a manifest written on another machine. The test needs its absolute path to be wrong here, so
    # any non-existent absolute path serves.
    stale = "/build-machine/corpus/train/part-0000.parquet"
    (corpus / "MANIFEST.json").write_text(json.dumps({"files": [{"split": "train", "sha256": X_SHA, "path": stale}]}))
    assert _parquet_paths(corpus, "train") == [part]


def test_partial_resolution_raises_with_missing_list(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    present = corpus / "train" / "part-0000.parquet"
    present.write_bytes(b"x")
    gone = "/data/other-corpus/train/part-9999.parquet"
    (corpus / "MANIFEST.json").write_text(
        json.dumps(
            {
                "files": [
                    {"split": "train", "sha256": X_SHA, "path": str(present)},
                    {"split": "train", "sha256": X_SHA, "path": gone},
                ]
            }
        )
    )
    with pytest.raises(FileNotFoundError, match="part-9999"):
        _parquet_paths(corpus, "train")


def test_a_manifest_whose_files_are_all_absent_raises_rather_than_globbing(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [{"split": "train", "sha256": X_SHA, "path": "/nope/train/x.parquet"}])
    (corpus / "train" / "unlisted.parquet").write_bytes(b"x")
    with pytest.raises(FileNotFoundError, match="x.parquet"):
        _parquet_paths(corpus, "train")


def test_the_glob_of_a_corpus_without_a_manifest_verifies_each_file_against_its_record(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    part = corpus / "train" / "data.parquet"
    part.write_bytes(b"x")
    record = corpus / "train" / "data.RECORD.json"
    record.write_text(json.dumps({"sha256": X_SHA}))
    assert _parquet_paths(corpus, "train") == [part]

    record.write_text(json.dumps({"sha256": "0" * 64}))
    with pytest.raises(ValueError, match="hashes to sha256"):
        _parquet_paths(corpus, "train")

    record.unlink()
    with pytest.raises(ValueError, match="no data.RECORD.json"):
        _parquet_paths(corpus, "train")


def test_a_pre_rename_overlay_resolves_its_base_and_not_just_its_own_file(tmp_path: Path) -> None:
    """The fixture is an overlay whose base file lives in another directory, because only that shape tells manifest resolution from the glob fallback: a declared file under `corpus/train/` passes either way."""
    base = tmp_path / "base" / "train"
    base.mkdir(parents=True)
    base_part = base / "part-0000.parquet"
    base_part.write_bytes(b"x")

    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    own_part = corpus / "train" / "overlay-00000.parquet"
    own_part.write_bytes(b"x")

    (corpus / "MANIFEST.json").write_text(
        json.dumps(
            {
                _OLDEST_KEY: [
                    {"split": "train", "sha256": X_SHA, "path": str(base_part)},
                    {"split": "train", "sha256": X_SHA, "path": str(own_part)},
                ]
            }
        )
    )

    assert _parquet_paths(corpus, "train") == [base_part, own_part]


def test_a_pre_rename_manifest_gets_the_partial_resolution_guard_too(tmp_path: Path) -> None:
    """The old key adds no protection when the guard fails: an overlay's base files use volume paths, so another host cannot resolve them and the corpus breaks."""
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    present = corpus / "train" / "part-0000.parquet"
    present.write_bytes(b"x")
    (corpus / "MANIFEST.json").write_text(
        json.dumps(
            {
                _OLDEST_KEY: [
                    {"split": "train", "sha256": X_SHA, "path": str(present)},
                    {"split": "train", "sha256": X_SHA, "path": "/data/other-corpus/train/part-9999.parquet"},
                ]
            }
        )
    )

    with pytest.raises(FileNotFoundError, match="part-9999"):
        _parquet_paths(corpus, "train")


def test_an_overlays_base_parts_reroot_beside_it(tmp_path: Path) -> None:
    """The base corpus is a sibling directory matching the Modal volume's name, so re-rooting must look beside the overlay rather than only under it."""
    versioned = tmp_path / "corpus" / "versioned"
    overlay = versioned / "v8-cjk-regs"
    base = versioned / "v8-jp-kana"
    (overlay / "val").mkdir(parents=True)
    (base / "val").mkdir(parents=True)

    own = overlay / "val" / "part-0000.parquet"
    base_part = base / "val" / "part-0000.parquet"
    own.write_bytes(b"x")
    base_part.write_bytes(b"x")

    (overlay / "MANIFEST.json").write_text(
        json.dumps(
            {
                "files": [
                    {
                        "split": "val",
                        "sha256": X_SHA,
                        "path": "/data/corpus/versioned/v8-cjk-regs/val/part-0000.parquet",
                    },
                    {
                        "split": "val",
                        "sha256": X_SHA,
                        "path": "/data/corpus/versioned/v8-jp-kana/val/part-0000.parquet",
                    },
                ]
            }
        )
    )

    assert _parquet_paths(overlay, "val") == sorted([own, base_part])


def test_a_base_part_never_resolves_to_the_overlays_same_numbered_one(tmp_path: Path) -> None:
    """Resolve part files using their position in the filename.

    The base corpus and its overlay can both contain `val/part-0000.parquet`. Re-rooting by the filename tail would resolve the overlay's file even when the base should be read. The resolver must raise when the base file is absent.
    """
    versioned = tmp_path / "corpus" / "versioned"
    overlay = versioned / "v8-cjk-regs"
    (overlay / "val").mkdir(parents=True)
    own = overlay / "val" / "part-0000.parquet"
    own.write_bytes(b"x")

    (overlay / "MANIFEST.json").write_text(
        json.dumps(
            {
                "files": [
                    {
                        "split": "val",
                        "sha256": X_SHA,
                        "path": "/data/corpus/versioned/v8-cjk-regs/val/part-0000.parquet",
                    },
                    {
                        "split": "val",
                        "sha256": X_SHA,
                        "path": "/data/corpus/versioned/v8-jp-kana/val/part-0000.parquet",
                    },
                ]
            }
        )
    )

    with pytest.raises(FileNotFoundError, match="v8-jp-kana"):
        _parquet_paths(overlay, "val")


def test_a_sibling_that_is_not_there_still_raises(tmp_path: Path) -> None:
    """The second rung widens what resolves, never what passes silently."""
    versioned = tmp_path / "corpus" / "versioned"
    overlay = versioned / "v8-cjk-regs"
    (overlay / "val").mkdir(parents=True)
    own = overlay / "val" / "part-0000.parquet"
    own.write_bytes(b"x")

    (overlay / "MANIFEST.json").write_text(
        json.dumps(
            {
                "files": [
                    {"split": "val", "sha256": X_SHA, "path": str(own)},
                    {"split": "val", "sha256": X_SHA, "path": "/data/corpus/versioned/v8-absent/val/part-0000.parquet"},
                ]
            }
        )
    )

    with pytest.raises(FileNotFoundError, match="v8-absent"):
        _parquet_paths(overlay, "val")


def test_a_store_file_reroots_beside_the_corpus_directory(tmp_path: Path) -> None:
    """A store path names no split, so it re-roots on its ``store`` segment under the corpus directory's parent."""
    root = tmp_path / "versioned" / "v0.8.0"
    corpus = root / "corpus-v0.8.0"
    corpus.mkdir(parents=True)
    stored = root / "store" / "ban" / ("a" * 64) / "data.parquet"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(b"x")

    (corpus / "MANIFEST.json").write_text(
        json.dumps(
            {
                "files": [
                    {
                        "split": "val",
                        "sha256": X_SHA,
                        "path": f"/build-machine/versioned/v0.8.0/store/ban/{'a' * 64}/data.parquet",
                    }
                ]
            }
        )
    )

    assert _parquet_paths(corpus, "val") == [stored]


def test_a_file_whose_bytes_changed_raises(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    part = corpus / "train" / "rewritten.parquet"
    part.write_bytes(b"y")
    (corpus / "MANIFEST.json").write_text(
        json.dumps({"files": [{"split": "train", "sha256": X_SHA, "path": str(part)}]})
    )

    with pytest.raises(ValueError, match="rewritten.parquet hashes to sha256"):
        _parquet_paths(corpus, "train")


def test_an_entry_without_a_sha256_raises(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    part = corpus / "train" / "unlisted-digest.parquet"
    part.write_bytes(b"x")
    (corpus / "MANIFEST.json").write_text(json.dumps({"files": [{"split": "train", "path": str(part)}]}))

    with pytest.raises(ValueError, match="with no sha256"):
        _parquet_paths(corpus, "train")


def test_the_current_key_wins_when_a_manifest_carries_both() -> None:
    both = {"files": [{"path": "new"}], _OLDEST_KEY: [{"path": "old"}]}

    assert manifest_files(both) == [{"path": "new"}]
    assert manifest_files({_OLDEST_KEY: [{"path": "old"}]}) == [{"path": "old"}]
    assert manifest_files({_RETIRED_MANIFEST_KEYS[0]: [{"path": "v0.8"}]}) == [{"path": "v0.8"}]
    assert manifest_files({"files": []}) == []
    assert manifest_files({}) == []
