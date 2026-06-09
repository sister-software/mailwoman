#!/usr/bin/env python3
"""Assemble a country-overlay MANIFEST that references a base corpus's shards VERBATIM + the balanced
country shard (build-country-shard-balanced.mjs). Mirrors assemble-de-overlay-manifest.py: the data
loader checks existence + re-roots stale /data paths, so the overlay is a pure shard-list concat —
no rebuild of the base rows.

Pipeline:
  node scripts/build-country-shard-balanced.mjs --output /tmp/country-bal-train.jsonl --count 50000 --seed 42
  node scripts/build-country-shard-balanced.mjs --output /tmp/country-bal-val.jsonl --golden --count 2000 --seed 99
  python3 scripts/jsonl-to-parquet.py --input /tmp/country-bal-train.jsonl --output <NEW>/train/part-country-train.parquet
  python3 scripts/jsonl-to-parquet.py --input /tmp/country-bal-val.jsonl   --output <NEW>/val/part-country-val.parquet
  python3 scripts/assemble-country-overlay-manifest.py \
      --base /tmp/base-unit-v2/MANIFEST.json \
      --new-dir /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.10-country-bal/corpus-v0.4.10-country-bal \
      --modal-root /data/corpus/versioned/v0.4.10-country-bal/corpus-v0.4.10-country-bal \
      --version v0.4.10-country-bal
  # then `modal volume put` the two parquets + the manifest onto the mailwoman-training volume.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import pyarrow.parquet as pq


def _descriptor(local_path: Path, modal_path: str, split: str, source: str) -> dict:
    sids = pq.read_table(local_path, columns=["source_id"])["source_id"].to_pylist()
    return {
        "split": split,
        "path": modal_path,
        "format": "parquet",
        "compression": "SNAPPY",
        "rows": len(sids),
        "bytes": os.path.getsize(local_path),
        "sha256": hashlib.sha256(local_path.read_bytes()).hexdigest(),
        "first_source_id": sids[0],
        "last_source_id": sids[-1],
        "source": source,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", type=Path, required=True, help="base MANIFEST.json to overlay (e.g. v0.4.5-unit-v2)")
    ap.add_argument("--new-dir", type=Path, required=True, help="local overlay corpus dir (holds the country parquets + the written manifest)")
    ap.add_argument("--modal-root", required=True, help="the overlay corpus root as the trainer sees it on the Modal volume")
    ap.add_argument("--version", default="v0.4.10-country-bal")
    args = ap.parse_args()

    base = json.loads(args.base.read_text())
    c_train = _descriptor(
        args.new_dir / "train" / "part-country-train.parquet",
        f"{args.modal_root}/train/part-country-train.parquet",
        "train",
        "synth-country",
    )
    c_val = _descriptor(
        args.new_dir / "val" / "part-country-val.parquet",
        f"{args.modal_root}/val/part-country-val.parquet",
        "val",
        "synth-country",
    )

    manifest = {
        "corpus_version": args.version,
        "overlay_base": base.get("corpus_version"),
        "note": (
            f"{base.get('corpus_version')} base shards referenced verbatim + the BALANCED country "
            "shard (model-first, #464): homograph contrast pairs + code-as-region negatives + breadth, "
            "built to avoid the night-9 trailing-country-only over-fire."
        ),
        "schema": base["schema"],
        "rows_per_shard": base["rows_per_shard"],
        "row_group_size": base["row_group_size"],
        "shards": base["shards"] + [c_train, c_val],
        "counts": {
            "train": base["counts"]["train"] + c_train["rows"],
            "val": base["counts"]["val"] + c_val["rows"],
            "test": base["counts"]["test"],
        },
        "total_rows": base["total_rows"] + c_train["rows"] + c_val["rows"],
    }
    out = args.new_dir / "MANIFEST.json"
    out.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {out}")
    print(f"  shards: {len(manifest['shards'])} ({len(base['shards'])} base + 2 country)")
    print(f"  counts: {manifest['counts']}  total: {manifest['total_rows']}")
    print(f"  country train: {c_train['rows']} rows ({c_train['bytes']} bytes)  val: {c_val['rows']} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
