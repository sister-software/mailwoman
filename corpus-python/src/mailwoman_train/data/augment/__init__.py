"""Training-time augmentation: expand abbreviations to teach token equivalence.

Seven augmentations, applied independently with configurable probability:

1. **Directional expansion**: "NW" → "Northwest", "SE" → "Southeast", etc.
   Teaches the model that both abbreviated and expanded directionals are the same
   component, without requiring inference-time normalization.

2. **Region-abbreviation expansion**: "NY" → "New York", "CA" → "California", etc.
   Only US state abbreviations for now. Teaches the model that "NY" and "New York"
   are both B-region, improving locality/region disambiguation.

3. **Ordinal-street swap**: "5th" ↔ "Fifth" on street-family tokens only.

4. **Region+postcode glue** (#513): "NY 14201" → "NY14201" in ``raw`` ONLY — the
   ``tokens`` + ``labels`` lists stay split. ``whitespace_spans`` locates tokens by
   substring search (no whitespace requirement), so the char-offset piece projection
   still lands B-region on the letter pieces and B/I-postcode on the digit pieces of
   the fused surface. Teaches the model to split the fused token at the SP-piece
   level (the v4.3.0 "glue" regression class).

5. **Lowercase**, 6. **punctuation drop**, 7. **all-caps**: whole-row rewrites, each
   length-preserving or span-re-targeting, so the labels survive the rewrite.

The modules:

- `tables.py` — the surface pairs each expansion draws from.
- `splice.py` — editing a row's text and re-targeting its tokens, labels and spans.
- `apply.py` — which augmentations fire for one row, and the DRAW ORDER that decides it.
"""

from __future__ import annotations

from .apply import augment_row
from .splice import (
    DROP_PUNCT,
    SPAN_KEYS,
    drop_separator_punct,
    glue_region_postcode,
    lowercase_row,
    row_span_triple,
    splice_expansion,
    upper_case_row,
)
from .tables import DIRECTIONALS, ORDINAL_STREETS, US_STATES

__all__ = [
    "DIRECTIONALS",
    "DROP_PUNCT",
    "ORDINAL_STREETS",
    "SPAN_KEYS",
    "US_STATES",
    "augment_row",
    "drop_separator_punct",
    "glue_region_postcode",
    "lowercase_row",
    "row_span_triple",
    "splice_expansion",
    "upper_case_row",
]
