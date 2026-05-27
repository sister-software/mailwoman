#!/usr/bin/env python3
"""Diagnose corpus shard loading — run locally or on Modal to confirm which
shards the data loader actually sees.

Usage:
  uv run python scripts/diagnose-corpus.py --corpus-dir /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.0/corpus-v0.4.0

On Modal:
  modal run scripts/modal/train_remote.py::diagnose_corpus
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-dir", required=True)
    args = parser.parse_args()

    corpus_dir = Path(args.corpus_dir)
    manifest = corpus_dir / "MANIFEST.json"

    print(f"Corpus dir: {corpus_dir}")
    print(f"Manifest exists: {manifest.exists()}")

    if manifest.exists():
        data = json.loads(manifest.read_text())
        shards = data.get("shards", [])
        train_shards = [s for s in shards if s.get("split") == "train"]
        print(f"MANIFEST: {len(shards)} total shards, {len(train_shards)} train")
        print(f"MANIFEST train rows: {sum(s['rows'] for s in train_shards):,}")

        # Check which paths exist
        existing = 0
        missing = 0
        for s in train_shards:
            p = Path(s["path"])
            if p.exists():
                existing += 1
            else:
                missing += 1
                if missing <= 5:
                    print(f"  MISSING: {p}")

        print(f"\nTrain shard files: {existing} exist, {missing} missing")
        if missing > 5:
            print(f"  ... and {missing - 5} more missing")

    # Now test the actual data loader indexing
    print("\n--- Data loader shard indexing ---")
    sys.path.insert(0, str(Path(__file__).parent.parent / "corpus-python" / "src"))
    from mailwoman_train.data_loader import _shard_paths, _shard_first_source

    paths = _shard_paths(corpus_dir, "train")
    print(f"_shard_paths returned {len(paths)} train shards")

    from collections import Counter
    by_source = Counter()
    errors = 0
    for p in paths:
        if not p.exists():
            errors += 1
            continue
        try:
            src = _shard_first_source(p)
            by_source[src] += 1
        except Exception as exc:
            errors += 1
            print(f"  ERROR reading {p}: {exc}")

    print(f"\nSource index ({errors} errors):")
    for src, count in by_source.most_common():
        print(f"  {src:35s} {count:4d} shards")


if __name__ == "__main__":
    main()
