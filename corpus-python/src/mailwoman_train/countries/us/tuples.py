"""The United States: house-venue tuples from the per-state national-situs databases."""

from __future__ import annotations

import random
from collections.abc import Iterator
from typing import Any

from ...corpora.address_points import sample_address_points
from ...paths import data_root_path

#: One database per state, named `address-points-us-<state>.db`. The state code comes off the
#: filename, which is the only place the row carries it.
SITUS_DIR_PARTS = ("address-points",)
SITUS_GLOB = "address-points-us-*.db"


def titlecase(text: str) -> str:
    return " ".join(word.capitalize() for word in text.split())


def iter_tuples(count: int, rng: random.Random) -> Iterator[dict[str, Any]]:
    """Sample across states rather than from one.

    The per-state databases differ by orders of magnitude in size, so an even draw would be
    California with a garnish. The budget is split evenly and the state order is shuffled, so a
    short run is a random subset of states rather than the alphabetical head.
    """
    state_dbs = sorted(data_root_path(*SITUS_DIR_PARTS).glob(SITUS_GLOB))
    if not state_dbs:
        return
    rng.shuffle(state_dbs)
    per_state = max(1, count // len(state_dbs))
    emitted = 0
    for db_path in state_dbs:
        if emitted >= count:
            return
        state = db_path.stem.rsplit("-", 1)[-1].upper()
        for street, number, postcode, locality in sample_address_points(db_path, per_state, rng):
            if emitted >= count:
                return
            yield {
                "locality": titlecase(locality),
                "region": state,
                "postcode": postcode,
                "country": "US",
                "street": titlecase(street),
                "houseNumber": number,
            }
            emitted += 1
