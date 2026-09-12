"""France: house-venue tuples from the BAN national address register."""

from __future__ import annotations

import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ...corpora.address_points import sample_address_points
from ...paths import data_root_path

#: Resolved when needed, not at import, so `--help` runs with no data root configured.
BAN_DB_PARTS = ("ban", "address-points-fr.db")

#: Particles that stay lower case inside a French name unless they open it — `Rue de la Paix`, not
#: `Rue De La Paix`. A title-caser without this list renders a surface no French source writes.
PARTICLES = frozenset("de la du des le les l d au aux et sur sous en un une".split())


def titlecase(text: str) -> str:
    """French title case: particles stay down, elisions capitalize after the apostrophe."""
    words = text.split()
    out = []
    for index, word in enumerate(words):
        if index > 0 and word in PARTICLES:
            out.append(word)
        elif "'" in word:
            head, _, tail = word.partition("'")
            out.append(head.lower() + "'" + tail.capitalize())
        elif "-" in word:
            out.append("-".join(part.capitalize() for part in word.split("-")))
        else:
            out.append(word.capitalize())
    return " ".join(out)


def iter_tuples(count: int, rng: random.Random, *, reserved: frozenset[str]) -> Iterator[dict[str, Any]]:
    """Sample BAN rows and render them.

    `region` is carried empty: the FR rendering has no region, and the tuple field is required by
    the recipe guard. `reserved` names street surfaces held out for an eval fixture, skipped here so
    the board and the training corpus stay disjoint.
    """
    for street, number, postcode, locality in sample_address_points(data_root_path(*BAN_DB_PARTS), count, rng):
        if street in reserved:
            continue
        yield {
            "locality": titlecase(locality),
            "region": "",
            "postcode": postcode,
            "country": "FR",
            "street": titlecase(street),
            "houseNumber": number,
        }


def reserved_surfaces(path: Path) -> frozenset[str]:
    """The held-out street surfaces, or an empty set when the fixture is absent."""
    if not path.exists():
        return frozenset()
    return frozenset(line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
