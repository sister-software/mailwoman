"""Postcode-SHAPE detection at TRAIN time, on the spans inference detects.

The postcode anchor is painted at INFERENCE on postcode-SHAPED spans — `@mailwoman/neural`'s postcode
repair runs its shape table over the raw text, because it has no gold. At TRAIN the anchor was
painted only on GOLD ``B/I-postcode`` spans, so the model trained with the anchor firing ONLY on real
postcodes and NEVER on a house-number-that-looks-like-a-ZIP ("12345 Main St") — exactly the case it
faceplants on at inference. This module reads the same table the inference side reads, so
``anchor_paint_mode="shaped"`` paints at TRAIN on the SAME spans, congruent by construction.

THE TABLE IS DATA, NOT CODE. It lives at ``packages/codex/lib/postcode/shapes.json``, and
``postcode-shapes.json`` beside this file is a byte-identical copy of it. Two copies, because a Modal
container receives only ``corpus-python/src`` and cannot read the repository's packages; one AUTHORED
copy, because ``test_postcode_shapes`` fails on any byte of difference.

The arrangement replaces two hand-typed tables, one per language, kept in step by a comment reading
"keep the two in lockstep". That did not hold twice: the IE Eircode row was TypeScript-only for a
month and the BR CEP row for five weeks, and both times this side painted one fewer shape than
inference with nothing failing.

WHAT THIS SIDE READS. Every row except those the record marks ``javascriptOnly``. There is one: the
〒-marked Japanese row, whose ``(?<=〒\\s?)`` is a variable-width lookbehind — legal in JavaScript,
refused by Python's ``re``. The record says so in the row itself, so the omission is a stated
constraint rather than a gap somebody has to rediscover; the tests assert both that the row is
skipped and that every row the record does NOT mark compiles here.
"""

from __future__ import annotations

import json
import re
from typing import NamedTuple

from ..paths import package_path

#: The field a row carries when its pattern is not valid Python, with the reason.
JAVASCRIPT_ONLY = "javascriptOnly"

#: The shared record, beside this file. `package_path` resolves it from the source tree, from an
#: installed package and from the volume's copy alike, so no caller supplies a root.
SHAPES_PATH = package_path("features", "postcode-shapes.json")

_RECORD = json.loads(SHAPES_PATH.read_text(encoding="utf-8"))

#: The record's revision, so a report can say which one it read.
POSTCODE_SHAPES_VERSION: str = _RECORD["version"]

#: Every shape in the record, readable here or not, in priority order — label, kind, pattern source.
ALL_POSTCODE_SHAPES: list[tuple[str, str, str]] = [
    (shape["label"], shape["kind"], shape["pattern"]) for shape in _RECORD["shapes"]
]

#: Labels the record marks as unreadable by Python, with the reason it gives.
UNREADABLE_HERE: dict[str, str] = {
    shape["label"]: shape[JAVASCRIPT_ONLY] for shape in _RECORD["shapes"] if JAVASCRIPT_ONLY in shape
}

#: The shapes this side paints, compiled. Priority is the INDEX, so the order of the record is part
#: of the contract: a lower index wins an overlap, and dropping a row must not reorder the rest.
POSTCODE_PATTERNS: list[tuple[str, str, re.Pattern[str]]] = [
    (label, kind, re.compile(pattern)) for label, kind, pattern in ALL_POSTCODE_SHAPES if label not in UNREADABLE_HERE
]


class PostcodeMatch(NamedTuple):
    start: int
    end: int
    kind: str  # the record's kind: "alnum", "numeric" or "designated"
    priority: int  # pattern index; lower = more specific


def collect_matches(text: str) -> list[PostcodeMatch]:
    """Collect non-overlapping postcode-shaped substrings, longest-match-wins (then priority).

    Mirrors ``@mailwoman/neural``'s ``collectMatches``: gather every pattern's matches, then accept
    greedily by (length DESC, priority ASC), rejecting anything overlapping an accepted match — so a
    US ZIP+4 ("94610-2737") claims its span before the shorter NL-shaped tail ("2737 CA") can.
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
