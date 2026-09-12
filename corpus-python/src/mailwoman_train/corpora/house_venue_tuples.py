"""Assemble the house-venue tuples input from each country's own register.

Every country reads a different source with a different schema — France a BAN extract, the United
States one situs database per state, Great Britain a CSV derived from the Price Paid Data — and
each renders its own surface conventions. Those live in `countries/<code>/tuples.py`. This module
knows only the budget per country and the output file, so adding a country adds a module and a row
in `SOURCES` and touches nobody else's sampler.

The output feeds the house-venue recipe's synthesizer, which owns the rendering into addresses;
these are the raw component tuples.

Usage:
    python -m mailwoman_train.corpora.house_venue_tuples [--fr 60000] [--us 60000] [--gb 60000]
"""

from __future__ import annotations

import argparse
import json
import random
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from ..countries.fr import tuples as fr_tuples
from ..countries.gb import tuples as gb_tuples
from ..countries.us import tuples as us_tuples
from ..paths import data_root_path

OUT_PARTS = ("corpus", "intermediate", "house-venue-tuples-v3.jsonl")

#: Street surfaces held out for the FR eval fixture. Sampling them into the training tuples would
#: put the board's own surfaces in the corpus.
FR_RESERVED_SURFACES = Path("mailwoman/eval-harness/fixtures/ban-fragments-fr.surfaces.txt")

#: Country code to the sampler that answers its tuples, in output order.
SOURCES: dict[str, Callable[[int, random.Random], Iterator[dict[str, Any]]]] = {
    "fr": lambda count, rng: fr_tuples.iter_tuples(
        count, rng, reserved=fr_tuples.reserved_surfaces(FR_RESERVED_SURFACES)
    ),
    "us": us_tuples.iter_tuples,
    "gb": gb_tuples.iter_tuples,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for code in SOURCES:
        parser.add_argument(f"--{code}", type=int, default=60_000, help=f"{code.upper()} tuples to sample")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(OUT_PARTS))
    args = parser.parse_args()

    out_path = Path(args.out or data_root_path(*OUT_PARTS))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)

    written: dict[str, int] = {}
    with out_path.open("w", encoding="utf-8") as handle:
        for code, sample in SOURCES.items():
            budget = getattr(args, code)
            count = 0
            for tup in sample(budget, rng) if budget > 0 else ():
                handle.write(json.dumps(tup, ensure_ascii=False) + "\n")
                count += 1
            written[code] = count

    summary = " + ".join(f"{code.upper()} {count:,}" for code, count in written.items())
    print(f"{out_path}: {summary} tuples")


if __name__ == "__main__":
    main()
