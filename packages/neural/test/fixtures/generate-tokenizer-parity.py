"""Build a tokenizer parity fixture shared by TypeScript and Python tests.

What this script does:
- loads a SentencePiece `tokenizer.model`
- tokenizes input strings
- writes JSON entries like:

        {"raw": "75004 Paris", "pieces": ["▁7500", "4", "▁Paris"], "ids": [391, 362, 287]}

TS tests read this JSON + the same model and check that TS tokenization
matches Python byte-for-byte.

Modes:
- Curated (small, committed): uses built-in example address strings.
- Parquet sample (large, local-only): samples `raw` values from a parquet file.

Examples:

        python3 packages/neural/test/fixtures/generate-tokenizer-parity.py \\
            --model $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.1.0/tokenizer.model \\
            --out packages/neural/test/fixtures/tokenizer-parity-v0.1.0.json

        python3 packages/neural/test/fixtures/generate-tokenizer-parity.py \\
            --model $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.1.0/tokenizer.model \\
            --from-parquet $MAILWOMAN_DATA_ROOT/corpus/versioned/v0.2.0/corpus-v0.2.0/val/part-0000.parquet \\
            --sample 10000 --seed 42 \\
            --out packages/neural/test/fixtures/tokenizer-parity-large-v0.1.0.json
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
    raise SystemExit(2) from None


# Curated inputs covering: ascii baseline, multi-word, numerics, hyphenation,
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


def sample_from_parquet(path: Path, sample_size: int, seed: int) -> list[str]:
    """Sample `raw` values in one pass while retaining at most `sample_size` strings."""
    try:
        import pyarrow.parquet as pq
    except ImportError:
        sys.stderr.write("pip install pyarrow\n")
        raise SystemExit(2) from None

    rng = random.Random(seed)
    reservoir: list[str] = []
    rows_read = 0

    parquet = pq.ParquetFile(path)
    for batch in parquet.iter_batches(columns=["raw"]):
        for raw in batch.column(0).to_pylist():
            if not isinstance(raw, str):
                actual = "null" if raw is None else type(raw).__name__
                raise TypeError(f"{path}: raw row index {rows_read} is {actual}; expected a string")

            rows_read += 1
            if len(reservoir) < sample_size:
                reservoir.append(raw)
                continue

            replacement = rng.randrange(rows_read)
            if replacement < sample_size:
                reservoir[replacement] = raw

    return reservoir


def positive_int(value: str) -> int:
    """Parse a positive integer for an argparse option."""
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)

    parser.add_argument("--model", required=True, type=Path, help="tokenizer.model path")
    parser.add_argument("--out", required=True, type=Path, help="output JSON path")
    parser.add_argument(
        "--from-parquet",
        type=Path,
        help="Sample raws from this parquet file's `raw` column.",
    )
    parser.add_argument(
        "--sample",
        type=positive_int,
        default=10000,
        help="Number of raws to sample (large-scale mode).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="RNG seed for the sample (large-scale mode).",
    )
    args = parser.parse_args()

    sp = spm.SentencePieceProcessor()
    sp.Load(str(args.model))

    if args.from_parquet:
        inputs = sample_from_parquet(args.from_parquet, args.sample, args.seed)
        sys.stderr.write(f"sampled {len(inputs)} raws from {args.from_parquet} (seed={args.seed})\n")
    else:
        inputs = CURATED_INPUTS
        sys.stderr.write(f"using {len(inputs)} curated inputs\n")

    out = [
        # Note: Third-party library names `Ids` vs our typical `IDs`.
        {"raw": raw, "pieces": sp.EncodeAsPieces(raw), "ids": sp.EncodeAsIds(raw)}
        for raw in inputs
    ]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stderr.write(f"wrote {len(out)} fixture entries to {args.out}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
