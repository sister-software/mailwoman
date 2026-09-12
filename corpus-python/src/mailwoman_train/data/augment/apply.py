"""Deciding which augmentations fire for one row, and in what order.

The ORDER of the draws below is a contract. Every knob left at 0 is guarded by `prob > 0` before
the draw, so a recipe that does not use an augmentation consumes no randomness for it and its
stream stays bit-identical to the recipes written before that knob existed. Moving a draw, or
dropping a guard, re-shuffles every corpus a seeded run reads.
"""

from __future__ import annotations

import random
from collections.abc import Iterator
from typing import Any

from .splice import drop_separator_punct, glue_region_postcode, lowercase_row, splice_expansion, upper_case_row
from .tables import _STREET_FAMILY_LABELS, DIRECTIONALS, ORDINAL_STREETS, US_STATES


def augment_row(
    row: dict[str, Any],
    rng: random.Random,
    directional_prob: float = 0.3,
    region_prob: float = 0.3,
    glue_prob: float = 0.0,
    case_prob: float = 0.0,
    punct_drop_prob: float = 0.0,
    upper_case_prob: float = 0.0,
    ordinal_prob: float = 0.0,
) -> Iterator[dict[str, Any]]:
    """Yield the original row, then optionally an augmented copy.

    Each augmentation fires independently with its configured probability. When an
    augmentation fires, a COPY of the row is yielded with the expansion applied.
    The original row is always yielded first, unchanged.
    """
    yield row

    tokens: list[str] = row["tokens"]
    labels: list[str] = row["labels"]

    # Directional expansion: find directional tokens and expand one.
    if rng.random() < directional_prob:
        directional_indices = [i for i, t in enumerate(tokens) if t in DIRECTIONALS]
        if directional_indices:
            idx = rng.choice(directional_indices)
            yield splice_expansion(row, idx, DIRECTIONALS[tokens[idx]])

    # Ordinal-street swap ("5th" ↔ "Fifth"): street-family labels only. The prob guard keeps the
    # rng stream bit-identical for configs that leave the knob at 0 (every recipe before v3.24).
    if ordinal_prob > 0 and rng.random() < ordinal_prob:
        ordinal_indices = [
            i
            for i, (t, lab) in enumerate(zip(tokens, labels, strict=True))
            if t in ORDINAL_STREETS and lab in _STREET_FAMILY_LABELS
        ]
        if ordinal_indices:
            idx = rng.choice(ordinal_indices)
            yield splice_expansion(row, idx, ORDINAL_STREETS[tokens[idx]])

    # Region+postcode glue (#513): fuse the last region token with an immediately-following
    # postcode token in raw. Letter→digit boundary only — that's the boundary SentencePiece
    # is guaranteed to split (the eval's glue class); letter→letter fusions (e.g. GB outcodes)
    # could yield a piece straddling the label boundary, which the char projection cannot
    # represent (first-char label wins). The prob guard keeps the rng stream bit-identical
    # for configs that leave the knob at 0.
    if glue_prob > 0 and rng.random() < glue_prob:
        glue_indices = [
            i
            for i in range(len(tokens) - 1)
            if labels[i] in ("B-region", "I-region")
            and labels[i + 1] == "B-postcode"
            and tokens[i][-1:].isalpha()
            and tokens[i + 1][:1].isdigit()
        ]
        if glue_indices:
            yield glue_region_postcode(row, rng.choice(glue_indices))

    # Region-abbreviation expansion: find region-labeled abbreviations and expand one.
    if rng.random() < region_prob:
        region_indices = [
            i
            for i, (t, lab) in enumerate(zip(tokens, labels, strict=True))
            if t in US_STATES and lab in ("B-region", "I-region")
        ]
        if region_indices:
            idx = rng.choice(region_indices)
            yield splice_expansion(row, idx, US_STATES[tokens[idx]])

    # Case augmentation (#829): a lowercased copy, length-preserving so spans/labels pass through.
    # The prob guard keeps the rng stream bit-identical for configs that leave the knob at 0.
    if case_prob > 0 and rng.random() < case_prob:
        lowered = lowercase_row(row)
        if lowered is not None:
            yield lowered

    # Punct-drop augmentation (#1101): a delimiter-free / whitespace-only copy (separator commas +
    # quotes stripped). The prob guard keeps the rng stream bit-identical for configs at 0.
    if punct_drop_prob > 0 and rng.random() < punct_drop_prob:
        dropped = drop_separator_punct(row)
        if dropped is not None:
            yield dropped

    # All-caps augmentation (#690 retirement path): an upper-cased copy so the model learns registry
    # casing natively. Same prob-guard discipline as punct-drop (rng stream bit-identical at 0).
    if upper_case_prob > 0 and rng.random() < upper_case_prob:
        uppered = upper_case_row(row)
        if uppered is not None:
            yield uppered
