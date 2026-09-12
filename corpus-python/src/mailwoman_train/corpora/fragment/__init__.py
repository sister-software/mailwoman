"""The fragment/autocomplete slice, synthesized from real address parts.

Three modules, in the order the builder uses them:

- `sources.py` — harvesting real surfaces from OpenAddresses CSVs and from a corpus's spans.
- `rows.py` — turning one surface into a labeled row, with char offsets over the rendered text.
- `build.py` — the CLI that assembles the slice and cuts the 10% holdout.

`python -m mailwoman_train.corpora.fragment` runs `__main__.py`, which carries the usage line.
"""

from __future__ import annotations

from .build import main
from .rows import (
    COUNTRY_NAMES,
    COUNTRY_SURFACES,
    render,
    render_admin_pair,
    render_context,
    render_country_context,
    render_country_leading,
    render_locality_postcode,
    render_unit,
)
from .sources import (
    OA_LOCALES,
    PER_LOCALE_CAP,
    SEED,
    admin_pairs_from_corpus,
    collect_oa_pairs,
    span_rows_from_corpus,
)

__all__ = [
    "COUNTRY_NAMES",
    "COUNTRY_SURFACES",
    "OA_LOCALES",
    "PER_LOCALE_CAP",
    "SEED",
    "admin_pairs_from_corpus",
    "collect_oa_pairs",
    "main",
    "render",
    "render_admin_pair",
    "render_context",
    "render_country_context",
    "render_country_leading",
    "render_locality_postcode",
    "render_unit",
    "span_rows_from_corpus",
]
