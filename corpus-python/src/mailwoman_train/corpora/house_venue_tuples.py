"""Assemble the house-venue tuples input from each country's own register.

Every country reads a different source with a different schema — France a BAN extract, the United
States one situs database per state, Great Britain the `gb-os-open` adapter's OS OpenData rows — and
each renders its own surface conventions. Those live in `countries/<code>/tuples.py`. This module
knows only the budget per country and the output file, so adding a country adds a module and a row
in `SOURCES` without changing the existing sampler.

The output feeds the house-venue recipe's synthesizer. That module renders addresses from these raw
component tuples.

Usage:
    python -m mailwoman_train.corpora.house_venue_tuples [--fr 60000] [--us 60000] [--gb 60000]
        [--carry gb --carry-from <earlier tuples.jsonl>]
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

#: v3 took its GB rows from HM Land Registry Price Paid Data, which is refused (#2635). v4 takes them from
#: OS OpenData and stamps each GB tuple with `source: gb-os-open`, which the sub-venue recipe requires.
#: v4's US rows mixed NAD with county and state bodies that OpenAddresses collects, whose register row is
#: refused. v5 keeps only NAD rows (`countries/us/tuples.py`) and was written with
#: `--carry gb --carry-from <v4>`: the GB sampler reads the shared generator after the US one, so
#: resampling GB would have changed every GB tuple as well.
OUT_PARTS = ("corpus", "intermediate", "house-venue-tuples-v5.jsonl")

#: Street surfaces held out for the FR eval fixture. The training tuples must exclude them or the
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


def carried_tuples(path: Path, code: str) -> Iterator[dict[str, Any]]:
    """Yield one country's tuples from an earlier tuples file, in file order.

    Raises:
        ValueError: when the file holds no tuple for the country, so a carry never writes an empty part.
    """
    country = code.upper()
    found = 0
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            tup = json.loads(line)
            if tup.get("country") == country:
                found += 1
                yield tup
    if not found:
        raise ValueError(f"{path} holds no {country} tuple to carry")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for code in SOURCES:
        parser.add_argument(f"--{code}", type=int, default=60_000, help=f"{code.upper()} tuples to sample")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(OUT_PARTS))
    parser.add_argument(
        "--carry",
        action="append",
        default=[],
        choices=list(SOURCES),
        help="copy this country's tuples from --carry-from instead of sampling them; repeatable",
    )
    parser.add_argument("--carry-from", default=None, help="an earlier tuples file that --carry reads")
    args = parser.parse_args()
    if args.carry and not args.carry_from:
        parser.error("--carry needs --carry-from")

    out_path = Path(args.out or data_root_path(*OUT_PARTS))
    if args.carry_from and Path(args.carry_from).resolve() == out_path.resolve():
        parser.error("--carry-from names the output file")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)

    written: dict[str, int] = {}
    with out_path.open("w", encoding="utf-8") as handle:
        for code, sample in SOURCES.items():
            budget = getattr(args, code)
            count = 0
            if code in args.carry:
                tuples: Iterator[dict[str, Any]] = carried_tuples(Path(args.carry_from), code)
            else:
                tuples = sample(budget, rng) if budget > 0 else iter(())
            for tup in tuples:
                handle.write(json.dumps(tup, ensure_ascii=False) + "\n")
                count += 1
            written[code] = count

    summary = " + ".join(f"{code.upper()} {count:,}" for code, count in written.items())
    print(f"{out_path}: {summary} tuples")


if __name__ == "__main__":
    main()
