"""The two copies of the authored postcode-shape record — the codex JSON record and the vendored Python copy — must stay byte-identical, because a Modal container receives only `corpus-python/src` and cannot read the repository's packages."""

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

CODEX_RECORD = paths.REPO_ROOT / "packages" / "codex" / "lib" / "postcode" / "shapes.json"


def test_the_vendored_record_is_byte_identical_to_the_authored_one() -> None:
    """A byte compare cannot be defeated by a formatting change that a source-text parser silently stops matching."""
    assert CODEX_RECORD.is_file(), (
        f"the authored record is not at {CODEX_RECORD}; this test reads a path no compiler checks, "
        "so a workspace move breaks it silently"
    )
    assert SHAPES_PATH.read_bytes() == CODEX_RECORD.read_bytes(), (
        f"{SHAPES_PATH} has drifted from {CODEX_RECORD}. The codex copy is the authored one — copy it "
        "here rather than editing this side."
    )


def test_every_row_the_record_does_not_exempt_compiles_under_python() -> None:
    """The record is shared with JavaScript, so a row Python's `re` refuses must declare `javascriptOnly`, or it fails at import inside a Modal container after the GPU is running."""
    for label, _kind, pattern in ALL_POSTCODE_SHAPES:
        if label in UNREADABLE_HERE:
            continue
        try:
            re.compile(pattern)
        except re.error as error:  # noqa: PERF203
            pytest.fail(f"{label}: {pattern!r} is not a Python regex — {error}")


def test_each_exempt_row_really_is_unreadable_here() -> None:
    """The one exemption is the 〒-marked Japanese row: `(?<=〒\\s?)` is a variable-width lookbehind JavaScript accepts and Python refuses, so the refusal is asserted."""
    assert set(UNREADABLE_HERE) == {"JP-marked"}, f"the exempt set changed: {sorted(UNREADABLE_HERE)}"
    for label, _kind, pattern in ALL_POSTCODE_SHAPES:
        if label not in UNREADABLE_HERE:
            continue
        with pytest.raises(re.error):
            re.compile(pattern)
        assert UNREADABLE_HERE[label].strip(), f"{label} is exempt with no reason given"


def test_priority_order_survives_the_filter() -> None:
    """Priority is the index, so dropping a row must not reorder the rest."""
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
    # Space is required, so the glued form is not a match.
    (match,) = collect_matches("Ballinlough, T12 X70A, Cork")
    assert "Ballinlough, T12 X70A, Cork"[match.start : match.end] == "T12 X70A"


def test_br_cep_claims_the_sector_suffix():
    # Without it, NUM5 takes the five-digit head alone.
    (match,) = collect_matches("Rua Ramiro Barcelos, Porto Alegre 95090-020")
    assert "Rua Ramiro Barcelos, Porto Alegre 95090-020"[match.start : match.end] == "95090-020"


def test_zip4_claims_the_span_the_nl_shape_would_take():
    # Longest-match-wins: "94610-2737" beats the NL-shaped tail "2737 CA".
    text = "1234 Broadway, Oakland 94610-2737 CA"
    spans = [text[m.start : m.end] for m in collect_matches(text)]
    assert "94610-2737" in spans
    assert "2737 CA" not in spans
