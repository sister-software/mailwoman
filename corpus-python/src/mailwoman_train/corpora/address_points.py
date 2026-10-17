"""This module samples an `address_point` table from any country's database.

FR's BAN extract and each US state's situs database share this schema, so the sampler is shared and
the country modules supply the path and the rendering.
"""

from __future__ import annotations

import random
import sqlite3
from pathlib import Path

#: A row as the table stores it: street, number, postcode, locality.
AddressPoint = tuple[str, str, str, str]

#: Probes per requested row before giving up. A rowid range is sparse after deletes, so some probes
#: miss. without a ceiling a small table with a large MAX(rowid) spins.
PROBE_BUDGET = 8


def sample_address_points(
    path: Path,
    count: int,
    rng: random.Random,
    *,
    source: str | None = None,
    probe_budget: int = PROBE_BUDGET,
) -> list[AddressPoint]:
    """Sample by random rowid probe.

    `ORDER BY RANDOM()` scans the whole table. These tables are large enough that a scan costs
    more time than drawing the sample by rowid probe. A row missing any of the four fields is skipped rather than
    emitted partially filled.

    `source` keeps only rows whose `source` column equals it. A probe that lands on another source's row
    counts against `probe_budget`, so a caller filtering to a minority source raises the budget.
    """
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        (max_rowid,) = db.execute("SELECT MAX(rowid) FROM address_point").fetchone()
        if not max_rowid:
            return []
        rows: list[AddressPoint] = []
        seen: set[int] = set()
        attempts = 0
        while len(rows) < count and attempts < count * probe_budget:
            attempts += 1
            rowid = rng.randrange(1, max_rowid + 1)
            if rowid in seen:
                continue
            seen.add(rowid)
            row = db.execute(
                "SELECT street_norm, number, postcode, locality_norm, source FROM address_point WHERE rowid = ?",
                (rowid,),
            ).fetchone()
            if row is None:
                continue
            street, number, postcode, locality, row_source = row
            if source is not None and row_source != source:
                continue
            if street and number and postcode and locality:
                rows.append((street, number, postcode, locality))
        return rows
    finally:
        db.close()
