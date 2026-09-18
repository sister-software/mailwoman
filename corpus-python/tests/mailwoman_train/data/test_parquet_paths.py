"""Strict parquet-path resolution contract (#480 — the v0.7.1 trap).

A manifest that declares parquet files the resolver cannot find is a BROKEN corpus. partial
resolution must raise with the missing list, never train on the survivors.

Every fixture below writes the manifest key the CURRENT code prefers, and that is exactly how this
file passed through the 2026-09-01 rename while every manifest on disk became unreadable: the reader
and its tests were renamed together, the artifacts were not. The legacy-key tests at the bottom are
the ones that would have failed that day, so they assert against the shape real manifests have rather
than the shape the reader would like.
"""

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
    # A manifest written on another machine: the path is absolute and wrong here, which is the
    # whole point. Any absolute path that does not exist serves. it need not be a real one.
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
    """The test that would have failed on 2026-09-01, shaped like the corpus that did.

    Every corpus built before that date lists its parquets under the pre-rename key. The reader moved
    to the new key and this file's fixtures moved with it, so nothing failed while
    `v0.28.0-reviewed-postcode-tail` went from 706 declared train parquet files to one resolved.

    The fixture is an OVERLAY, because only that shape can tell the two behaviours apart: the base
    file lives in another directory, so reading the manifest finds both files and the glob fallback
    finds only the overlay's own. A fixture whose declared file sits in `corpus/train/` passes either
    way, which is how a test can watch this defect happen and say nothing.
    """
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
    """Reading the old key is worth nothing if the guard behind it does not fire.

    This is the half that turned the defect from silent into loud: an overlay's base files sit at
    the volume's paths, so on any other host they are unresolvable and the corpus is broken. Before
    the fix the reader saw no declared files at all and the guard could not speak.
    """
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
    """#2207: the base corpus is a SIBLING directory, and the manifest names it by the Modal volume.

    `python -m mailwoman_train export --parity-samples` reads val rows through the config's corpus_dir. The
    v8-cjk-regs overlay declares 7 val parquet files, 6 of them the base corpora's at
    `/data/corpus/versioned/<base>/val/…`, and re-rooting only under the overlay's own directory found none of
    them — so a local export raised after the graph was already on disk. The base parts were beside the overlay
    the whole time.
    """
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
    """The aliasing the corpus segment prevents, and the reason it is read rather than the tail alone.

    Part files are named by position, so a base corpus and the overlay layered on it both hold `val/part-0000.parquet`.
    Re-rooting a base path under the overlay on tail alone finds the OVERLAY's part and resolves — no error, and the
    loader reports the base file as read while it holds the overlay's rows. Here the base is absent, so the only way
    to resolve is by taking the wrong file. the guard must raise instead.
    """
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
