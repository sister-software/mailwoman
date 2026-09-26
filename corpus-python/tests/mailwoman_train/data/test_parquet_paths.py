"""Strict parquet-path resolution: a manifest declaring files the resolver cannot find must raise with the missing list rather than train on the survivors, and the legacy manifest key must keep resolving."""

import json
from pathlib import Path

import pytest

from mailwoman_train.data.loader import _PRE_RENAME_MANIFEST_KEY, _parquet_paths, manifest_files


def _mk(tmp: Path, entries: list[dict], base_version: str | None = None) -> Path:
    corpus = tmp / "corpus"
    (corpus / "train").mkdir(parents=True)
    manifest: dict = {"slices": entries}
    if base_version:
        manifest["base_corpus_version"] = base_version
    (corpus / "MANIFEST.json").write_text(json.dumps(manifest))
    return corpus


def test_full_resolution_passes(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    part = corpus / "train" / "part-0000.parquet"
    part.write_bytes(b"x")
    (corpus / "MANIFEST.json").write_text(json.dumps({"slices": [{"split": "train", "path": str(part)}]}))
    assert _parquet_paths(corpus, "train") == [part]


def test_rerooting_still_works(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [])
    part = corpus / "train" / "part-0000.parquet"
    part.write_bytes(b"x")
    # A manifest written on another machine: the absolute path is wrong here, which is the point, so
    # any non-existent absolute path serves.
    stale = "/build-machine/corpus/train/part-0000.parquet"
    (corpus / "MANIFEST.json").write_text(json.dumps({"slices": [{"split": "train", "path": stale}]}))
    assert _parquet_paths(corpus, "train") == [part]


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
        _parquet_paths(corpus, "train")


def test_all_missing_falls_through_to_glob(tmp_path: Path) -> None:
    corpus = _mk(tmp_path, [{"split": "train", "path": "/nope/train/x.parquet"}])
    legacy = corpus / "train" / "legacy.parquet"
    legacy.write_bytes(b"x")
    assert _parquet_paths(corpus, "train") == [legacy]


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
                _PRE_RENAME_MANIFEST_KEY: [
                    {"split": "train", "path": str(base_part)},
                    {"split": "train", "path": str(own_part)},
                ]
            }
        )
    )

    assert _parquet_paths(corpus, "train") == [base_part, own_part]


def test_a_pre_rename_manifest_gets_the_partial_resolution_guard_too(tmp_path: Path) -> None:
    """Reading the old key adds no protection if the guard behind it does not fire: an overlay's base files sit at the volume's paths, so on any other host they are unresolvable and the corpus is broken."""
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    present = corpus / "train" / "part-0000.parquet"
    present.write_bytes(b"x")
    (corpus / "MANIFEST.json").write_text(
        json.dumps(
            {
                _PRE_RENAME_MANIFEST_KEY: [
                    {"split": "train", "path": str(present)},
                    {"split": "train", "path": "/data/other-corpus/train/part-9999.parquet"},
                ]
            }
        )
    )

    with pytest.raises(FileNotFoundError, match="part-9999"):
        _parquet_paths(corpus, "train")


def test_an_overlays_base_parts_reroot_beside_it(tmp_path: Path) -> None:
    """The base corpus is a sibling directory named by the Modal volume, so re-rooting must look beside the overlay rather than only under it."""
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
                "slices": [
                    {"split": "val", "path": "/data/corpus/versioned/v8-cjk-regs/val/part-0000.parquet"},
                    {"split": "val", "path": "/data/corpus/versioned/v8-jp-kana/val/part-0000.parquet"},
                ]
            }
        )
    )

    assert _parquet_paths(overlay, "val") == sorted([own, base_part])


def test_a_base_part_never_resolves_to_the_overlays_same_numbered_one(tmp_path: Path) -> None:
    """Part files are named by position, so a base corpus and the overlay on it both hold `val/part-0000.parquet`; re-rooting by tail alone would resolve the overlay's file and report the base as read, so the guard must raise when the base is absent."""
    versioned = tmp_path / "corpus" / "versioned"
    overlay = versioned / "v8-cjk-regs"
    (overlay / "val").mkdir(parents=True)
    own = overlay / "val" / "part-0000.parquet"
    own.write_bytes(b"x")

    (overlay / "MANIFEST.json").write_text(
        json.dumps(
            {
                "slices": [
                    {"split": "val", "path": "/data/corpus/versioned/v8-cjk-regs/val/part-0000.parquet"},
                    {"split": "val", "path": "/data/corpus/versioned/v8-jp-kana/val/part-0000.parquet"},
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
                "slices": [
                    {"split": "val", "path": str(own)},
                    {"split": "val", "path": "/data/corpus/versioned/v8-absent/val/part-0000.parquet"},
                ]
            }
        )
    )

    with pytest.raises(FileNotFoundError, match="v8-absent"):
        _parquet_paths(overlay, "val")


def test_the_current_key_wins_when_a_manifest_carries_both() -> None:
    both = {"slices": [{"path": "new"}], _PRE_RENAME_MANIFEST_KEY: [{"path": "old"}]}

    assert manifest_files(both) == [{"path": "new"}]
    assert manifest_files({_PRE_RENAME_MANIFEST_KEY: [{"path": "old"}]}) == [{"path": "old"}]
    assert manifest_files({"slices": []}) == []
    assert manifest_files({}) == []
