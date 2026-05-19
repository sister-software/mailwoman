#!/usr/bin/env python3
"""Sample balanced US/FR `raw` strings from a corpus-vX.Y.Z parquet train split.

Streams every train shard once, materializes a per-country reservoir of `raw`
strings, then writes the concatenated sample (shuffled) to stdout or `--output`.

Used to feed `train_tokenizer.py`; not part of any production loop.

Usage:

    python sample_balanced_raws.py \
      --corpus-dir /data/corpus/versioned/v0.1.0/corpus-v0.1.0 \
      --per-country 500000 \
      --output /tmp/raws.txt
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

import pyarrow.parquet as pq


def reservoir_sample(it, k: int, rng: random.Random) -> list[str]:
    """Algorithm R reservoir sampler over an iterable of strings."""
    out: list[str] = []
    for i, x in enumerate(it):
        if i < k:
            out.append(x)
        else:
            j = rng.randint(0, i)
            if j < k:
                out[j] = x
    return out


def iter_raws(corpus_dir: Path, country: str):
    """Yield `raw` strings from every train shard whose row matches `country`."""
    for shard in sorted((corpus_dir / "train").glob("*.parquet")):
        # Column-projected read keeps RSS low even on 1M-row shards.
        t = pq.read_table(shard, columns=["raw", "country"])
        raws = t["raw"]
        countries = t["country"]
        for i in range(t.num_rows):
            if countries[i].as_py() == country:
                yield raws[i].as_py()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-dir", type=Path, required=True)
    parser.add_argument("--per-country", type=int, default=500_000)
    parser.add_argument(
        "--countries",
        type=str,
        default="US,FR",
        help="Comma-separated ISO 3166-1 alpha-2 codes to sample.",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    sample: list[str] = []
    for cc in args.countries.split(","):
        cc = cc.strip()
        if not cc:
            continue
        picked = reservoir_sample(iter_raws(args.corpus_dir, cc), args.per_country, rng)
        sys.stderr.write(f"sampled {len(picked):,} for country={cc}\n")
        sample.extend(picked)

    rng.shuffle(sample)

    out = sys.stdout
    close = False
    if args.output is not None:
        out = args.output.open("w", encoding="utf-8")
        close = True
    try:
        for line in sample:
            out.write(line.replace("\n", " "))
            out.write("\n")
    finally:
        if close:
            out.close()

    sys.stderr.write(f"wrote {len(sample):,} lines\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
