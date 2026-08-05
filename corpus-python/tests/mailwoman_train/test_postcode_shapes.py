"""Cross-language parity for the postcode-SHAPE table.

``postcode_shapes.py`` says it mirrors ``neural/postcode-repair.ts:POSTCODE_PATTERNS`` VERBATIM, and
its docstring has pointed at "``test_postcode_shapes.py``" as the thing keeping that true since it
was written. That file did not exist. In its absence the two tables drifted: the IE Eircode row was
added on the TS side (2026-07-06, after the diagnostic showed the model fragmenting ``F91 Y5CY`` into
postcode "91") and never reached Python, so ``anchor_paint_mode="shaped"`` painted the train-side
anchor on nine of the ten shapes inference paints — silently train/inference INCONGRUENT for exactly
the locale the row was added for.

The check below is textual on purpose. There is no way to compare a compiled ``re.Pattern`` to a
JavaScript ``RegExp`` semantically from Python, and a hand-maintained list of expected labels would
be a third copy to drift. So it reads the TS source, pulls the ``{ label, kind, re }`` triples out of
the ``POSTCODE_PATTERNS`` literal, and demands an exact match against this side — label, kind, regex
body AND order, since priority is the array index. Every pattern in the table today is character-for-
character identical across the two languages, which is what makes the strict compare affordable; if a
future row genuinely needs different source text in the two dialects, it needs an explicit exemption
here and a note saying why, not a loosened comparison.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from mailwoman_train.postcode_shapes import POSTCODE_PATTERNS, collect_matches

# tests/mailwoman_train/<this file> -> tests/ -> corpus-python/ -> repo root.
CANONICAL_TS = Path(__file__).resolve().parents[3] / "neural" / "postcode-repair.ts"

# Matches one `{ label: "GB", kind: "alnum", re: /…/g }` entry. The body group is non-greedy and stops
# at the first unescaped `/`, which is safe because no pattern in this table contains a literal slash.
TS_ENTRY = re.compile(r'\{\s*label:\s*"([^"]+)",\s*kind:\s*"([^"]+)",\s*re:\s*/(.+?)/g\s*\}')


def _parse_ts_patterns() -> list[tuple[str, str, str]]:
    """Extract (label, kind, regex-source) triples from the TS `POSTCODE_PATTERNS` literal, in order."""
    source = CANONICAL_TS.read_text(encoding="utf-8")
    start = source.index("export const POSTCODE_PATTERNS")
    end = source.index("\n]", start)

    return [(m.group(1), m.group(2), m.group(3)) for m in TS_ENTRY.finditer(source[start:end])]


@pytest.mark.skipif(not CANONICAL_TS.exists(), reason="TS source not present (package installed standalone)")
def test_pattern_table_matches_the_typescript_canonical_source():
    ts = _parse_ts_patterns()
    py = [(label, kind, pattern.pattern) for label, kind, pattern in POSTCODE_PATTERNS]

    # Country sets first — a missing row is the failure this test exists for, and comparing the sets
    # names it directly instead of reporting an off-by-one in a list diff.
    assert {label for label, _, _ in py} == {label for label, _, _ in ts}
    # Then order + kind + regex body, since priority IS the index.
    assert py == ts


@pytest.mark.skipif(not CANONICAL_TS.exists(), reason="TS source not present (package installed standalone)")
def test_the_typescript_table_was_actually_parsed():
    # Guards the guard: if the TS literal is reformatted past what TS_ENTRY matches, `_parse_ts_patterns`
    # returns [] and an unguarded set-compare against an empty list would still need the Python side to
    # be empty — but a future loosening could make the whole check vacuous. Pin the arity instead.
    assert len(_parse_ts_patterns()) == len(POSTCODE_PATTERNS)
    assert len(POSTCODE_PATTERNS) >= 10


def test_ie_eircode_is_detected_as_one_span():
    # The row this parity check was written after. Space is REQUIRED, so the glued form is not a match.
    (match,) = collect_matches("Ballinlough, T12 X70A, Cork")
    assert match.kind == "alnum"
    assert "T12 X70A" == "Ballinlough, T12 X70A, Cork"[match.start : match.end]

    assert collect_matches("Dublin D6W FF00") and collect_matches("Dublin D02 AF30")
    assert not collect_matches("Cork T12X70A")


def test_ie_does_not_steal_a_gb_postcode():
    # A GB letter+2-digit outward always has a 3-char inward, so it cannot satisfy IE's 4-alnum tail.
    (match,) = collect_matches("Birmingham B12 8QX")
    assert "B12 8QX" == "Birmingham B12 8QX"[match.start : match.end]


def test_longest_match_wins_over_a_shorter_overlap():
    # The documented case: a US ZIP+4 claims its span before the NL-shaped tail ("2737 CA") can.
    (match,) = collect_matches("Oakland 94610-2737 CA")
    assert match.kind == "numeric"
    assert "94610-2737" == "Oakland 94610-2737 CA"[match.start : match.end]
