#!/usr/bin/env python3
"""Generate the TS↔Python tokenizer parity fixture.

Reads a `tokenizer.model` (default: v0.1.0 from the host's models dir), runs
SentencePiece against a curated set of address-shaped inputs, and writes a
JSON file with one entry per input:

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

## Usage

    python3 generate-tokenizer-parity.py \\
        --model /mnt/playpen/mailwoman-data/models/tokenizer/v0.1.0/tokenizer.model \\
        --out  packages/neural/neural/test/fixtures/tokenizer-parity-v0.1.0.json

Idempotent. Re-run after editing the curated inputs list to refresh.
"""

from __future__ import annotations

import argparse
import json
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
INPUTS: list[str] = [
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, type=Path, help="tokenizer.model path")
    parser.add_argument("--out", required=True, type=Path, help="output JSON path")
    args = parser.parse_args()

    sp = spm.SentencePieceProcessor()
    sp.Load(str(args.model))

    out = []
    for raw in INPUTS:
        out.append(
            {
                "raw": raw,
                "pieces": sp.EncodeAsPieces(raw),
                "ids": sp.EncodeAsIds(raw),
            }
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stderr.write(f"wrote {len(out)} fixture entries to {args.out}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
