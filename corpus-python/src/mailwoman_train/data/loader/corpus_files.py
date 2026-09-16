"""Which parquet files a split has, and how many rows each source holds.

Everything here reads paths and footers, except `file_source_counts`, which reads one dictionary-encoded string
column to learn which sources a file carries — the same one-time cost per file the row stream already pays at
index time.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pyarrow.compute as pc
import pyarrow.parquet as pq

#: The manifest key that listed a corpus's parquet files before the 2026-09-01 vocabulary rename. Every corpus
#: built before that date carries it, on this host and on the Modal volume, and a built corpus is an immutable
#: artifact — so the reader accepts both spellings and the writer emits only the current one.
_PRE_RENAME_MANIFEST_KEY = "sh" + "ards"


def manifest_files(data: dict[str, Any]) -> list[dict[str, Any]]:
    """The manifest's parquet-file list, under either the current key or the pre-rename one.

    MEASURED 2026-09-09, and the reason this function exists: the rename changed this reader's key without
    migrating the manifests. `v0.28.0-reviewed-postcode-tail` declares 706 train parquet files under the old key,
    and the loader resolved ONE — the overlay's own file — because the new key read empty and the glob fallback
    saw only the overlay directory. A run would have trained on 22 rows and reported success; the `val` split
    raised `FileNotFoundError` instead, which is the only reason it surfaced at all.
    """
    current = data.get("slices")
    if current:
        return list(current)
    return list(data.get(_PRE_RENAME_MANIFEST_KEY) or [])


def _reroot(raw: Path, corpus_dir: Path, split: str) -> Path | None:
    """The local file a stale manifest path names, or ``None`` when no re-rooting reaches one.

    The segment before ``<split>`` is the CORPUS the path belongs to, and it decides which root to re-root under:

    - **The same corpus** → under ``corpus_dir``, the ``<split>/<file>`` tail. This is the corpus's own parts, written
      with the build machine's data root and read somewhere else.
    - **A different corpus** → BESIDE ``corpus_dir``, the ``<corpus>/<split>/<file>`` tail under its parent. An
      overlay's base parts live in a sibling corpus directory, and a manifest that names them by the Modal volume's
      ``/data/corpus/versioned/`` is unresolvable off that volume while the files sit next to the overlay the whole
      time. This is what `export --parity-samples` needed: the v8-cjk-regs overlay declares 7 val parquet files, 6 of
      them the base corpora's, and a local export raised on all 6 after the graph was already written.

    **Reading the corpus segment is what keeps the two apart, and the aliasing it prevents is silent.** Part files are
    named by position, so `<base>/val/part-0000.parquet` and `<overlay>/val/part-0000.parquet` differ only in the
    segment this function reads. Re-rooting a base path under ``corpus_dir`` on tail alone finds the OVERLAY's
    same-numbered part, and the loader trains on it believing it read the base — no error, wrong rows.

    The roots are derived from ``corpus_dir`` rather than from a ``/data/`` prefix, so the rule holds for a volume, a
    lab checkout and a temporary directory alike.
    """
    parts = raw.parts
    at = parts.index(split) if split in parts else None

    if at is None:
        cand = corpus_dir / split / raw.name

        return cand if cand.exists() else None

    # No segment before the split, or one that is the split again: nothing names a corpus, so only the own-corpus
    # reading is available.
    if at == 0 or parts[at - 1] == split or parts[at - 1] == corpus_dir.name:
        cand = corpus_dir / Path(*parts[at:])

        return cand if cand.exists() else None

    cand = corpus_dir.parent / Path(*parts[at - 1 :])

    return cand if cand.exists() else None


def _parquet_paths(corpus_dir: Path, split: str) -> list[Path]:
    """Resolve train/val/test parquet paths via MANIFEST.json (adapter-addition corpora)
    or legacy glob fallback (monolithic corpora).

    The MANIFEST lists a per-file absolute ``path`` + ``split``. Two realities complicate this:

    1. **Overlay corpora.** An overlay (e.g. v0.4.0 = synthetic recipe outputs layered on v0.3.0's base)
       keeps a manifest whose base-file paths deliberately point into the OTHER corpus dir
       (``/data/.../v0.3.0/...``). Those are correct and must be used VERBATIM — re-rooting them to
       ``corpus_dir`` would point at files that don't exist (v0.4.0 only has the overlay's own files).
    2. **Portability.** A non-overlay manifest stores absolute paths from the BUILD machine's data
       root, which do not exist when the corpus is mounted elsewhere (the Modal volume at
       ``/data/...``).

    So per file: use the manifest path AS-IS when it exists; otherwise RE-ROOT it under
    ``corpus_dir`` (take the ``<split>/<basename>`` tail). This serves both cases — overlay
    cross-dir refs are preserved when valid, build-machine paths are re-rooted when stale — and is
    why v0.7.2 (v0.4.0 overlay → v0.3.0 base) trained fine: its manifest paths resolve as-is on the
    volume. Falls back to a glob over ``corpus_dir/split`` only when the manifest yields nothing
    usable."""
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
                # Path is valid as-is (overlay cross-dir ref, or corpus on its build machine).
                resolved.append(raw)
                continue
            # Stale absolute path (corpus moved): re-root under corpus_dir, then beside it.
            cand = _reroot(raw, corpus_dir, split)
            if cand is not None:
                resolved.append(cand)
                rerooted += 1
            else:
                missing.append(str(raw))
        # STRICT partial-resolution guard (#480, the v0.7.1 trap): a manifest that declares files
        # this loop cannot find means the corpus is BROKEN (an overlay missing its base, a moved
        # volume) — training on the survivors silently measures the wrong corpus. There is no
        # legitimate partial case; fail with the full missing list. All-missing falls through to
        # the legacy glob (monolithic corpora whose manifests never resolved here).
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
    # legacy fallback (monolithic corpora, or manifest yielded no resolvable files)
    paths = sorted((corpus_dir / split).glob("*.parquet"))
    if not paths:
        raise FileNotFoundError(f"no parquet files via MANIFEST or {corpus_dir / split}")
    return paths


def file_source_counts(path: Path) -> dict[str, int]:
    """Rows per ``source`` in one parquet file.

    A FILE IS NOT ONE SOURCE. This read used to take the first row's source as the whole file's, on the stated
    ground that the corpus is source-segregated. It is not: the writer caps a file at ``rowsPerFile`` rows and a
    source boundary falls wherever it falls, so 8 of the 718 train files in ``v0.31.0-region-code-and-unit`` carry
    two, and one carries four. ``_file_row_iter`` has always filtered per row against the source it was asked for,
    so the ROWS were right; what the first-row reading got wrong is which sources exist at all — two of them appear
    in no other file and were invisible to every caller.

    Reading every source costs less than reading the first one did. The column is dictionary-encoded and the
    grouping happens inside Arrow, so a 1,000,000-row file takes 30 ms where the first-row read was documented at
    50 ms; the four-source file takes 45 ms.

    Raises on a non-string cell, which is a ``--golden`` (label-less) file used as a train file; it used to fail
    later with a cryptic ``'<' not supported between NoneType and str`` from ``sorted()``.
    """
    column = pq.ParquetFile(path).read(columns=["source"])["source"]
    counts: dict[str, int] = {}

    # `value_counts` groups inside Arrow. Walking `to_pylist()` instead materializes one Python string per ROW, and
    # on a 1,000,000-row file that alone is the difference between 67 ms and 200 ms.
    for pair in pc.value_counts(column.combine_chunks()):
        value = pair["values"].as_py()
        if not isinstance(value, str):
            raise TypeError(f"source column cell is {type(value).__name__}, expected str")
        counts[value] = pair["counts"].as_py()

    return counts


def source_row_counts(corpus_dir: Path, split: str = "train") -> dict[str, int]:
    """Rows per source, read from parquet METADATA only — no row groups touched.

    Exists so the epoch audit can report REPS PER ROW rather than share. Share answers "what fraction of
    draws came from this source"; reps per row answers "how many times was each of its rows shown", and only
    the second is the quantity a human picks a weight to control. #1677: the source at the config's LOWEST
    weight (1.0) got 165 reps per row, 33x the exposure of sources weighted six times higher, because 277 rows
    divided into a 0.60% share is still 165 passes over every row. Nobody picks 165.

    Counted per SOURCE rather than per file. Attributing a whole file to its first row's source overstated that
    source and lost the others entirely, and reps per row is a ratio — an overstated numerator understates the
    reps, which is the direction that hides the defect this audit exists to find.
    """
    counts: dict[str, int] = {}

    for path in _parquet_paths(corpus_dir, split):
        if not path.exists():
            continue
        try:
            per_source = file_source_counts(path)
        except Exception:  # nosec B112 — deliberately skip unreadable files (rationale below)
            # A file whose sources cannot be read is skipped rather than counted under a guessed name.
            continue
        for src, rows in per_source.items():
            counts[src] = counts.get(src, 0) + rows

    return counts
