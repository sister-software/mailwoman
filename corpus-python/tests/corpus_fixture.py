"""Write a fixture parquet the way the corpus writers do: the file and the ``<stem>.RECORD.json`` beside it.

A corpus directory without a manifest file list is read by globbing ``<split>/*.parquet``, and the loader verifies
each globbed file against the sha256 its record states, so a fixture corpus needs the record too.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq


def write_corpus_parquet(table: pa.Table, path: Path, **kwargs: Any) -> Path:
    """Write ``table`` to ``path`` and a record holding the file's sha256 and row count beside it."""
    pq.write_table(table, path, **kwargs)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    record = path.with_name(path.name.removesuffix(".parquet") + ".RECORD.json")
    record.write_text(json.dumps({"sha256": digest, "rows": table.num_rows}))
    return path
