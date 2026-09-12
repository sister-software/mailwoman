"""One authored postcode-shape table, read by both runtimes.

The table used to be typed twice — once in `@mailwoman/neural`'s postcode repair, once in
`features/postcode_shapes.py` — under a comment reading "keep the two in lockstep". It did not hold.
The IE Eircode row was TypeScript-only for a month and the BR CEP row for five weeks, and each time
the trainer painted one fewer shape than inference with nothing failing. A textual parity test was
added after the first drift and found the second, which is better than a comment and still after
the fact.

Now `@mailwoman/codex/postcode-shapes.json` is the authored record and the copy beside
`postcode_shapes.py` is byte-identical to it. There are still two files, because a Modal container
receives only `corpus-python/src` and cannot read the repository's packages — but only one of them
is written by hand, and the check below is `==` on bytes rather than a regex over source text.

That is the difference worth keeping: the old test parsed the TypeScript with a regex that required
`re: /…/g`, so the JP-marked row's `/gu` never matched and the check silently compared 11 of 12 rows.
A byte compare has no such blind spot.
"""

from __future__ import annotations

import json
import re

import pytest

from mailwoman_train.features.postcode_shapes import (
    ALL_POSTCODE_SHAPES,
    POSTCODE_PATTERNS,
    POSTCODE_SHAPES_VERSION,
    SHAPES_PATH,
    UNREADABLE_HERE,
    collect_matches,
)
from tests import paths

CODEX_RECORD = paths.REPO_ROOT / "packages" / "codex" / "lib" / "postcode-shapes.json"


def test_the_vendored_record_is_byte_identical_to_the_authored_one() -> None:
    """The one check the split into two files needs.

    Not a parse-and-compare: a byte compare cannot be defeated by a formatting change that the
    parser silently stops matching, which is how the previous check came to read 11 of 12 rows.
    """
    assert CODEX_RECORD.is_file(), (
        f"the authored record is not at {CODEX_RECORD}; this test reads a path no compiler checks, "
        "so a workspace move breaks it silently"
    )
    assert SHAPES_PATH.read_bytes() == CODEX_RECORD.read_bytes(), (
        f"{SHAPES_PATH} has drifted from {CODEX_RECORD}. The codex copy is the authored one — copy it "
        "here rather than editing this side."
    )


def test_every_row_the_record_does_not_exempt_compiles_under_python() -> None:
    """The record is shared with JavaScript, so a row could carry a body Python's `re` refuses.

    That failure would otherwise arrive at import time inside a Modal container, after the corpus is
    staged and the GPU is running. A row that genuinely cannot be written in both dialects declares
    `javascriptOnly` with its reason; anything else must compile here.
    """
    for label, _kind, pattern in ALL_POSTCODE_SHAPES:
        if label in UNREADABLE_HERE:
            continue
        try:
            re.compile(pattern)
        except re.error as error:  # noqa: PERF203
            pytest.fail(f"{label}: {pattern!r} is not a Python regex — {error}")


def test_each_exempt_row_really_is_unreadable_here() -> None:
    """An exemption that stops being necessary is a row this side should be reading.

    The one entry today is the 〒-marked Japanese row: `(?<=〒\\s?)` is a variable-width lookbehind,
    which JavaScript accepts and Python refuses. Asserting the refusal keeps the exemption honest —
    a stale one would silently cost a shape.
    """
    assert set(UNREADABLE_HERE) == {"JP-marked"}, f"the exempt set changed: {sorted(UNREADABLE_HERE)}"
    for label, _kind, pattern in ALL_POSTCODE_SHAPES:
        if label not in UNREADABLE_HERE:
            continue
        with pytest.raises(re.error):
            re.compile(pattern)
        assert UNREADABLE_HERE[label].strip(), f"{label} is exempt with no reason given"


def test_priority_order_survives_the_filter() -> None:
    """Priority IS the index, so dropping a row must not reorder the rest."""
    readable = [label for label, _, _ in ALL_POSTCODE_SHAPES if label not in UNREADABLE_HERE]
    assert [label for label, _, _ in POSTCODE_PATTERNS] == readable
    # NUM5 is the catch-all and must stay last, or it claims spans the specific rows exist for.
    assert POSTCODE_PATTERNS[-1][0] == "NUM5"


def test_the_table_is_the_size_the_record_declares() -> None:
    """Guards the guard: a loader that silently returned [] would pass every comparison above."""
    record = json.loads(CODEX_RECORD.read_text(encoding="utf-8"))
    assert POSTCODE_SHAPES_VERSION == record["version"]
    assert len(ALL_POSTCODE_SHAPES) == len(record["shapes"]) >= 12
    assert len(POSTCODE_PATTERNS) == len(ALL_POSTCODE_SHAPES) - len(UNREADABLE_HERE)


def test_ie_eircode_is_detected_as_one_span():
    # The row the first drift was found on. Space is REQUIRED, so the glued form is not a match.
    (match,) = collect_matches("Ballinlough, T12 X70A, Cork")
    assert "Ballinlough, T12 X70A, Cork"[match.start : match.end] == "T12 X70A"


def test_br_cep_claims_the_sector_suffix():
    # The row the second drift was found on: without it NUM5 takes the five-digit head alone.
    (match,) = collect_matches("Rua Ramiro Barcelos, Porto Alegre 95090-020")
    assert "Rua Ramiro Barcelos, Porto Alegre 95090-020"[match.start : match.end] == "95090-020"


def test_zip4_claims_the_span_the_nl_shape_would_take():
    # Longest-match-wins: "94610-2737" beats the NL-shaped tail "2737 CA".
    text = "1234 Broadway, Oakland 94610-2737 CA"
    spans = [text[m.start : m.end] for m in collect_matches(text)]
    assert "94610-2737" in spans
    assert "2737 CA" not in spans
