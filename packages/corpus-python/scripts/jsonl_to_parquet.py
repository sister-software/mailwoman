#!/usr/bin/env python3
"""Convert Mailwoman corpus JSONL shards into Parquet.

Reads one or more `part-NNNN.jsonl` files written by
`packages/corpus/src/parquet.ts` (the TS sharder) and emits a Parquet file
per shard with the matching schema.

Usage:

    python jsonl_to_parquet.py \
        --input /data/corpus/versioned/corpus-v0.1.0/train \
        --output /data/corpus/versioned/corpus-v0.1.0/train

    # Or convert a single shard:
    python jsonl_to_parquet.py \
        --input /data/corpus/versioned/corpus-v0.1.0/train/part-0000.jsonl \
        --output /data/corpus/versioned/corpus-v0.1.0/train/part-0000.parquet

The TS sharder writes a `MANIFEST.json` with per-shard SHA-256s of the JSONL
bytes; this script does NOT modify or invalidate that manifest. Consumers
that need a Parquet-level checksum can compute it after conversion.

Schema (matches `PARQUET_COLUMNS` in `parquet.ts`):

    raw                : string (not null)
    tokens             : list<string> (not null)
    labels             : list<string> (not null)
    country            : string (not null)
    locale             : string (nullable)
    source             : string (not null)
    source_id          : string (not null)
    corpus_version     : string (not null)
    license            : string (not null)
    synth_method       : string (nullable)
    synth_base_id      : string (nullable)

Compression: zstd (PyArrow's default fast codec for textual columns).
Row group: 50_000 rows — balances readers' memory footprint and seek cost.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        "missing pyarrow — install via `pip install -e .[dev]` from packages/corpus-python\n"
    )
    raise SystemExit(2) from exc


SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("country", pa.string()),
        ("locale", pa.string()),
        ("source", pa.string()),
        ("source_id", pa.string()),
        ("corpus_version", pa.string()),
        ("license", pa.string()),
        ("synth_method", pa.string()),
        ("synth_base_id", pa.string()),
    ]
)

ROW_GROUP_SIZE = 50_000
COMPRESSION = "zstd"


def iter_jsonl(path: Path) -> Iterable[dict]:
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def convert_file(src: Path, dst: Path) -> int:
    """Convert a single .jsonl shard to a .parquet file. Returns row count."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    rows = 0
    batch: list[dict] = []

    with pq.ParquetWriter(
        dst,
        schema=SCHEMA,
        compression=COMPRESSION,
    ) as writer:
        for row in iter_jsonl(src):
            batch.append(row)
            if len(batch) >= ROW_GROUP_SIZE:
                writer.write_table(pa.Table.from_pylist(batch, schema=SCHEMA))
                rows += len(batch)
                batch = []
        if batch:
            writer.write_table(pa.Table.from_pylist(batch, schema=SCHEMA))
            rows += len(batch)
    return rows


def convert_dir(src_dir: Path, dst_dir: Path) -> dict[str, int]:
    """Convert every .jsonl in src_dir to a sibling .parquet in dst_dir."""
    out: dict[str, int] = {}
    for jsonl in sorted(src_dir.glob("part-*.jsonl")):
        target = dst_dir / f"{jsonl.stem}.parquet"
        out[str(target)] = convert_file(jsonl, target)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="JSONL file or directory")
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Parquet file (when --input is a file) or output directory",
    )
    args = parser.parse_args()

    if args.input.is_file():
        rows = convert_file(args.input, args.output)
        print(f"{args.output}: {rows} rows")
        return 0

    if args.input.is_dir():
        results = convert_dir(args.input, args.output)
        for path, rows in sorted(results.items()):
            print(f"{path}: {rows} rows")
        return 0

    sys.stderr.write(f"{args.input} not found\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
