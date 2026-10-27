"""The corpus record stores the directory a run read and the sha256 of its MANIFEST."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from mailwoman_train.train.corpus_record import CORPUS_RECORD_FILE, write_corpus_record


def test_records_the_corpus_manifest_digest_and_version(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus-v0.8.7-overlay"
    corpus.mkdir()
    manifest = corpus / "MANIFEST.json"
    manifest.write_text(json.dumps({"corpus_version": "0.8.7-overlay", "files": []}), encoding="utf-8")

    path = write_corpus_record(corpus, tmp_path)

    assert path == tmp_path / CORPUS_RECORD_FILE
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "corpus_dir": str(corpus),
        "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
        "corpus_version": "0.8.7-overlay",
    }


def test_records_a_corpus_without_a_manifest_as_null(tmp_path: Path) -> None:
    path = write_corpus_record(tmp_path / "corpus", tmp_path)

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "corpus_dir": str(tmp_path / "corpus"),
        "manifest_sha256": None,
        "corpus_version": None,
    }
