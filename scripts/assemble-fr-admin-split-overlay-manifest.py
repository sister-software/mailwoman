#!/usr/bin/env python3
"""Assemble the fr-admin-split overlay MANIFEST (night 2026-06-19, surpass-v1.5.0).

ADDS the synth-fr-admin-split shard (scripts/build-fr-admin-split-shard.mjs) to a base corpus,
keeping every base shard VERBATIM (pure overlay ADD). The shard teaches the model to split the
département out of the locality on bare/space/comma FR rows — the admin-deciding failure class the
pre-GPU self-validation proved moves the resolved coordinate (collision communes -61%).

Pipeline (the v1.8.0-fr-admin-split recipe rides the result):
  node scripts/build-fr-admin-split-shard.mjs --output /tmp/fr-admin-split-train.jsonl --count 60000 --seed 42
  python3 scripts/jsonl-to-parquet.py --input /tmp/fr-admin-split-train.jsonl \
      --output <NEW>/train/part-fr-admin-split-train.parquet
  python3 scripts/assemble-fr-admin-split-overlay-manifest.py \
      --base <BASE>/v0.5.0/corpus-v0.5.0/MANIFEST.json \
      --new-dir <NEW>/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split \
      --modal-root /data/corpus/versioned/v0.8.0-fr-admin-split/corpus-v0.8.0-fr-admin-split \
      --version v0.8.0-fr-admin-split
  # then push the overlay to R2 + sync_v080 + `modal run -d ... --config v1.8.0-fr-admin-split.yaml --resume none`.
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
    ap.add_argument("--base", type=Path, required=True, help="base MANIFEST.json to overlay (corpus-v0.5.0)")
    ap.add_argument("--new-dir", type=Path, required=True, help="local overlay corpus dir (holds the shard parquet + the written manifest)")
    ap.add_argument("--modal-root", required=True, help="the overlay corpus root as the trainer sees it on the Modal volume")
    ap.add_argument("--version", default="v0.8.0-fr-admin-split")
    args = ap.parse_args()

    base = json.loads(args.base.read_text())

    if any(s.get("source") == "synth-fr-admin-split" for s in base["shards"]):
        print("WARN: base already contains synth-fr-admin-split — is this the right base?")

    # Re-root base shards to /data (the trainer reads each manifest path AS-IS; on Modal the base
    # corpus lives under /data, not the local /mnt/playpen build path).
    def _reroot(p):
        i = p.find("/corpus/versioned/")
        return ("/data" + p[i:]) if i >= 0 else p

    kept = [{**s, "path": _reroot(s["path"])} for s in base["shards"]]

    new_train = _descriptor(
        args.new_dir / "train" / "part-fr-admin-split-train.parquet",
        f"{args.modal_root}/train/part-fr-admin-split-train.parquet",
        "train",
        "synth-fr-admin-split",
    )

    manifest = {
        "corpus_version": args.version,
        "overlay_base": base.get("corpus_version"),
        "note": (
            f"{base.get('corpus_version')} shards (all kept verbatim) + the synth-fr-admin-split shard: "
            "split the département out of the locality on bare/space/comma FR rows (the admin-deciding "
            "failure class). Real BAN commune+postcode tuples, département derived via codex. Pure overlay add."
        ),
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
    print(f"  shards: {len(manifest['shards'])} ({len(kept)} base kept, +1 fr-admin-split)")
    print(f"  counts: {manifest['counts']}  total: {manifest['total_rows']}")
    print(f"  fr-admin-split train: {new_train['rows']} rows ({new_train['bytes']} bytes)")
    # Guard: no /mnt paths must survive into the manifest (the v1.6.0 re-root trap).
    mnt = sum("/mnt" in s["path"] for s in manifest["shards"])
    print(f"  /mnt paths remaining: {mnt} (MUST be 0)")
    return 0 if mnt == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
