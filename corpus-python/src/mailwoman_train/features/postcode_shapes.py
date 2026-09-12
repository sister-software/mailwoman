"""Postcode-SHAPE detection — the train-side port of ``neural/postcode-repair.ts`` (#220/#723).

The postcode anchor is painted at INFERENCE on postcode-SHAPED spans (``neural/postcode-anchor.ts``
runs ``collectMatches`` from ``neural/postcode-repair.ts`` over the raw text — it has no gold). But at
TRAIN the anchor was painted only on GOLD ``B/I-postcode`` spans (``tokenizer.realign_anchor_to_pieces``).
So the model trained with the anchor firing ONLY on real postcodes and NEVER on a house-number-that-
looks-like-a-ZIP ("12345 Main St") — exactly the case it faceplants on at inference (#723). This module
is the train-side mirror of the inference shape detector, so ``anchor_paint_mode="shaped"`` paints the
anchor at TRAIN on the SAME spans inference does → train/inference congruent by construction.

CANONICAL SOURCE: ``neural/postcode-repair.ts`` (``POSTCODE_PATTERNS`` + ``collectMatches``). Keep the
two in lockstep. Do NOT diverge the regexes without changing both.

"Keep the two in lockstep" was the whole enforcement until 2026-08-05, and it did not hold: the IE
Eircode row landed on the TS side on 2026-07-06 and never reached here, so this table ran one row
short for a month and ``anchor_paint_mode="shaped"`` painted nine of the ten shapes inference paints.
``tests/mailwoman_train/test_postcode_shapes.py`` — which this docstring named for a month before the
file existed — now READS the TS source and demands an exact match on label, kind, regex body and
order. A row added on either side and not the other is a red test, not a silent incongruence.
"""

from __future__ import annotations

import re
from typing import NamedTuple

# Per-country postcode shape patterns, ordered most-specific -> least (priority = index; lower wins an
# overlap). Mirrors neural/postcode-repair.ts:POSTCODE_PATTERNS VERBATIM. Alphanumeric patterns require
# UPPERCASE letters (postcodes are conventionally uppercase; keeps them off lowercase prose).
POSTCODE_PATTERNS: list[tuple[str, str, re.Pattern[str]]] = [
    # --- Alphanumeric ---
    ("GB", "alnum", re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b")),  # SW1A 1AA, EH8 9YL
    ("CA", "alnum", re.compile(r"\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b")),  # M5V 2T6 (space optional)
    # IE Eircode: routing key (letter + 2 digits, or the D6W special) + a 4-alnum unique part. Space
    # REQUIRED. No GB collision: a letter+2-digit GB outward always has a 3-char inward (B12 8QX),
    # never 4.
    ("IE", "alnum", re.compile(r"\b(?:[A-Z]\d{2}|D6W)\s+[A-Z\d]{4}\b")),  # D02 AF30, T12 X70A, F91 Y5CY
    ("DE", "alnum", re.compile(r"\bD-\d{5}\b")),  # D-68161
    ("NL", "alnum", re.compile(r"\b\d{4}\s?[A-Z]{2}\b")),  # 1234 AB / 1234AB
    # --- Numeric ---
    ("ZIP4", "numeric", re.compile(r"\b\d{5}-\d{4}\b")),  # US ZIP+4
    ("JP", "numeric", re.compile(r"\b\d{3}-\d{4}\b")),  # 100-0001
    ("PT", "numeric", re.compile(r"\b\d{4}-\d{3}\b")),  # 3060-187
    ("PL", "numeric", re.compile(r"\b\d{2}-\d{3}\b")),  # 47-400
    ("NUM5", "numeric", re.compile(r"\b\d{5}\b")),  # US/FR/DE/ES 5-digit
]


class PostcodeMatch(NamedTuple):
    start: int
    end: int
    kind: str  # "alnum" | "numeric"
    priority: int  # pattern index; lower = more specific


def collect_matches(text: str) -> list[PostcodeMatch]:
    """Collect non-overlapping postcode-shaped substrings, longest-match-wins (then priority).

    Mirrors ``neural/postcode-repair.ts::collectMatches`` EXACTLY: gather every pattern's matches, then
    accept greedily by (length DESC, priority ASC), rejecting anything overlapping an accepted match —
    so a US ZIP+4 ("94610-2737") claims its span before the shorter NL-shaped tail ("2737 CA") can.
    Returned in start order (irrelevant to painting, but deterministic).
    """
    candidates: list[PostcodeMatch] = []
    for priority, (_label, kind, pat) in enumerate(POSTCODE_PATTERNS):
        for m in pat.finditer(text):
            candidates.append(PostcodeMatch(m.start(), m.end(), kind, priority))
    candidates.sort(key=lambda c: (-(c.end - c.start), c.priority))
    accepted: list[PostcodeMatch] = []
    for c in candidates:
        if any(c.start < a.end and a.start < c.end for a in accepted):
            continue
        accepted.append(c)
    return sorted(accepted, key=lambda c: c.start)
