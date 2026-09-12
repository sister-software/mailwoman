"""Strict slice-resolution contract (#480 — the v0.7.1 trap).

A manifest that declares slices the resolver cannot find is a BROKEN corpus; partial
resolution must raise with the missing list, never train on the survivors.

Every fixture below writes the manifest key the CURRENT code prefers, and that is exactly how this
file passed through the 2026-09-01 rename while every manifest on disk became unreadable: the reader
and its tests were renamed together, the artifacts were not. The legacy-key tests at the bottom are
the ones that would have failed that day, so they assert against the shape real manifests HAVE rather
than the shape the reader would like.
"""

import json
from pathlib import Path

import pytest

from mailwoman_train.data.loader import _LEGACY_SLICES_KEY, _slice_paths, manifest_slices


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


def test_a_pre_rename_overlay_resolves_its_base_and_not_just_its_own_slice(tmp_path: Path) -> None:
    """The test that would have failed on 2026-09-01, shaped like the corpus that did.

    Every corpus built before that date lists its parquets under the pre-rename key. The reader moved
    to the new key and this file's fixtures moved with it, so nothing failed while
    `v0.28.0-reviewed-postcode-tail` went from 706 declared train slices to ONE resolved.

    The fixture is an OVERLAY, because only that shape can tell the two behaviours apart: the base
    slice lives in another directory, so reading the manifest finds both files and the glob fallback
    finds only the overlay's own. A fixture whose declared slice sits in `corpus/train/` passes either
    way, which is how a test can watch this defect happen and say nothing.
    """
    base = tmp_path / "base" / "train"
    base.mkdir(parents=True)
    base_slice = base / "part-0000.parquet"
    base_slice.write_bytes(b"x")

    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    own_slice = corpus / "train" / "overlay-00000.parquet"
    own_slice.write_bytes(b"x")

    (corpus / "MANIFEST.json").write_text(
        json.dumps(
            {
                _LEGACY_SLICES_KEY: [
                    {"split": "train", "path": str(base_slice)},
                    {"split": "train", "path": str(own_slice)},
                ]
            }
        )
    )

    assert _slice_paths(corpus, "train") == [base_slice, own_slice]


def test_a_pre_rename_manifest_gets_the_partial_resolution_guard_too(tmp_path: Path) -> None:
    """Reading the old key is worth nothing if the guard behind it does not fire.

    This is the half that turned the defect from silent into loud: an overlay's base slices sit at
    the volume's paths, so on any other host they are unresolvable and the corpus is broken. Before
    the fix the reader saw no declared slices at all and the guard could not speak.
    """
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    present = corpus / "train" / "part-0000.parquet"
    present.write_bytes(b"x")
    (corpus / "MANIFEST.json").write_text(
        json.dumps(
            {
                _LEGACY_SLICES_KEY: [
                    {"split": "train", "path": str(present)},
                    {"split": "train", "path": "/data/other-corpus/train/part-9999.parquet"},
                ]
            }
        )
    )

    with pytest.raises(FileNotFoundError, match="part-9999"):
        _slice_paths(corpus, "train")


def test_the_current_key_wins_when_a_manifest_carries_both() -> None:
    both = {"slices": [{"path": "new"}], _LEGACY_SLICES_KEY: [{"path": "old"}]}

    assert manifest_slices(both) == [{"path": "new"}]
    assert manifest_slices({_LEGACY_SLICES_KEY: [{"path": "old"}]}) == [{"path": "old"}]
    assert manifest_slices({"slices": []}) == []
    assert manifest_slices({}) == []
