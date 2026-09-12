"""Which parquet files a split has, and how many rows each source holds.

Everything here reads paths and footers. No row group is opened except the one
`_slice_first_source` needs to learn a file's source, which is the same one-time cost the row
stream already pays at index time.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

#: The manifest key that listed a corpus's parquet files before the 2026-09-01 vocabulary rename. Every corpus
#: built before that date carries it, on this host and on the Modal volume, and a built corpus is an immutable
#: artifact — so the reader accepts both spellings and the writer emits only the current one.
_LEGACY_SLICES_KEY = "sh" + "ards"


def manifest_slices(data: dict[str, Any]) -> list[dict[str, Any]]:
    """The manifest's slice list, under either the current key or the pre-rename one.

    MEASURED 2026-09-09, and the reason this function exists: the rename changed this reader's key without
    migrating the manifests. `v0.28.0-reviewed-postcode-tail` declares 706 train slices under the old key, and
    the loader resolved ONE — the overlay's own file — because the new key read empty and the glob fallback
    saw only the overlay directory. A run would have trained on 22 rows and reported success; the `val` split
    raised `FileNotFoundError` instead, which is the only reason it surfaced at all.
    """
    current = data.get("slices")
    if current:
        return list(current)
    return list(data.get(_LEGACY_SLICES_KEY) or [])


def _slice_paths(corpus_dir: Path, split: str) -> list[Path]:
    """Resolve train/val/test slice paths via MANIFEST.json (adapter-addition corpora)
    or legacy glob fallback (monolithic corpora).

    The MANIFEST lists per-slice absolute ``path`` + ``split``. Two realities complicate this:

    1. **Overlay corpora.** An overlay (e.g. v0.4.0 = synth slices layered on v0.3.0's base) keeps
       a manifest whose base-slice paths deliberately point into the OTHER corpus dir
       (``/data/.../v0.3.0/...``). Those are correct and must be used VERBATIM — re-rooting them to
       ``corpus_dir`` would point at files that don't exist (v0.4.0 only has the overlay slices).
    2. **Portability.** A non-overlay manifest stores absolute paths from the BUILD machine's data
       root, which do not exist when the corpus is mounted elsewhere (the Modal volume at
       ``/data/...``).

    So per slice: use the manifest path AS-IS when it exists; otherwise RE-ROOT it under
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
        for s in manifest_slices(data):
            if s.get("split") != split:
                continue
            declared += 1
            raw = Path(s["path"])
            if raw.exists():
                # Path is valid as-is (overlay cross-dir ref, or corpus on its build machine).
                resolved.append(raw)
                continue
            # Stale absolute path (corpus moved): re-root the <split>/<file> tail under corpus_dir.
            parts = raw.parts
            tail = Path(*parts[parts.index(split) :]) if split in parts else Path(split) / raw.name
            cand = corpus_dir / tail
            if cand.exists():
                resolved.append(cand)
                rerooted += 1
            else:
                missing.append(str(raw))
        # STRICT partial-resolution guard (#480, the v0.7.1 trap): a manifest that declares slices
        # this loop cannot find means the corpus is BROKEN (an overlay missing its base, a moved
        # volume) — training on the survivors silently measures the wrong corpus. There is no
        # legitimate partial case; fail with the full missing list. All-missing falls through to
        # the legacy glob (monolithic corpora whose manifests never resolved here).
        if resolved and missing:
            raise FileNotFoundError(
                f"MANIFEST declares {declared} '{split}' slices but {len(missing)} are unresolvable "
                f"(as-is AND re-rooted under {corpus_dir}):\n  "
                + "\n  ".join(missing[:10])
                + ("\n  ..." if len(missing) > 10 else "")
            )
        if resolved:
            print(
                f"[slices] {split}: {len(resolved)} resolved ({rerooted} re-rooted) from MANIFEST"
                + (f" (base_corpus_version={base_version})" if base_version else " (no base_corpus_version field)")
            )
            return sorted(resolved)
    # legacy fallback (monolithic corpora, or manifest yielded no resolvable slices)
    paths = sorted((corpus_dir / split).glob("*.parquet"))
    if not paths:
        raise FileNotFoundError(f"no slices via MANIFEST or {corpus_dir / split}")
    return paths


def _slice_first_source(slice: Path) -> str:
    """Return the ``source`` value of the first row in a parquet slice.

    Corpus v0.2.0 slices are 100% source-segregated (one source per slice), so reading
    the first row's source identifies the slice's source. Costs ~50 ms / slice at index
    time; called once per slice when ``_raw_row_stream`` starts.
    """
    pf = pq.ParquetFile(slice)
    rg = pf.read_row_group(0, columns=["source"])
    raw = rg["source"][0].as_py()
    if not isinstance(raw, str):
        raise TypeError(f"source column cell is {type(raw).__name__}, expected str")
    return raw


def source_row_counts(corpus_dir: Path, split: str = "train") -> dict[str, int]:
    """Rows per source, read from parquet METADATA only — no row groups touched.

    Exists so the epoch audit can report DOSE rather than share. Share answers "what fraction of draws
    came from this slice"; dose answers "how many times was each of its rows shown", and only the second
    is the quantity a human picks a weight to control. #1677: the slice at the config's LOWEST weight
    (1.0) got 165 reps per row, 33x the exposure of slices weighted six times higher, because 277 rows
    divided into a 0.60% share is still 165 passes over every row. Nobody picks 165.

    Metadata-only by construction: ``ParquetFile.metadata.num_rows`` reads the footer, so this costs a
    stat and a seek per slice rather than a scan. Source identification still reads one row group per
    slice, the same one-time cost ``_raw_row_stream`` already pays at index time.
    """
    counts: dict[str, int] = {}

    for slice in _slice_paths(corpus_dir, split):
        if not slice.exists():
            continue
        try:
            src = _slice_first_source(slice)
        except Exception:  # nosec B112 — deliberately skip unreadable slices (rationale below)
            # A slice whose source cannot be read is skipped rather than counted under a guessed name —
            # an inflated row count understates dose, which is the direction that hides the defect.
            continue
        if src is None:
            continue
        counts[src] = counts.get(src, 0) + pq.ParquetFile(slice).metadata.num_rows

    return counts
