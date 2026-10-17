"""The United States: house-venue tuples from the admitted rows of the per-state national-situs databases."""

from __future__ import annotations

import json
import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ...corpora.address_points import sample_address_points
from ...paths import data_root_path, repo_root_path
from ...source_rights import SourceRights, committed_source_rights

#: One database per state, with path pattern `address-points-us-<state>.db`. The state code comes off the
#: filename. The row stores the state code nowhere else.
SITUS_DIR_PARTS = (
    "db",
    "address-points",
)
SITUS_GLOB = "address-points-us-*.db"

#: Maps each `source` value of the situs databases to the register rows its data comes from: `overture:NAD`
#: to NAD and Overture, and each `overture:OpenAddresses/<state>/<body>` to that body's own row and Overture.
#: OpenAddresses does not relicense what it collects, so a body's rows are admitted on the body's decision.
SITUS_SOURCES_PARTS = ("packages", "corpus", "data", "us-situs-sources.json")

#: Probes per requested row. A state whose admitted rows are a few percent of its table needs dozens of probes
#: per kept row.
SITUS_PROBE_BUDGET = 512


def admitted_situs_sources(rights: SourceRights | None = None, path: Path | None = None) -> frozenset[str]:
    """The `source` values whose every register row holds an elected decision permitting transform and train.

    A value the table does not map, such as the bare `openaddresses` of the Hawaii database, which names no body,
    is not admitted.
    """
    table = json.loads((path or repo_root_path(*SITUS_SOURCES_PARTS)).read_text(encoding="utf-8"))
    rights = rights or committed_source_rights()
    return frozenset(
        source
        for source, register_sources in table["sources"].items()
        if register_sources and all(rights.permits_training(row) for row in register_sources)
    )


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
    admitted rows than its share passes the shortfall to the states after it.
    """
    state_dbs = sorted(data_root_path(*SITUS_DIR_PARTS).glob(SITUS_GLOB))
    if not state_dbs:
        return
    admitted = admitted_situs_sources()
    rng.shuffle(state_dbs)
    emitted = 0
    for index, db_path in enumerate(state_dbs):
        if emitted >= count:
            return
        per_state = max(1, -(-(count - emitted) // (len(state_dbs) - index)))
        state = state_code(db_path)
        sampled = sample_address_points(db_path, per_state, rng, sources=admitted, probe_budget=SITUS_PROBE_BUDGET)
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
