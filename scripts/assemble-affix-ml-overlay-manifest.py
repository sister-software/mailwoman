#!/usr/bin/env python3
"""Assemble the MULTI-LOCALE affix-overlay MANIFEST (#466 step 1 — the affix reroll).

v0.9.8's only blemish was FR-postcode dilution from a US-ONLY affix shard (FR postcode −3.9). The
multi-locale country shard demonstrated the recovery (95.6→99.5); this reroll folds the same fix into
the affix shard itself: native-order FR/DE/IT/NL BALANCE rows (no affix split, no annotation) restore
the postcode-ORDER distribution so the US affix coverage doesn't pull the model US-ward.

This is a pure SHARD SWAP, not a rebuild: it reads the v0.4.6-affix manifest (= v0.4.5-unit-v2 base +
the US-only affix shard), DROPS the old `synth-affix` shard, and ADDS the new multi-locale affix
parquet. The base shards (and synth-unit / synth-german / deepseek overlays) are referenced VERBATIM —
the US affix dose is identical to v0.9.8 (same 50K `--count`), so the only conceptual change vs v0.9.8
is the appended multi-locale balance rows.

Pipeline:
  node scripts/build-street-affix-shard.mjs --output /tmp/affix-ml-train.jsonl \
      --count 50000 --multilocale-count 40000 --seed 42
  python3 scripts/jsonl-to-parquet.py --input /tmp/affix-ml-train.jsonl \
      --output <NEW>/train/part-affix-ml-train.parquet
  python3 scripts/assemble-affix-ml-overlay-manifest.py \
      --base /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.6-affix/corpus-v0.4.6-affix/MANIFEST.json \
      --new-dir /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.11-affix-ml/corpus-v0.4.11-affix-ml \
      --modal-root /data/corpus/versioned/v0.4.11-affix-ml/corpus-v0.4.11-affix-ml \
      --version v0.4.11-affix-ml
  # then `modal volume put` the parquet + the manifest onto the mailwoman-training volume.
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
    ap.add_argument("--base", type=Path, required=True, help="base MANIFEST.json to swap (v0.4.6-affix)")
    ap.add_argument("--new-dir", type=Path, required=True, help="local overlay corpus dir (holds the affix-ml parquet + the written manifest)")
    ap.add_argument("--modal-root", required=True, help="the overlay corpus root as the trainer sees it on the Modal volume")
    ap.add_argument("--version", default="v0.4.11-affix-ml")
    args = ap.parse_args()

    base = json.loads(args.base.read_text())

    # Drop the OLD US-only affix shard(s); keep everything else (base + unit + german + deepseek) verbatim.
    kept = [s for s in base["shards"] if s.get("source") != "synth-affix"]
    dropped = len(base["shards"]) - len(kept)
    if dropped == 0:
        print("WARN: no synth-affix shard found in base — is this the v0.4.6-affix manifest?")
    dropped_rows = sum(s["rows"] for s in base["shards"] if s.get("source") == "synth-affix" and s["split"] == "train")

    a_train = _descriptor(
        args.new_dir / "train" / "part-affix-ml-train.parquet",
        f"{args.modal_root}/train/part-affix-ml-train.parquet",
        "train",
        "synth-affix",
    )

    manifest = {
        "corpus_version": args.version,
        "overlay_base": base.get("corpus_version"),
        "note": (
            f"{base.get('corpus_version')} shards minus the US-only synth-affix shard + a MULTI-LOCALE "
            "affix shard (#466 step 1): 50K US affix splits (USPS Pub-28 C1/C2, identical dose to "
            "v0.9.8) + native-order FR/DE/IT/NL balance rows to undo the FR-postcode dilution."
        ),
        "schema": base["schema"],
        "rows_per_shard": base["rows_per_shard"],
        "row_group_size": base["row_group_size"],
        "shards": kept + [a_train],
        "counts": {
            "train": base["counts"]["train"] - dropped_rows + a_train["rows"],
            "val": base["counts"]["val"],
            "test": base["counts"]["test"],
        },
        "total_rows": base["total_rows"] - dropped_rows + a_train["rows"],
    }
    out = args.new_dir / "MANIFEST.json"
    out.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {out}")
    print(f"  shards: {len(manifest['shards'])} ({len(kept)} kept, dropped {dropped} old affix, +1 affix-ml)")
    print(f"  counts: {manifest['counts']}  total: {manifest['total_rows']}")
    print(f"  affix-ml train: {a_train['rows']} rows ({a_train['bytes']} bytes)  (old affix train was {dropped_rows})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
