#!/usr/bin/env python3
"""Convert a JSONL of LabeledRow objects to a Parquet shard matching the v0.5.0 schema.

Schema: raw, tokens, labels, span_starts, span_ends, span_tags, country, locale, source,
        source_id, corpus_version, license, synth_method, synth_base_id.

The span triple (#519, v0.5.0 char-offset labels) is REQUIRED on every row: `alignRow` emits it
on every labeled row, so a row arriving without it came from a producer that hasn't migrated —
writing it would silently drop the v0.5.0 labels from the shard. Loud failure, naming the row
number, instead.

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
    "span_starts",
    "span_ends",
    "span_tags",
    "country",
    "locale",
    "source",
    "source_id",
    "corpus_version",
    "license",
    "synth_method",
    "synth_base_id",
)

SPAN_COLUMNS = ("span_starts", "span_ends", "span_tags")

SCHEMA = pa.schema([
    ("raw", pa.string()),
    ("tokens", pa.list_(pa.string())),
    ("labels", pa.list_(pa.string())),
    # v0.5.0 char-offset label spans (#519): parallel arrays over `raw` (UTF-16 code units,
    # [start, end) exclusive-end, sorted, non-overlapping). int32 matches the TS writer's INT32.
    ("span_starts", pa.list_(pa.int32())),
    ("span_ends", pa.list_(pa.int32())),
    ("span_tags", pa.list_(pa.string())),
    ("country", pa.string()),
    ("locale", pa.string()),
    ("source", pa.string()),
    ("source_id", pa.string()),
    ("corpus_version", pa.string()),
    ("license", pa.string()),
    ("synth_method", pa.string()),
    ("synth_base_id", pa.string()),
])


def assert_span_triple(row: dict, line_no: int) -> None:
    """Enforce the #519 span contract per row: all three present, parallel lengths.

    A row with span_starts but no span_tags is a corrupt row — never a silent fallback.
    """
    present = [c for c in SPAN_COLUMNS if row.get(c) is not None]
    if len(present) != len(SPAN_COLUMNS):
        missing = [c for c in SPAN_COLUMNS if row.get(c) is None]
        raise ValueError(
            f"line {line_no}: row is missing the char-offset span triple (#519): "
            f"missing {missing} (source_id={row.get('source_id')!r}). Every parquet-bound row "
            "must carry span_starts/span_ends/span_tags; re-emit this shard through alignRow."
        )
    n = len(row["span_starts"])
    if len(row["span_ends"]) != n or len(row["span_tags"]) != n:
        raise ValueError(
            f"line {line_no}: span triple arrays are not parallel — "
            f"starts={len(row['span_starts'])} ends={len(row['span_ends'])} "
            f"tags={len(row['span_tags'])} (source_id={row.get('source_id')!r})"
        )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--row-group-size", type=int, default=50_000)
    args = p.parse_args()

    cols: dict[str, list] = {c: [] for c in REQUIRED_COLUMNS}

    with args.input.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            assert_span_triple(row, line_no)
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
