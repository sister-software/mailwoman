"""The training encoder's code-unit channel equals the inference feed's on the shared fixture (#2845).

Each case runs through `mailwoman_mtf.RowEncoder` with the fixture's piece ranges, so the segmentation, the postcode
syntax's acceptance counts and the painter are all exercised against expectations the fixture supplies.
"""

from __future__ import annotations

import json

import mailwoman_mtf
import pytest

from mailwoman_train.data.loader.encode import POSTCODE_SYNTAX, row_encoder
from mailwoman_train.paths import repo_root_path

CASES = json.loads(repo_root_path("test", "fixtures", "code-unit-parity.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[case["text"] for case in CASES])
def test_features_match_the_typescript_feed(case: dict) -> None:
    encoder = row_encoder(None, max_length=len(case["spans"]), pad_id=0, code_units=True)
    pieces = [[(0, begin, end) for begin, end in case["spans"]]]
    batch = encoder.encode_batch([{"raw": case["text"], "tokens": [], "labels": []}], pieces=pieces)

    assert batch["code_unit_confidence"][0].tolist() == case["confidence"]
    for row, expected in zip(batch["code_unit_features"][0].tolist(), case["features"], strict=True):
        assert row == pytest.approx(expected)


def test_a_country_specific_shape_is_accepted_by_few_countries_and_a_bare_five_digits_by_many() -> None:
    syntax = mailwoman_mtf.PostcodeSyntax(str(POSTCODE_SYNTAX))
    # Bermuda's syntax accepts a two-letter, digit, letter outcode.
    assert syntax.accepting("SW1A") == 1
    assert syntax.accepting("10118-0110") == 1
    assert syntax.accepting("28013") > 20


def test_segmentation_keeps_a_hyphen_only_between_digits() -> None:
    text = "350 5th Ave, NY 10118-0110, AB-C1"
    assert [text[s:e] for s, e in mailwoman_mtf.segment_code_units(text)] == ["350", "5th", "10118-0110", "AB", "C1"]
