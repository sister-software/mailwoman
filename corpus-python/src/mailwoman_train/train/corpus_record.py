"""The record that ties a training run's checkpoints to the corpus MANIFEST it read.

The trainer writes `CORPUS.json` beside its checkpoints, and `trainer-export export-onnx` copies it beside
`model.onnx`. A reader given a model can then find the MANIFEST, check its bytes against `manifest_sha256`, and run
`mailwoman corpus input-changes` on it to list the source records that changed since the corpus was built.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

CORPUS_RECORD_FILE = "CORPUS.json"


def corpus_record(corpus_dir: str | Path) -> dict[str, str | None]:
    """Return the corpus directory, its MANIFEST's sha256 and its `corpus_version`.

    A directory the loader reads without a MANIFEST records `None` for both. The record then states that the run
    read files no manifest lists.
    """
    manifest = Path(corpus_dir) / "MANIFEST.json"
    if not manifest.is_file():
        return {"corpus_dir": str(corpus_dir), "manifest_sha256": None, "corpus_version": None}
    contents = manifest.read_bytes()
    return {
        "corpus_dir": str(corpus_dir),
        "manifest_sha256": hashlib.sha256(contents).hexdigest(),
        "corpus_version": json.loads(contents).get("corpus_version"),
    }


def write_corpus_record(corpus_dir: str | Path, out_dir: str | Path) -> Path:
    """Write `CORPUS.json` for the corpus at `corpus_dir` into `out_dir` and return its path."""
    path = Path(out_dir) / CORPUS_RECORD_FILE
    path.write_text(json.dumps(corpus_record(corpus_dir), indent=2) + "\n", encoding="utf-8")
    return path
