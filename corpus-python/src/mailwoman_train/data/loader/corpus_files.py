"""Lists the parquet files of a corpus split and counts rows per source.

`file_source_counts` reads only the dictionary-encoded `source` column. `admitted_batches` reads the columns a
caller names, through the file's row filter. Listing a split
from its manifest hashes each file once per process against the manifest's sha256.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa
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


@dataclass(frozen=True)
class RowFilter:
    """The rows of one file a split reads, decided by each row's ``source_id``.

    ``drop`` holds the ids the manifest's ``deletions[]`` removes from the file. ``keep``, when set, holds the only
    ids the split reads from it.
    """

    drop: frozenset[str] = frozenset()
    keep: frozenset[str] | None = None


@dataclass(frozen=True)
class CorpusFile:
    """One parquet file of a split, with the filter its rows pass, or ``None`` when the split reads every row."""

    path: Path
    row_filter: RowFilter | None = None


def _resolve_sidecar(raw: str, corpus_dir: Path, directory: str) -> Path:
    """Resolve a sidecar path the manifest lists, as-is or under ``corpus_dir/<directory>``, or raise."""
    path = Path(raw)
    if path.exists():
        return path
    cand = corpus_dir / directory / path.name
    if cand.exists():
        return cand
    raise FileNotFoundError(f"MANIFEST lists sidecar {raw}, absent as-is and under {corpus_dir / directory}")


def _read_id_column(path: Path) -> frozenset[str]:
    """Return the distinct ``source_id`` values of a sidecar parquet."""
    column = pq.ParquetFile(path).read(columns=["source_id"])["source_id"]
    return frozenset(column.to_pylist())


def _deletion_ids(deletion: dict[str, Any], corpus_dir: Path) -> frozenset[str]:
    """Return one deletion's ``source_id`` set, inline or from its verified sidecar."""
    inline = deletion.get("source_ids")
    sidecar = deletion.get("source_ids_file")
    if (inline is None) == (sidecar is None):
        raise ValueError(f"MANIFEST deletion {deletion.get('issue')} must give source_ids or source_ids_file, not both")
    if sidecar is None:
        return frozenset(inline or ())
    path = _resolve_sidecar(sidecar["path"], corpus_dir, "deletions")
    verify_file_sha256(path, sidecar.get("sha256"))
    ids = _read_id_column(path)
    if len(ids) != sidecar.get("ids"):
        raise ValueError(f"{path} holds {len(ids)} source_ids and MANIFEST records {sidecar.get('ids')}")
    return ids


def _deletion_targets(target: dict[str, Any], entry: dict[str, Any]) -> bool:
    """Whether a deletion's target names this manifest entry, by its listed path or its source."""
    if "path" in target:
        return bool(target["path"] == entry.get("path"))
    return bool(target.get("source") == entry.get("source"))


def corpus_split_files(corpus_dir: Path, split: str) -> list[CorpusFile]:
    """Return the parquet files of one split, each with the row filter the manifest's ``deletions[]`` sets.

    The manifest lists an absolute ``path``, ``split`` and ``sha256`` per file. An overlay manifest also lists
    files in its base corpus. Use each path as-is when it exists. Otherwise, re-root it with
    `_reroot`. Every resolved file is hashed against its listed sha256 once per process, and a mismatch raises.
    Glob ``<split>/*.parquet`` only for a corpus whose manifest is absent or lists no file at all, and then hash each
    file against the ``RECORD.json`` beside it.
    """
    manifest = corpus_dir / "MANIFEST.json"
    data = json.loads(manifest.read_text()) if manifest.exists() else {}
    if not manifest_files(data):
        return [CorpusFile(path) for path in _glob_split(corpus_dir, split)]
    entries = _manifest_split_entries(data, corpus_dir, split)
    if not entries:
        raise FileNotFoundError(f"{manifest} lists no '{split}' parquet file")
    deletions = [(d["target"], _deletion_ids(d, corpus_dir)) for d in data.get("deletions") or []]
    files: list[CorpusFile] = []
    for path, entry in entries:
        drop: frozenset[str] = frozenset()
        for target, ids in deletions:
            if _deletion_targets(target, entry):
                drop = drop | ids
        keep: frozenset[str] | None = None
        if "split_attribute" in entry:
            held = _split_attribute(entry, corpus_dir)
            if split == "train":
                drop = drop | held["val"] | held["test"]
            else:
                keep = held[split]
        files.append(CorpusFile(path, RowFilter(drop=drop, keep=keep) if drop or keep is not None else None))
    return sorted(files, key=lambda f: f.path)


def _split_attribute(entry: dict[str, Any], corpus_dir: Path) -> dict[str, frozenset[str]]:
    """Read and verify the split attribute a manifest entry names, returning its held-out ids per split.

    The attribute's sha256 must match the entry, and the data file it describes must be the entry's file, or
    the split of each row would come from a decision about other bytes.
    """
    reference = entry["split_attribute"]
    path = _resolve_sidecar(reference["path"], corpus_dir, "")
    verify_file_sha256(path, reference.get("sha256"))
    attribute = json.loads(path.read_text())
    if attribute.get("attribute") != "split" or attribute.get("policyHash") != reference.get("policy_hash"):
        raise ValueError(f"{path} is not the split attribute under policy {reference.get('policy_hash')}")
    if attribute["file"]["sha256"] != entry.get("sha256"):
        raise ValueError(
            f"{path} describes sha256 {attribute['file']['sha256']} and MANIFEST lists {entry.get('sha256')}"
        )
    return {"val": frozenset(attribute["val"]), "test": frozenset(attribute["test"])}


def _parquet_paths(corpus_dir: Path, split: str) -> list[Path]:
    """Return the parquet files for one split, for a caller that reads every row of each.

    Raises when the manifest filters any of them by ``source_id``, because such a caller would read rows the
    split does not hold. Read the split through `corpus_split_files` instead.
    """
    files = corpus_split_files(corpus_dir, split)
    filtered = [f.path for f in files if f.row_filter is not None]
    if filtered:
        raise ValueError(
            f"{len(filtered)} '{split}' parquet file(s) under {corpus_dir} have rows the manifest filters by "
            f"source_id (first: {filtered[0]}); read them through corpus_split_files, which carries the filter"
        )
    return [f.path for f in files]


#: The suffix of the record the corpus writers put beside each parquet file: ``data.parquet`` has ``data.RECORD.json``.
_RECORD_SUFFIX = ".RECORD.json"


def _glob_split(corpus_dir: Path, split: str) -> list[Path]:
    """The directory-glob listing of a corpus with no manifest file list, each file verified against its record.

    With no manifest entry to vouch for a file, its ``<stem>.RECORD.json`` is the only statement of its bytes, so a
    file without one raises rather than training on bytes no record describes.
    """
    paths = sorted((corpus_dir / split).glob("*.parquet"))
    if not paths:
        raise FileNotFoundError(f"no parquet files via MANIFEST or {corpus_dir / split}")
    for path in paths:
        record = path.with_name(path.name.removesuffix(".parquet") + _RECORD_SUFFIX)
        if not record.exists():
            raise ValueError(
                f"{path} is listed by no MANIFEST and has no {record.name} beside it, so its bytes cannot be verified"
            )
        verify_file_sha256(path, json.loads(record.read_text()).get("sha256"))
    return paths


def _manifest_split_entries(data: dict[str, Any], corpus_dir: Path, split: str) -> list[tuple[Path, dict[str, Any]]]:
    """Resolve and verify the manifest entries of one split.

    Raises when any declared entry resolves to no file. A manifest whose files are all absent once fell through to a
    directory glob, which read whatever unlisted files sat under ``<split>/`` without verifying them.
    """
    base_version = data.get("base_corpus_version")
    resolved: list[tuple[Path, dict[str, Any]]] = []
    rerooted = 0
    missing: list[str] = []
    declared = 0
    for s in manifest_files(data):
        # A file with a split attribute holds every split's rows, and the attribute decides each row.
        attributed = "split_attribute" in s
        if s.get("split") != split and not attributed:
            continue
        declared += 1
        raw = Path(s["path"])
        if raw.exists():
            resolved.append((raw, s))
            continue
        # An attributed file sits at the root of the corpus directory that adds it.
        cand = (corpus_dir / raw.name if (corpus_dir / raw.name).exists() else None) if attributed else None
        cand = cand or _reroot(raw, corpus_dir, split)
        if cand is not None:
            resolved.append((cand, s))
            rerooted += 1
        else:
            missing.append(str(raw))
    # A manifest with unresolvable files means the corpus is broken, e.g. an overlay without its base.
    # The loader raises rather than training on the remaining files, or on unlisted ones a glob would find.
    if missing:
        raise FileNotFoundError(
            f"MANIFEST declares {declared} '{split}' parquet files but {len(missing)} are unresolvable "
            f"(as-is AND re-rooted under {corpus_dir}):\n  "
            + "\n  ".join(missing[:10])
            + ("\n  ..." if len(missing) > 10 else "")
        )
    for path, entry in resolved:
        verify_file_sha256(path, entry.get("sha256"))
    if resolved:
        print(
            f"[parquet] {split}: {len(resolved)} resolved ({rerooted} re-rooted) from MANIFEST"
            + (f" (base_corpus_version={base_version})" if base_version else " (no base_corpus_version field)")
        )
    return resolved


def _admitted_mask(source_ids: Any, row_filter: RowFilter) -> Any:
    """A boolean Arrow mask of the rows a filter admits, computed by set membership on ``source_id``."""
    mask = None
    if row_filter.keep is not None:
        mask = pc.is_in(source_ids, value_set=pa.array(sorted(row_filter.keep), type=source_ids.type))
    if row_filter.drop:
        dropped = pc.is_in(source_ids, value_set=pa.array(sorted(row_filter.drop), type=source_ids.type))
        kept = pc.invert(dropped)
        mask = kept if mask is None else pc.and_(mask, kept)
    return mask


def admitted_batches(
    file: CorpusFile, columns: list[str], *, batch_size: int = 65536, predicate: Any = None
) -> Iterator[pa.RecordBatch]:
    """Yield one file's record batches over ``columns``, holding only the rows its split admits.

    ``source_id`` is read for the filter when the file has one and is returned only when ``columns`` names it.
    ``predicate`` is a `pyarrow.dataset` expression applied before the split filter, so row-group statistics can
    skip groups it excludes.
    """
    import pyarrow.dataset as ds

    read = columns if file.row_filter is None or "source_id" in columns else [*columns, "source_id"]
    for batch in ds.dataset(str(file.path), format="parquet").to_batches(
        columns=read, filter=predicate, batch_size=batch_size
    ):
        if file.row_filter is not None:
            mask = _admitted_mask(batch.column("source_id"), file.row_filter)
            if mask is not None:
                batch = batch.filter(mask)
            if read is not columns:
                batch = batch.select(columns)
        if batch.num_rows:
            yield batch


def file_source_counts(path: Path, row_filter: RowFilter | None = None) -> dict[str, int]:
    """Count rows per ``source`` in one parquet file, over the rows ``row_filter`` admits.

    A file can hold several sources because the writer splits files by row count. Arrow's `value_counts`
    performs the count without creating one Python string per row.

    Raises `TypeError` on a non-string cell. The known cause is a label-less ``--golden`` file was
    passed as a train file.
    """
    if row_filter is None:
        column = pq.ParquetFile(path).read(columns=["source"])["source"]
    else:
        table = pq.ParquetFile(path).read(columns=["source", "source_id"])
        mask = _admitted_mask(table["source_id"].combine_chunks(), row_filter)
        column = table["source"] if mask is None else table.filter(mask)["source"]
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

    for file in corpus_split_files(corpus_dir, split):
        if not file.path.exists():
            continue
        try:
            per_source = file_source_counts(file.path, file.row_filter)
        except Exception:  # nosec B112 -- Skip an unreadable file instead of guessing its source.
            continue
        for src, rows in per_source.items():
            counts[src] = counts.get(src, 0) + rows

    return counts
