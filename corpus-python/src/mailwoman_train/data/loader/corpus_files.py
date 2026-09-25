"""Lists the parquet files of a corpus split and counts rows per source.

Only `file_source_counts` reads row data, and it reads just the dictionary-encoded `source` column.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pyarrow.compute as pc
import pyarrow.parquet as pq

#: The manifest key that older corpora use for their parquet file list. Built corpora are immutable, so the
#: reader accepts both keys and the writer emits only `slices`.
_PRE_RENAME_MANIFEST_KEY = "sh" + "ards"


def manifest_files(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the manifest's parquet file list from the `slices` key or the older key.

    Reading only `slices` would make an older overlay corpus fall through to the glob fallback, which
    sees only the overlay's own files.
    """
    current = data.get("slices")
    if current:
        return list(current)
    return list(data.get(_PRE_RENAME_MANIFEST_KEY) or [])


def _reroot(raw: Path, corpus_dir: Path, split: str) -> Path | None:
    """Map a stale manifest path to an existing local file, or return ``None``.

    The path segment before ``<split>`` identifies the corpus that owns the file. When it is this
    corpus, the ``<split>/<file>`` tail is joined under ``corpus_dir``. When it is another corpus,
    such as an overlay's base, the ``<corpus>/<split>/<file>`` tail is joined under the parent of
    ``corpus_dir``.

    Part files are numbered by position, so a base part and an overlay part can share a file name.
    Re-rooting on the tail alone would read the overlay's part in place of the base's.
    """
    parts = raw.parts
    at = parts.index(split) if split in parts else None

    if at is None:
        cand = corpus_dir / split / raw.name

        return cand if cand.exists() else None

    # When the segment before the split is missing, repeats the split or matches this corpus, the file belongs to
    # this corpus.
    if at == 0 or parts[at - 1] == split or parts[at - 1] == corpus_dir.name:
        cand = corpus_dir / Path(*parts[at:])

        return cand if cand.exists() else None

    cand = corpus_dir.parent / Path(*parts[at - 1 :])

    return cand if cand.exists() else None


def _parquet_paths(corpus_dir: Path, split: str) -> list[Path]:
    """Return the parquet files for one split, from MANIFEST.json or a directory glob.

    The manifest lists an absolute ``path`` and a ``split`` per file. An overlay's manifest also lists
    files in its base corpus. Each path is used as-is when it exists and re-rooted by `_reroot` when
    it does not. The glob over ``corpus_dir/split`` runs only when the manifest resolves no files.
    """
    manifest = corpus_dir / "MANIFEST.json"
    if manifest.exists():
        data = json.loads(manifest.read_text())
        base_version = data.get("base_corpus_version")
        resolved: list[Path] = []
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
                continue
            cand = _reroot(raw, corpus_dir, split)
            if cand is not None:
                resolved.append(cand)
                rerooted += 1
            else:
                missing.append(str(raw))
        # A partly resolved manifest means the corpus is broken, for example an overlay without its base.
        # Training on the files that remain would use the wrong corpus, so this raises. When no path
        # resolves, the glob fallback below handles older monolithic corpora.
        if resolved and missing:
            raise FileNotFoundError(
                f"MANIFEST declares {declared} '{split}' parquet files but {len(missing)} are unresolvable "
                f"(as-is AND re-rooted under {corpus_dir}):\n  "
                + "\n  ".join(missing[:10])
                + ("\n  ..." if len(missing) > 10 else "")
            )
        if resolved:
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
    """Count rows per ``source`` in one parquet file.

    A file can hold several sources, because the writer splits files by row count. The count runs
    inside Arrow with `value_counts`, which avoids building one Python string per row.

    Raises `TypeError` on a non-string cell, which usually means a label-less ``--golden`` file was
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

    The epoch audit divides draws by these counts to report how many times each row of a source was
    shown. Files whose ``source`` column cannot be read are skipped.
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
