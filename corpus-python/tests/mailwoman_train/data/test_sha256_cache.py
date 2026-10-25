"""Checks the sha256 sidecar: a hit needs a matching size and mtime, and the loader uses it before hashing."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from mailwoman_train import env
from mailwoman_train.data.loader import corpus_files
from mailwoman_train.data.loader.sha256_cache import cached_sha256, record_sha256


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    env.reset_cache()
    corpus_files._VERIFIED.clear()
    yield
    env.reset_cache()
    corpus_files._VERIFIED.clear()


def test_an_unchanged_file_hits(tmp_path: Path) -> None:
    cache, data = tmp_path / "cache.json", tmp_path / "a.bin"
    data.write_bytes(b"abc")
    record_sha256(cache, data, "digest")
    assert cached_sha256(cache, data) == "digest"


def test_a_rewritten_file_misses(tmp_path: Path) -> None:
    cache, data = tmp_path / "cache.json", tmp_path / "a.bin"
    data.write_bytes(b"abc")
    record_sha256(cache, data, "digest")
    stat = data.stat()
    os.utime(data, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    assert cached_sha256(cache, data) is None


def test_records_from_two_files_merge(tmp_path: Path) -> None:
    cache = tmp_path / "cache.json"
    first, second = tmp_path / "a.bin", tmp_path / "b.bin"
    first.write_bytes(b"a")
    second.write_bytes(b"b")
    record_sha256(cache, first, "one")
    record_sha256(cache, second, "two")
    assert (cached_sha256(cache, first), cached_sha256(cache, second)) == ("one", "two")


def test_an_unreadable_sidecar_is_a_miss(tmp_path: Path) -> None:
    cache, data = tmp_path / "cache.json", tmp_path / "a.bin"
    data.write_bytes(b"abc")
    cache.write_text("{not json")
    assert cached_sha256(cache, data) is None


def test_the_loader_records_then_trusts_the_sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache, data = tmp_path / "cache.json", tmp_path / "a.bin"
    data.write_bytes(b"abc")
    monkeypatch.setenv("MAILWOMAN_SHA256_CACHE", str(cache))
    expected = corpus_files.file_sha256(data)
    corpus_files.verify_file_sha256(data, expected)
    assert cached_sha256(cache, data) == expected

    corpus_files._VERIFIED.clear()
    calls: list[Path] = []
    monkeypatch.setattr(corpus_files, "file_sha256", lambda path: calls.append(path) or "never")
    corpus_files.verify_file_sha256(data, expected)
    assert calls == [], "a fresh process rehashed a file the sidecar already measured"


def test_a_cached_digest_that_disagrees_with_the_manifest_still_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache, data = tmp_path / "cache.json", tmp_path / "a.bin"
    data.write_bytes(b"abc")
    monkeypatch.setenv("MAILWOMAN_SHA256_CACHE", str(cache))
    record_sha256(cache, data, "measured")
    with pytest.raises(ValueError, match="MANIFEST lists"):
        corpus_files.verify_file_sha256(data, "claimed")
