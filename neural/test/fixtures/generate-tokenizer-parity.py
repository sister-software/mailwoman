#!/usr/bin/env python3
"""Generate the TS↔Python tokenizer parity fixture.

Reads a `tokenizer.model` (default: v0.1.0 from the host's models dir), runs
SentencePiece against either a curated set of address-shaped inputs OR a
sampled set of raws drawn from a corpus parquet file, and writes a JSON
file with one entry per input:

    [
      {
        "raw": "75004 Paris",
        "pieces": ["▁7500", "4", "▁Paris"],
        "ids": [391, 362, 287]
      },
      ...
    ]

The TS parity test loads this file plus the same tokenizer.model and asserts
byte-for-byte equality with `encode(raw)`. Offsets aren't in the fixture —
the test reconstructs them in TS and validates by slicing `raw[start:end]`
against the literal piece text.

## Curated mode (committed fixture)

    python3 generate-tokenizer-parity.py \\
        --model /mnt/playpen/mailwoman-data/models/tokenizer/v0.1.0/tokenizer.model \\
        --out  packages/neural/neural/test/fixtures/tokenizer-parity-v0.1.0.json

17 hand-curated inputs covering Latin baseline, multi-word, numerics,
hyphenation, Latin diacritics. CI-safe size.

## Large-scale mode (gitignored fixture, host-only)

    python3 generate-tokenizer-parity.py \\
        --model     /mnt/playpen/mailwoman-data/models/tokenizer/v0.1.0/tokenizer.model \\
        --from-parquet /mnt/playpen/mailwoman-data/corpus/versioned/v0.2.0/corpus-v0.2.0/val/part-0000.parquet \\
        --sample 10000 \\
        --seed   42 \\
        --out    packages/neural/neural/test/fixtures/tokenizer-parity-large-v0.1.0.json

Reads N raws from the parquet file's `raw` column with a deterministic
seed, tokenizes each, writes the fixture. Exercises real-world edge cases
(multi-script, multiple consecutive spaces, weird quoting). The output is
~3 MB for N=10000 and is excluded from git.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

try:
    import sentencepiece as spm
except ImportError:
    sys.stderr.write("pip install sentencepiece\n")
    raise SystemExit(2)


# Curated inputs covering: ASCII baseline, multi-word, numerics, hyphenation,
# Latin diacritics, mixed scripts, punctuation. Every entry is a hand-vetted
# real-world or close-to-real-world address fragment.
CURATED_INPUTS: list[str] = [
    "Paris",
    "75004 Paris",
    "1600 Pennsylvania Avenue NW, Washington, DC 20500",
    "Saint-Petersburg",
    "Café Régal",
    "São Paulo",
    "15 Rue de Rivoli",
    "245 1st Ave N, Saint Petersburg, FL 33701",
    "PO Box 1234, Anchorage, AK 99501",
    "40-12 Bell Blvd, Bayside, NY 11361",
    "The New York Steakhouse, 123 Main St, New York, NY 10001",
    "Buffalo Health Center Inc., 200 Elmwood Ave, Buffalo, NY 14222",
    "RR 2 Box 67, Rural Springs, MT 59101",
    "15 Rue de Rivoli, 75004 Paris, France",
    "London",
    "10 Downing Street",
    "",
]


def sample_from_parquet(path: Path, n: int, seed: int) -> list[str]:
    """Read N raws from a parquet `raw` column with a deterministic sample."""
    try:
        import pyarrow.parquet as pq
    except ImportError:
        sys.stderr.write("pip install pyarrow\n")
        raise SystemExit(2)

    table = pq.read_table(str(path), columns=["raw"])
    raws = table.column("raw").to_pylist()
    if n >= len(raws):
        return raws
    rng = random.Random(seed)
    return rng.sample(raws, n)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, type=Path, help="tokenizer.model path")
    parser.add_argument("--out", required=True, type=Path, help="output JSON path")
    parser.add_argument("--from-parquet", type=Path, help="Sample raws from this parquet file's `raw` column.")
    parser.add_argument("--sample", type=int, default=10000, help="Number of raws to sample (large-scale mode).")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for the sample (large-scale mode).")
    args = parser.parse_args()

    sp = spm.SentencePieceProcessor()
    sp.Load(str(args.model))

    if args.from_parquet:
        inputs = sample_from_parquet(args.from_parquet, args.sample, args.seed)
        sys.stderr.write(f"sampled {len(inputs)} raws from {args.from_parquet} (seed={args.seed})\n")
    else:
        inputs = CURATED_INPUTS
        sys.stderr.write(f"using {len(inputs)} curated inputs\n")

    out = [{"raw": raw, "pieces": sp.EncodeAsPieces(raw), "ids": sp.EncodeAsIds(raw)} for raw in inputs]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stderr.write(f"wrote {len(out)} fixture entries to {args.out}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
