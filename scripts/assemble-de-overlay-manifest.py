#!/usr/bin/env python3
"""Assemble the v0.4.1-de overlay MANIFEST for the PR3 self-conditioning pilot.

The trainer reads a corpus_dir of parquet shards + a MANIFEST.json. v0.4.0 is US/FR; this writes a
new overlay manifest that references v0.4.0's base shards VERBATIM (their Modal `/data` paths, which
resolve on the volume) plus two new German shards (synth-german, Berlin/Saxony OA tuples rendered
German-order). The data loader does not verify shard sha256 at load time (only existence), and it
re-roots stale `/data` paths under corpus_dir — so the overlay is a pure shard-list concatenation,
no rebuild of the 677M base rows.

Pipeline (the German shards are built first, see build-german-shard.mjs + jsonl-to-parquet.py):
  node scripts/build-german-shard.mjs --output /tmp/german-train.jsonl --count 200000 --seed 42
  node scripts/build-german-shard.mjs --output /tmp/german-val.jsonl   --count 4000   --seed 99
  python3 scripts/jsonl-to-parquet.py --input /tmp/german-train.jsonl --output <NEW>/train/part-german-train.parquet
  python3 scripts/jsonl-to-parquet.py --input /tmp/german-val.jsonl   --output <NEW>/val/part-german-val.parquet
  python3 scripts/assemble-de-overlay-manifest.py \
      --base /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.0/corpus-v0.4.0/MANIFEST.json \
      --new-dir /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.1-de/corpus-v0.4.1-de \
      --modal-root /data/corpus/versioned/v0.4.1-de/corpus-v0.4.1-de
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
    ap.add_argument("--base", type=Path, required=True, help="v0.4.0 MANIFEST.json to overlay")
    ap.add_argument("--new-dir", type=Path, required=True, help="local overlay corpus dir (holds the German parquets + the written manifest)")
    ap.add_argument("--modal-root", required=True, help="the overlay corpus root as the trainer sees it on the Modal volume")
    ap.add_argument("--version", default="v0.4.1-de")
    args = ap.parse_args()

    base = json.loads(args.base.read_text())
    de_train = _descriptor(
        args.new_dir / "train" / "part-german-train.parquet",
        f"{args.modal_root}/train/part-german-train.parquet",
        "train",
        "synth-german",
    )
    de_val = _descriptor(
        args.new_dir / "val" / "part-german-val.parquet",
        f"{args.modal_root}/val/part-german-val.parquet",
        "val",
        "synth-german",
    )

    manifest = {
        "corpus_version": args.version,
        "overlay_base": base.get("corpus_version"),
        "note": (
            f"{base.get('corpus_version')} (US/FR) base shards referenced verbatim + a synth-german "
            "overlay (Berlin/Saxony OA tuples, German-order) for the PR3 self-conditioning pilot."
        ),
        "schema": base["schema"],
        "rows_per_shard": base["rows_per_shard"],
        "row_group_size": base["row_group_size"],
        "shards": base["shards"] + [de_train, de_val],
        "counts": {
            "train": base["counts"]["train"] + de_train["rows"],
            "val": base["counts"]["val"] + de_val["rows"],
            "test": base["counts"]["test"],
        },
        "total_rows": base["total_rows"] + de_train["rows"] + de_val["rows"],
    }
    out = args.new_dir / "MANIFEST.json"
    out.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {out}")
    print(f"  shards: {len(manifest['shards'])} ({len(base['shards'])} base + 2 German)")
    print(f"  counts: {manifest['counts']}  total: {manifest['total_rows']}")
    print(f"  DE train: {de_train['rows']} rows ({de_train['bytes']} bytes)  DE val: {de_val['rows']} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
