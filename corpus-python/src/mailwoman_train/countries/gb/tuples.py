"""Great Britain: house-venue tuples derived from the Price Paid Data."""

from __future__ import annotations

import csv
import random
import re
from collections.abc import Iterator
from typing import Any

from ...paths import data_root_path

TUPLES_CSV_PARTS = ("ppd", "2026-07-22", "gb-tuples.csv")

#: Plain or letter-suffixed house numbers (`9`, `45A`). Range generation belongs to the
#: synthesizer, so a range in the source is skipped rather than carried through.
NUMBER_PATTERN = re.compile(r"^\d+[A-Za-z]?$")


def iter_tuples(count: int, rng: random.Random) -> Iterator[dict[str, Any]]:
    """Reservoir-sample the derived CSV in one streaming pass.

    The file is 25.7M rows, so it is read once and never held in memory. `region` is carried
    because the recipe guard requires the field, and never rendered: a GB address tail is
    `locality postcode`.
    """
    reservoir: list[dict[str, Any]] = []
    seen = 0
    with data_root_path(*TUPLES_CSV_PARTS).open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            number = (row.get("NUMBER") or "").strip()
            street = (row.get("STREET") or "").strip()
            locality = (row.get("CITY") or "").strip() or (row.get("DISTRICT") or "").strip()
            postcode = (row.get("POSTCODE") or "").strip()
            if not (number and street and locality and postcode) or not NUMBER_PATTERN.match(number):
                continue
            tup = {
                "locality": locality,
                "region": (row.get("REGION") or "").strip(),
                "postcode": postcode,
                "country": "GB",
                "street": street,
                "houseNumber": number,
            }
            seen += 1
            if len(reservoir) < count:
                reservoir.append(tup)
            else:
                index = rng.randrange(seen)
                if index < count:
                    reservoir[index] = tup
    rng.shuffle(reservoir)
    yield from reservoir
