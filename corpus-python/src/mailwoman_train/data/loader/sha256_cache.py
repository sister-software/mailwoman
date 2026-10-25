"""A sidecar that remembers each file's sha256 by path, size and modification time, across processes.

The loader verifies every parquet file against its MANIFEST sha256. On the Modal volume a corpus holds
hundreds of files and tens of gigabytes, so a process that rehashes all of them spends minutes before its
first step. The CPU preflight hashes each file once and writes the result here. A later process, the GPU
run among them, reuses an entry whose size and `mtime_ns` still match the file and rehashes any other.

A stale entry cannot pass a rewritten file: a rewrite changes the size or the modification time. The
cache holds what was measured, never what a manifest claims.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

#: Bumped when an entry's shape changes, so an old sidecar is ignored rather than misread.
CACHE_VERSION = 1


def _stat_key(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def _load(cache_path: Path) -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
        return {}
    entries = data.get("entries")
    return entries if isinstance(entries, dict) else {}


def cached_sha256(cache_path: Path, path: Path) -> str | None:
    """The sha256 recorded for ``path`` when its size and mtime still match the entry, otherwise ``None``."""
    entry = _load(cache_path).get(str(path))
    if entry is None:
        return None
    size, mtime_ns = _stat_key(path)
    if entry.get("size") != size or entry.get("mtime_ns") != mtime_ns:
        return None
    digest = entry.get("sha256")
    return digest if isinstance(digest, str) else None


def record_sha256(cache_path: Path, path: Path, digest: str) -> None:
    """Record a measured digest, merging with whatever another process wrote since, through an atomic rename."""
    size, mtime_ns = _stat_key(path)
    entries = _load(cache_path)
    entries[str(path)] = {"size": size, "mtime_ns": mtime_ns, "sha256": digest}
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=cache_path.parent, prefix=f".{cache_path.name}.")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump({"version": CACHE_VERSION, "entries": entries}, out, sort_keys=True)
        os.replace(temporary, cache_path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
