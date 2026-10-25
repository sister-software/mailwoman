"""The training-side code-unit features equal the inference feed's on the shared fixture (#2845)."""

from __future__ import annotations

import json

import pytest

from mailwoman_train.paths import repo_root_path
from mailwoman_train.tokenizer.code_units import accepting_countries, code_unit_features

CASES = json.loads(repo_root_path("test", "fixtures", "code-unit-parity.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[case["text"] for case in CASES])
def test_features_match_the_typescript_feed(case: dict) -> None:
    features, confidence = code_unit_features(case["text"], [tuple(span) for span in case["spans"]])

    assert confidence == case["confidence"]
    assert len(features) == len(case["features"])
    for row, expected in zip(features, case["features"], strict=True):
        assert row == pytest.approx(expected)


def test_a_country_specific_shape_is_accepted_by_few_countries_and_a_bare_five_digits_by_many() -> None:
    # Bermuda's syntax accepts a two-letter, digit, letter outcode.
    assert accepting_countries("SW1A") == 1
    assert accepting_countries("10118-0110") == 1
    assert accepting_countries("28013") > 20
