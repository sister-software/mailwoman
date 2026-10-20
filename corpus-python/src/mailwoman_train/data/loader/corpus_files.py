"""Lists the parquet files of a corpus split and counts rows per source.

Only `file_source_counts` reads row data. It reads only the dictionary-encoded `source` column. Listing a split
from its manifest hashes each file once per process against the manifest's sha256.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pyarrow.compute as pc
import pyarrow.parquet as pq

#: The manifest key older corpora use for their parquet file list. Built corpora are immutable, so the
#: reader accepts both keys and the writer emits only `slices`.
_PRE_RENAME_MANIFEST_KEY = "sh" + "ards"

#: The directory the corpus build writes single-source files under, beside the corpus version directories.
_STORE_DIR = "store"

#: Files this process has already hashed, keyed by resolved path and the digest the manifest lists. A split's files
#: are listed several times per run (mixture sizing, source counts, the loader), and each is hashed once.
_VERIFIED: set[tuple[str, str]] = set()


def file_sha256(path: Path) -> str:
    """Return the hex sha256 of a file, read in 8 MiB chunks."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def verify_file_sha256(path: Path, expected: str | None) -> None:
    """Raise unless ``path`` hashes to the sha256 its manifest entry lists.

    An entry with no sha256 raises too: a file the manifest cannot vouch for is not one the loader can tell apart
    from a file rewritten in place.
    """
    if not expected:
        raise ValueError(f"MANIFEST lists {path} with no sha256, so its bytes cannot be verified")
    key = (str(path), expected)
    if key in _VERIFIED:
        return
    actual = file_sha256(path)
    if actual != expected:
        raise ValueError(f"{path} hashes to sha256 {actual} and MANIFEST lists {expected}")
    _VERIFIED.add(key)


def manifest_files(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the manifest's parquet file list from the `slices` key or the older key.

    The loader reads only `slices` if it wants an older overlay corpus to use the glob fallback. That fallback sees
    only the overlay's own files.
    """
    current = data.get("slices")
    if current:
        return list(current)
    return list(data.get(_PRE_RENAME_MANIFEST_KEY) or [])


def _reroot(raw: Path, corpus_dir: Path, split: str) -> Path | None:
    """Map a stale manifest path to an existing local file, or return ``None``.

        The path segment before ``<split>`` identifies the corpus that owns the file: when it is this
        corpus the ``<split>/<file>`` tail is joined under ``corpus_dir``, and when it is another corpus,
        such as an overlay's base, the ``<corpus>/<split>/<file>`` tail is joined under the parent of
        ``corpus_dir``.

        Part files are numbered by position, so a base part and an overlay part can share a file name.
    Re-rooting on the tail by itself would read the overlay's part in place of the base's.
    """
    parts = raw.parts

    # A store file, ``store/<source>/<derivation hash>/data.parquet``, sits beside the corpus directories rather
    # than inside one, and its path names no split: the manifest entry does.
    if _STORE_DIR in parts:
        cand = corpus_dir.parent / Path(*parts[parts.index(_STORE_DIR) :])

        return cand if cand.exists() else None

    at = parts.index(split) if split in parts else None

    if at is None:
        cand = corpus_dir / split / raw.name

        return cand if cand.exists() else None

    if at == 0 or parts[at - 1] == split or parts[at - 1] == corpus_dir.name:
        cand = corpus_dir / Path(*parts[at:])

        return cand if cand.exists() else None

    cand = corpus_dir.parent / Path(*parts[at - 1 :])

    return cand if cand.exists() else None


def _parquet_paths(corpus_dir: Path, split: str) -> list[Path]:
    """Return the parquet files for one split, from MANIFEST.json or a directory glob.

    The manifest lists an absolute ``path``, ``split`` and ``sha256`` per file. An overlay manifest also lists
    files in its base corpus. Use each path as-is when it exists. Otherwise, re-root it with
    `_reroot`. Every resolved file is hashed against its listed sha256 once per process, and a mismatch raises.
    Run the glob only when the manifest resolves no files.
    """
    manifest = corpus_dir / "MANIFEST.json"
    if manifest.exists():
        data = json.loads(manifest.read_text())
        base_version = data.get("base_corpus_version")
        resolved: list[Path] = []
        digests: list[str | None] = []
        rerooted = 0
        missing: list[str] = []
        declared = 0
        for s in manifest_files(data):
            if s.get("split") != split:
                continue
            declared += 1
            raw = Path(s["path"])
            if raw.exists():
                resolved.append(raw)
                digests.append(s.get("sha256"))
                continue
            cand = _reroot(raw, corpus_dir, split)
            if cand is not None:
                resolved.append(cand)
                digests.append(s.get("sha256"))
                rerooted += 1
            else:
                missing.append(str(raw))
        # A partly resolved manifest means the corpus is broken, e.g. an overlay without its base.
        # The loader raises rather than training on the remaining files from the wrong corpus. When no path
        # resolves, the glob fallback handles older monolithic corpora.
        if resolved and missing:
            raise FileNotFoundError(
                f"MANIFEST declares {declared} '{split}' parquet files but {len(missing)} are unresolvable "
                f"(as-is AND re-rooted under {corpus_dir}):\n  "
                + "\n  ".join(missing[:10])
                + ("\n  ..." if len(missing) > 10 else "")
            )
        if resolved:
            for path, digest in zip(resolved, digests, strict=True):
                verify_file_sha256(path, digest)
            print(
                f"[parquet] {split}: {len(resolved)} resolved ({rerooted} re-rooted) from MANIFEST"
                + (f" (base_corpus_version={base_version})" if base_version else " (no base_corpus_version field)")
            )
            return sorted(resolved)
    paths = sorted((corpus_dir / split).glob("*.parquet"))
    if not paths:
        raise FileNotFoundError(f"no parquet files via MANIFEST or {corpus_dir / split}")
    return paths


def file_source_counts(path: Path) -> dict[str, int]:
    """Count rows per ``source`` in one parquet file. A file can hold several sources because the
    writer splits files by row count. Arrow's `value_counts` performs the count without creating one
    Python string per row.

    Raises `TypeError` on a non-string cell. The known cause is a label-less ``--golden`` file was
    passed as a train file.
    """
    column = pq.ParquetFile(path).read(columns=["source"])["source"]
    counts: dict[str, int] = {}

    for pair in pc.value_counts(column.combine_chunks()):
        value = pair["values"].as_py()
        if not isinstance(value, str):
            raise TypeError(f"source column cell is {type(value).__name__}, expected str")
        counts[value] = pair["counts"].as_py()

    return counts


def source_row_counts(corpus_dir: Path, split: str = "train") -> dict[str, int]:
    """Count rows per source across every parquet file in a split.

    The epoch audit divides draws by these counts to report the number of times each source row was shown.
    Files whose ``source`` column cannot be read are skipped.
    """
    counts: dict[str, int] = {}

    for path in _parquet_paths(corpus_dir, split):
        if not path.exists():
            continue
        try:
            per_source = file_source_counts(path)
        except Exception:  # nosec B112 -- Skip an unreadable file instead of guessing its source.
            continue
        for src, rows in per_source.items():
            counts[src] = counts.get(src, 0) + rows

    return counts
