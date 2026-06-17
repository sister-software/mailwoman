#!/usr/bin/env python3
"""Assemble the boundary-stress overlay MANIFEST (#375 — the #1-lever shard, corpus side).

ADDS the synth-boundary-stress shard (corpus/src/synthesize-boundary-stress.ts, PRs #703/#704/#705)
to a base corpus version, keeping every base shard VERBATIM (this is a pure overlay ADD, not a swap —
unlike the affix reroll which dropped its predecessor). The boundary-stress shard puts the gold token
boundary on diverse realizations of the five wobble shapes (street-eats-affix, comma-less City/STATE,
fr-prefix, house-number-after-street, AU/UK slash) so a retrain learns the #1 lever from context.

Pipeline (the v1.6.0-boundary-stress recipe rides the result):
  node scripts/build-boundary-stress-shard.mjs --count 20000 --seed 20260617 \
      --out /tmp/boundary-stress-train.jsonl
  python3 scripts/jsonl-to-parquet.py --input /tmp/boundary-stress-train.jsonl \
      --output <NEW>/train/part-boundary-stress-train.parquet
  python3 scripts/assemble-boundary-stress-overlay-manifest.py \
      --base <BASE>/v0.5.0/corpus-v0.5.0/MANIFEST.json \
      --new-dir <NEW>/v0.6.0-boundary-stress/corpus-v0.6.0-boundary-stress \
      --modal-root /data/corpus/versioned/v0.6.0-boundary-stress/corpus-v0.6.0-boundary-stress \
      --version v0.6.0-boundary-stress
  # then `modal volume put` the parquet + manifest onto the mailwoman-training volume, and
  # `modal run -d scripts/modal/train_remote.py --config v1.6.0-boundary-stress.yaml --resume none`.

Run the #511 base-consistency lint on the shard BEFORE training (it can't outvote a contradicting base).
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
    ap.add_argument("--base", type=Path, required=True, help="base MANIFEST.json to overlay (e.g. v0.5.0)")
    ap.add_argument("--new-dir", type=Path, required=True, help="local overlay corpus dir (holds the boundary-stress parquet + the written manifest)")
    ap.add_argument("--modal-root", required=True, help="the overlay corpus root as the trainer sees it on the Modal volume")
    ap.add_argument("--version", default="v0.6.0-boundary-stress")
    args = ap.parse_args()

    base = json.loads(args.base.read_text())

    # Pure ADD: every base shard kept verbatim; refuse to double-add on re-run.
    if any(s.get("source") == "synth-boundary-stress" for s in base["shards"]):
        print("WARN: base already contains synth-boundary-stress — is this the right base?")
    kept = list(base["shards"])

    bs_train = _descriptor(
        args.new_dir / "train" / "part-boundary-stress-train.parquet",
        f"{args.modal_root}/train/part-boundary-stress-train.parquet",
        "train",
        "synth-boundary-stress",
    )

    manifest = {
        "corpus_version": args.version,
        "overlay_base": base.get("corpus_version"),
        "note": (
            f"{base.get('corpus_version')} shards (all kept verbatim) + the synth-boundary-stress shard "
            "(#375 #1-lever): diverse gold boundaries for the 5 wobble shapes (street-eats-affix, "
            "comma-less City/STATE, fr-prefix, house-number-after-street, AU/UK slash). Pure overlay add."
        ),
        "schema": base["schema"],
        "rows_per_shard": base["rows_per_shard"],
        "row_group_size": base["row_group_size"],
        "shards": kept + [bs_train],
        "counts": {
            "train": base["counts"]["train"] + bs_train["rows"],
            "val": base["counts"]["val"],
            "test": base["counts"]["test"],
        },
        "total_rows": base["total_rows"] + bs_train["rows"],
    }
    out = args.new_dir / "MANIFEST.json"
    out.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {out}")
    print(f"  shards: {len(manifest['shards'])} ({len(kept)} base kept, +1 boundary-stress)")
    print(f"  counts: {manifest['counts']}  total: {manifest['total_rows']}")
    print(f"  boundary-stress train: {bs_train['rows']} rows ({bs_train['bytes']} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
