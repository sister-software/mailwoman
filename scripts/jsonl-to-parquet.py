#!/usr/bin/env python3
"""Convert a JSONL of LabeledRow objects to a Parquet shard matching the v0.4.0 schema.

Schema: raw, tokens, labels, country, locale, source, source_id,
        corpus_version, license, synth_method, synth_base_id.

Usage:
  python3 scripts/jsonl-to-parquet.py --input /tmp/po-box-labeled.jsonl --output /tmp/part-po-box.parquet
"""

import argparse
import json
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


REQUIRED_COLUMNS = (
    "raw",
    "tokens",
    "labels",
    "country",
    "locale",
    "source",
    "source_id",
    "corpus_version",
    "license",
    "synth_method",
    "synth_base_id",
)

SCHEMA = pa.schema([
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
])


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--row-group-size", type=int, default=50_000)
    args = p.parse_args()

    cols: dict[str, list] = {c: [] for c in REQUIRED_COLUMNS}

    with args.input.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            for c in REQUIRED_COLUMNS:
                cols[c].append(row.get(c))

    print(f"Read {len(cols['raw'])} rows from {args.input}", file=sys.stderr)

    arrays = []
    for col_name in REQUIRED_COLUMNS:
        field_type = SCHEMA.field(col_name).type
        arrays.append(pa.array(cols[col_name], type=field_type))
    table = pa.Table.from_arrays(arrays, schema=SCHEMA)

    pq.write_table(table, args.output, compression="snappy", row_group_size=args.row_group_size)
    print(f"Wrote {table.num_rows} rows to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
