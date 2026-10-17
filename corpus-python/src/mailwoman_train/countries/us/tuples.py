"""The United States: house-venue tuples from the NAD rows of the per-state national-situs databases."""

from __future__ import annotations

import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ...corpora.address_points import sample_address_points
from ...paths import data_root_path

#: One database per state, with path pattern `address-points-us-<state>.db`. The state code comes off the
#: filename. The row stores the state code nowhere else.
SITUS_DIR_PARTS = (
    "db",
    "address-points",
)
SITUS_GLOB = "address-points-us-*.db"

#: The only `source` value whose rows these tuples may carry. The databases also hold
#: `overture:OpenAddresses/<state>/<body>` and `openaddresses` rows: OpenAddresses does not relicense the
#: county and state bodies it collects, and the register holds no per-body decision for them
#: (`us-geodata-aggregate-3` is refused). Every non-NAD row in the databases is one of those, so no
#: Overture row carries a license of its own to admit.
SITUS_SOURCE = "overture:NAD"

#: Probes per requested row. A state whose NAD rows are a few percent of its table (Minnesota holds 52,165
#: NAD rows beside 2.2 million from its Department of Public Safety) needs dozens of probes per kept row.
SITUS_PROBE_BUDGET = 512


def titlecase(text: str) -> str:
    return " ".join(word.capitalize() for word in text.split())


def state_code(db_path: Path) -> str:
    """The state code after `address-points-us-`, ignoring a county suffix such as `il-cook`."""
    return db_path.stem.removeprefix("address-points-us-").split("-", 1)[0].upper()


def iter_tuples(count: int, rng: random.Random) -> Iterator[dict[str, Any]]:
    """Sample across states rather than from one.

    The per-state databases differ by orders of magnitude in size, so an even draw would be
    California with a garnish. The budget is split evenly and the state order is shuffled, so a
    short run is a random subset of states rather than the alphabetical head. A state holding fewer
    NAD rows than its share passes the shortfall to the states after it.
    """
    state_dbs = sorted(data_root_path(*SITUS_DIR_PARTS).glob(SITUS_GLOB))
    if not state_dbs:
        return
    rng.shuffle(state_dbs)
    emitted = 0
    for index, db_path in enumerate(state_dbs):
        if emitted >= count:
            return
        per_state = max(1, -(-(count - emitted) // (len(state_dbs) - index)))
        state = state_code(db_path)
        sampled = sample_address_points(db_path, per_state, rng, source=SITUS_SOURCE, probe_budget=SITUS_PROBE_BUDGET)
        for street, number, postcode, locality in sampled:
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
