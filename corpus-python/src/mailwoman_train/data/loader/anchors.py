"""The postcode→anchor lookup reader.

The one channel input this loader reads itself. The other four — gazetteer, country, street type,
locality surface — come from `features/gazetteer_anchor.py` and `features/country_lexicon.py`,
which `encode.py` imports where it needs them.
"""

from __future__ import annotations

import json


def load_anchor_lookup(path: str) -> dict[str, tuple[dict[str, float], float, float]]:
    """Load the postcode→anchor lookup (#239/#240) from JSON, once at loader init.

    Format: ``{normalized_postcode: [posterior_dict, lat, lon, source?]}`` where ``posterior_dict``
    is ``{country: weight}`` (uniform over the countries the code exists in) and the optional 4th
    element is the centroid's provenance label (#525 — e.g. ``"wof"`` / ``"census-zcta-2024"`` /
    ``null``), ignored here. Returns the tuple form ``realign_anchor_to_pieces`` consumes. Built
    offline by ``scripts/build-pilot-anchor-lookup.ts`` so the training loop carries no gazetteer
    dependency.

    MEMORY, measured 2026-08-05 (the loader-init cost a launch has to budget for): the 67,708-key
    pilot lookup lands at 0.05 GB resident / 0.05 GB peak; the 2,286,339-key v2 lookup at 1.32 GB
    resident / 1.37 GB peak, both dominated by ``json.load``'s intermediate rather than by the
    returned dict. Interning the posteriors was tried and REJECTED — 2.2M rows share
    ``{"GB": 1.0}``, but freeing the duplicate dicts returns them to pymalloc's arenas, not to the
    OS, so process RSS was byte-for-byte unchanged (1.32 GB either way). If this ever needs to come
    down, the change is the FORMAT (a binary lookup like ``postcode-<cc>.bin``), not the loader.
    """
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    return {pc: (row[0], float(row[1]), float(row[2])) for pc, row in raw.items()}
