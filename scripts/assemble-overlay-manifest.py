#!/usr/bin/env python3
"""Assemble a corpus OVERLAY MANIFEST — generalized from assemble-fr-admin-split-overlay-manifest.py.
ADDS one shard parquet to a base corpus, keeping every base shard VERBATIM (pure overlay ADD), and
re-roots base paths to /data (the Modal volume). Parameterized by --shard-parquet + --source so it
works for any overlay shard (the fr-admin-split one is the original; #148's overture-multilocale is
the second user).

Pipeline (the recipe rides the result):
  node scripts/build-overture-multilocale-canonical.mjs --cap 150000 --out /tmp/ovl/overture-ml.canonical.jsonl
  node scripts/align-canonical-shard.mjs --input <canonical> --output <labeled> --corpus-version 0.5.0
  python3 scripts/jsonl-to-parquet.py --input <labeled> --output <NEW>/train/<shard-parquet>
  python3 scripts/assemble-overlay-manifest.py --base <BASE>/MANIFEST.json --new-dir <NEW> \
      --modal-root /data/corpus/versioned/<ver>/<dir> --version <ver> \
      --shard-parquet <shard-parquet> --source <source> --note "..."
  # then push the overlay to R2 + sync + `modal run -d ... --config <recipe>.yaml --resume none`.
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
    ap.add_argument("--base", type=Path, required=True, help="base MANIFEST.json to overlay")
    ap.add_argument("--new-dir", type=Path, required=True, help="local overlay corpus dir (holds the shard parquet + the written manifest)")
    ap.add_argument("--modal-root", required=True, help="the overlay corpus root as the trainer sees it on the Modal volume")
    ap.add_argument("--version", required=True)
    ap.add_argument("--shard-parquet", required=True, help="the new shard parquet filename under <new-dir>/train/")
    ap.add_argument("--source", required=True, help="the canonical source id for the new shard (must match the recipe source_weights key)")
    ap.add_argument("--note", default="", help="manifest note")
    args = ap.parse_args()

    base = json.loads(args.base.read_text())

    if any(s.get("source") == args.source for s in base["shards"]):
        print(f"WARN: base already contains source '{args.source}' — is this the right base?")

    def _reroot(p):
        i = p.find("/corpus/versioned/")
        return ("/data" + p[i:]) if i >= 0 else p

    kept = [{**s, "path": _reroot(s["path"])} for s in base["shards"]]

    new_train = _descriptor(
        args.new_dir / "train" / args.shard_parquet,
        f"{args.modal_root}/train/{args.shard_parquet}",
        "train",
        args.source,
    )

    manifest = {
        "corpus_version": args.version,
        "overlay_base": base.get("corpus_version"),
        "note": args.note or f"{base.get('corpus_version')} shards (all kept verbatim) + the {args.source} shard. Pure overlay add.",
        "schema": base["schema"],
        "rows_per_shard": base["rows_per_shard"],
        "row_group_size": base["row_group_size"],
        "shards": kept + [new_train],
        "counts": {
            "train": base["counts"]["train"] + new_train["rows"],
            "val": base["counts"]["val"],
            "test": base["counts"]["test"],
        },
        "total_rows": base["total_rows"] + new_train["rows"],
    }
    out = args.new_dir / "MANIFEST.json"
    out.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {out}")
    print(f"  shards: {len(manifest['shards'])} ({len(kept)} base kept, +1 {args.source})")
    print(f"  counts: {manifest['counts']}  total: {manifest['total_rows']}")
    print(f"  {args.source} train: {new_train['rows']} rows ({new_train['bytes']} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
