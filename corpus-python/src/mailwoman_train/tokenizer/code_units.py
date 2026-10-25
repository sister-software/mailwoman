"""The code-unit channel: per-piece shape features for each digit run or alphanumeric code (#2845).

A code unit is a run of ASCII letters and digits that holds a digit, with a hyphen kept between two digits
(`10118-0110`, `SW1A`, `1-9-1`). The segmentation is `segmentCodeUnits` in `@mailwoman/mtf/code-units`, and the features
are `codeUnitFeatures` in `@mailwoman/neural/code-unit-features`, which the inference feed computes.
`test/fixtures/code-unit-parity.json` holds the two equal.

A piece overlapping a unit carries five features of the unit, with confidence 1:

1. 1.0, marking the piece as part of a unit;
2. the unit's length, capped at `CODE_UNIT_MAX_LENGTH` and divided by it;
3. the share of the unit's characters that are ASCII letters;
4. 1.0 when the unit holds a hyphen;
5. the number of countries whose postcode syntax accepts the unit, capped at `CODE_UNIT_MAX_ACCEPTING` and divided
   by it.

A piece outside every unit carries zeros with confidence 0. A word-piece vocabulary splits `10118` as `▁10`+`118`
and `SW1A` as `▁SW`+`1A`, so every piece of one code shares the code's whole shape.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from functools import cache

from ..paths import package_path

CODE_UNIT = re.compile(r"(?<![A-Za-z0-9])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]+(?:-(?=\d)[A-Za-z0-9]+)*(?![A-Za-z0-9])")

CODE_UNIT_FEATURE_DIM = 5
CODE_UNIT_MAX_LENGTH = 12
CODE_UNIT_MAX_ACCEPTING = 32


@cache
def postcode_syntax() -> tuple[tuple[re.Pattern[str], str | None], ...]:
    """Each country's compiled postcode pattern and printed prefix, from `data/postcode-syntax.json`."""
    document = json.loads(package_path("data", "postcode-syntax.json").read_text(encoding="utf-8"))
    return tuple(
        (re.compile(entry["pattern"], re.IGNORECASE), entry["prefix"])
        for _, entry in sorted(document["countries"].items())
    )


def accepting_countries(value: str) -> int:
    """How many countries' postcode syntax accepts `value`, as `countriesAcceptingPostcode` counts them."""
    trimmed = value.strip()
    count = 0
    for pattern, prefix in postcode_syntax():
        candidate = trimmed
        if prefix and candidate.upper().startswith(prefix):
            candidate = candidate[len(prefix) :].strip()
        if pattern.search(candidate):
            count += 1
    return count


def segment_code_units(text: str) -> list[tuple[int, int]]:
    """The `(start, end)` offsets of every code unit in `text`, left to right."""
    return [(match.start(), match.end()) for match in CODE_UNIT.finditer(text)]


def unit_features(unit: str) -> list[float]:
    letters = sum(1 for character in unit if character.isascii() and character.isalpha())
    return [
        1.0,
        min(len(unit), CODE_UNIT_MAX_LENGTH) / CODE_UNIT_MAX_LENGTH,
        letters / len(unit),
        1.0 if "-" in unit else 0.0,
        min(accepting_countries(unit), CODE_UNIT_MAX_ACCEPTING) / CODE_UNIT_MAX_ACCEPTING,
    ]


def code_unit_features(text: str, piece_spans: Sequence[tuple[int, int]]) -> tuple[list[list[float]], list[float]]:
    """Per-piece features and confidences, one row per piece span."""
    units = segment_code_units(text)
    features: list[list[float]] = []
    confidence: list[float] = []
    for piece_start, piece_end in piece_spans:
        unit = next(((s, e) for s, e in units if piece_start < e and s < piece_end), None)
        if unit is None:
            features.append([0.0] * CODE_UNIT_FEATURE_DIM)
            confidence.append(0.0)
        else:
            features.append(unit_features(text[unit[0] : unit[1]]))
            confidence.append(1.0)
    return features, confidence
